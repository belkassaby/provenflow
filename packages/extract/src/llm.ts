/**
 * Optional LLM assistance, never trusted on its own word:
 *
 *  - computed writes (`status.set(next)`): the LLM says which values they
 *    can write; an answer is kept only if it cites a write the parser found
 *    and uses values of the variable's type;
 *  - properties: the LLM suggests requirements (from names, comments and
 *    transitions); a suggestion is kept only if it parses, and nuXmv decides
 *    whether the code satisfies it;
 *  - fixes: the LLM proposes edits for a finding; a fix is marked verified
 *    only if re-running the whole analysis on the edited files removes the
 *    finding without adding new ones.
 *
 * Answers are cached by the hash of the prompt, so a run is reproducible and
 * a second run costs nothing.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiagram, serializeDiagram } from '@provenflow/language';
import { formatLocation, type Facts, type StateWriteFact } from './ir.js';
import type { ExtractedModel, Finding } from './models.js';
import { verifyProposals, type Baseline, type BuildCheck, type Edit, type Proposal, type Rerun } from './fixes.js';

export type { Edit, Rerun } from './fixes.js';

export { logged, metered, providerFromSpec } from './llm-providers.js';
export type { LlmEvent, LlmProvider, LlmUsage } from './llm-types.js';
import type { LlmEvent, LlmProvider } from './llm-types.js';

/** Caches answers on disk by the hash of provider, system prompt and user prompt. */
export function cachedProvider(provider: LlmProvider, dir: string): LlmProvider {
    return {
        name: provider.name,
        async complete(system, user, onEvent?: (e: LlmEvent) => void) {
            const key = createHash('sha256').update(`${provider.name}\n${system}\n${user}`).digest('hex');
            const file = join(dir, `${key}.json`);
            if (existsSync(file)) {
                onEvent?.({ type: 'note', text: 'cached answer (asked before with the same code): no tokens used' });
                return (JSON.parse(readFileSync(file, 'utf8')) as { answer: string }).answer;
            }
            const answer = await provider.complete(system, user, onEvent);
            mkdirSync(dir, { recursive: true });
            writeFileSync(file, JSON.stringify({ provider: provider.name, answer }, null, 2));
            return answer;
        }
    };
}

const SYSTEM = 'You analyse source code for a model checker. Answer with JSON only, no prose, exactly in the requested shape. Only state what the code shows; cite file and line for every claim.';

function jsonIn(answer: string): unknown {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
    const text = fenced ? fenced[1] : answer.slice(answer.search(/[[{]/));
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function excerpt(root: string, file: string, line: number, radius: number): string {
    try {
        const lines = readFileSync(join(root, file), 'utf8').split('\n');
        const from = Math.max(0, line - 1 - radius);
        return lines
            .slice(from, line + radius)
            .map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`)
            .join('\n');
    } catch {
        return '';
    }
}

// ------------------------------------------------------------ computed writes

export interface LlmLog {
    accepted: string[];
    rejected: string[];
}

/** The writes of `facts`, with the computed ones the LLM resolved (and the parser confirmed) filled in. */
export async function resolveDynamicWrites(facts: Facts, provider: LlmProvider): Promise<{ writes: StateWriteFact[]; log: LlmLog }> {
    const log: LlmLog = { accepted: [], rejected: [] };
    const resolved = new Map<StateWriteFact, StateWriteFact>();
    const byVariable = new Map<string, StateWriteFact[]>();
    for (const w of facts.writes.filter(w => w.targets === null || w.incomplete)) byVariable.set(w.variable, [...(byVariable.get(w.variable) ?? []), w]);
    for (const [variable, writes] of byVariable) {
        const v = facts.stateVariables.find(x => x.id === variable);
        if (!v) continue;
        const user = [
            `State variable ${v.name} (${formatLocation(v.loc)}) takes the values: ${v.values.join(', ')}.`,
            'These writes assign it a computed value. For each, list the values it can actually write and, if the code restricts it, the values the variable has just before.',
            'Answer: {"writes": [{"file": "...", "line": 0, "targets": ["..."], "sources": ["..."] or null, "reason": "..."}]}',
            ...writes.map(w => `\n--- ${formatLocation(w.loc)} in ${w.event}\n${excerpt(facts.root, w.loc.file, w.loc.line, 25)}`)
        ].join('\n');
        const answer = jsonIn(await provider.complete(SYSTEM, user)) as { writes?: Array<{ file: string; line: number; targets: string[]; sources: string[] | null; reason?: string }> } | undefined;
        for (const proposal of answer?.writes ?? []) {
            const write = writes.find(w => w.loc.file === proposal.file && w.loc.line === proposal.line);
            const valid = (xs: unknown) => Array.isArray(xs) && xs.length > 0 && xs.every(x => typeof x === 'string' && v.values.includes(x));
            if (!write) {
                log.rejected.push(`${v.name}: ${proposal.file}:${proposal.line} is not a write the parser found`);
                continue;
            }
            if (!valid(proposal.targets) || (proposal.sources !== null && proposal.sources !== undefined && !valid(proposal.sources))) {
                log.rejected.push(`${v.name} at ${formatLocation(write.loc)}: values outside ${v.values.join('|')}`);
                continue;
            }
            resolved.set(write, { ...write, targets: [...new Set([...(write.targets ?? []), ...proposal.targets])], sources: proposal.sources ?? write.sources, incomplete: undefined, event: `${write.event} [llm]` });
            log.accepted.push(`${v.name} at ${formatLocation(write.loc)} writes ${proposal.targets.join('/')}${proposal.reason ? `: ${proposal.reason}` : ''}`);
        }
    }
    return { writes: facts.writes.map(w => resolved.get(w) ?? w), log };
}

// ----------------------------------------------------------------- properties

/** The models, with the requirements the LLM suggested (and that parse) added as properties for nuXmv to check. */
export async function suggestProperties(models: ExtractedModel[], root: string, provider: LlmProvider, limit = 10): Promise<{ models: ExtractedModel[]; log: LlmLog }> {
    const log: LlmLog = { accepted: [], rejected: [] };
    const extended = new Map<ExtractedModel, ExtractedModel>();
    for (const original of models.filter(x => x.kind === 'state-machine').slice(0, limit)) {
        const m: ExtractedModel = { ...original, model: { ...original.model, specs: [...original.model.specs] }, origins: { ...original.origins } };
        extended.set(original, m);
        const transitions = m.model.transitions.map(t => `${m.values[t.source] ?? t.source} -> ${m.values[t.target] ?? t.target}: ${(m.evidence[`${t.source}->${t.target}`] ?? []).map(e => `${e.event}${e.loc ? ` (${formatLocation(e.loc)})` : ''}`).join('; ')}`);
        const user = [
            `State machine of ${m.subject}${m.loc ? ` (declared at ${formatLocation(m.loc)})` : ''}. States (nuXmv ids): ${m.model.states.map(s => s.name).join(', ')}.`,
            `Transitions found in the code:\n${transitions.join('\n')}`,
            m.loc ? `Declaration:\n${excerpt(root, m.loc.file, m.loc.line, 12)}` : '',
            'Suggest up to 3 requirements the code is meant to satisfy (ordering, "never X after Y", "Z eventually follows W"), as nuXmv LTL or CTL over `state = <id>` only.',
            'Answer: {"properties": [{"name": "snake_case", "kind": "LTLSPEC" | "CTLSPEC", "expression": "...", "rationale": "..."}]}'
        ].join('\n\n');
        const answer = jsonIn(await provider.complete(SYSTEM, user)) as { properties?: Array<{ name: string; kind: string; expression: string; rationale?: string }> } | undefined;
        for (const p of answer?.properties ?? []) {
            if (!['LTLSPEC', 'CTLSPEC'].includes(p.kind) || typeof p.expression !== 'string') continue;
            const name = `llm_${String(p.name).replace(/\W/g, '_')}`.slice(0, 40);
            const candidate = { ...m.model, specs: [...m.model.specs, { kind: p.kind as 'LTLSPEC' | 'CTLSPEC', name, expression: p.expression }] };
            const parsed = await parseDiagram(serializeDiagram(candidate));
            if (parsed.diagnostics.some(d => d.severity === 'error')) {
                log.rejected.push(`${m.subject}: property '${p.expression}' does not parse`);
                continue;
            }
            m.model.specs.push({ kind: p.kind as 'LTLSPEC' | 'CTLSPEC', name, expression: p.expression });
            m.origins[name] = {
                rule: 'suggested-property-violated',
                category: m.kind === 'state-machine' ? 'state-machine' : 'lifecycle',
                severity: 'warning',
                message: `${m.subject} violates a requirement suggested by ${provider.name}: ${p.rationale ?? p.expression}`,
                fix: 'Check whether the requirement is intended. If it is, change the transition the counterexample points to; if not, ignore it.',
                loc: m.loc
            };
            log.accepted.push(`${m.subject}: ${p.kind} ${p.expression}`);
        }
    }
    return { models: models.map(m => extended.get(m) ?? m), log };
}

// ----------------------------------------------------------------------- fixes

/**
 * One finding, fixed by the LLM from its suggested fix: the whole file when it is not too long
 * (otherwise the code around the finding), the counterexample and the related places. The answer
 * is exact search/replace edits, which the caller turns into a diff and verifies.
 */
export async function proposeFixFor(f: Finding, root: string, provider: LlmProvider, onEvent?: (e: LlmEvent) => void): Promise<Proposal | undefined> {
    if (!f.loc) return undefined;
    const whole = readFileText(root, f.loc.file);
    const numbered = (text: string) => text.split('\n').map((l, i) => `${String(i + 1).padStart(5)}| ${l}`).join('\n');
    const others = [...new Set((f.related ?? []).map(r => r.file).filter(file => file !== f.loc!.file))].slice(0, 2);
    const user = [
        `Finding (${f.rule}, ${f.severity}) about ${f.subject}, at ${f.loc.file}:${f.loc.line}:`,
        f.message,
        `Suggested fix: ${f.fix}`,
        ...(f.counterexample && f.counterexample.length > 1 ? [`How it goes wrong (counterexample, as calls in the code):\n${f.counterexample.map((c, i) => `${i}. ${c.event ? `${c.event} -> ` : ''}${c.state}${c.loc ? ` (${c.loc.file}:${c.loc.line})` : ''}`).join('\n')}`] : []),
        whole !== undefined && whole.split('\n').length <= 600 ? `--- ${f.loc.file} (whole file, with line numbers for reference)\n${numbered(whole)}` : `--- ${f.loc.file} around line ${f.loc.line}\n${excerpt(root, f.loc.file, f.loc.line, 60)}`,
        ...others.map(file => `--- ${file} (related)\n${excerpt(root, file, (f.related ?? []).find(r => r.file === file)!.line, 25)}`),
        'Implement the suggested fix with the smallest change that makes the finding go away without introducing another problem, and that still compiles. Keep the style of the code.',
        'Answer with exact search/replace edits: each search is copied verbatim from the file (without the line numbers), is long enough to occur exactly once, and replace is its new text.',
        'Answer: {"edits": [{"file": "...", "search": "...", "replace": "..."}], "explanation": "one or two sentences"}'
    ].join('\n\n');
    const answer = jsonIn(await provider.complete(SYSTEM, user, onEvent)) as { edits?: Edit[]; explanation?: string } | undefined;
    const edits = (answer?.edits ?? []).filter(e => typeof e?.file === 'string' && typeof e.search === 'string' && typeof e.replace === 'string');
    return edits.length > 0 ? { finding: f, edits, explanation: answer?.explanation ?? '', by: provider.name } : undefined;
}

function readFileText(root: string, file: string): string | undefined {
    try {
        return readFileSync(join(root, file), 'utf8');
    } catch {
        return undefined;
    }
}

/** Proposals from the LLM for the first `limit` warnings/errors without a patch yet (verified by the caller). */
export async function proposeFixes(findings: Finding[], root: string, provider: LlmProvider, limit = 5): Promise<Proposal[]> {
    const proposals: Proposal[] = [];
    for (const f of findings.filter(x => x.loc && x.severity !== 'info' && !x.suggestedPatch).slice(0, limit)) {
        const locs = [f.loc!, ...(f.related ?? [])].filter((l, i, all) => all.findIndex(x => x.file === l.file && Math.abs(x.line - l.line) < 20) === i).slice(0, 3);
        const user = [
            `Finding (${f.rule}): ${f.message}`,
            `Suggested direction: ${f.fix}`,
            ...locs.map(l => `--- ${l.file} around line ${l.line}\n${excerpt(root, l.file, l.line, 30)}`),
            'Propose the smallest change that fixes it, as exact search/replace edits (search must be copied verbatim from the file, without line numbers, and occur once).',
            'Answer: {"edits": [{"file": "...", "search": "...", "replace": "..."}], "explanation": "..."}'
        ].join('\n\n');
        const answer = jsonIn(await provider.complete(SYSTEM, user)) as { edits?: Edit[]; explanation?: string } | undefined;
        const edits = (answer?.edits ?? []).filter(e => typeof e?.file === 'string' && typeof e.search === 'string' && typeof e.replace === 'string');
        if (edits.length > 0) proposals.push({ finding: f, edits, explanation: answer?.explanation ?? '', by: provider.name });
    }
    return proposals;
}

/** The findings, with a patch proposed by the LLM on the first `limit` warnings/errors, verified by re-running the checks. */
export async function suggestFixes(
    findings: Finding[],
    root: string,
    provider: LlmProvider,
    rerun: Rerun,
    limit = 5,
    baseline?: Baseline,
    buildCheck?: BuildCheck,
    onProposal?: (proposal: Proposal, index: number, total: number) => Promise<void>
): Promise<{ findings: Finding[]; log: LlmLog }> {
    const verified = await verifyProposals(findings, await proposeFixes(findings, root, provider, limit), root, rerun, undefined, baseline, buildCheck, onProposal);
    return { findings: verified.findings, log: { accepted: verified.accepted, rejected: verified.rejected } };
}

/** Unified diff of two texts (uses diff(1) when available). */
export function unifiedDiff(file: string, before: string, after: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'provenflow-diff-'));
    try {
        writeFileSync(join(dir, 'a'), before);
        writeFileSync(join(dir, 'b'), after);
        const out = spawnSync('diff', ['-u', '--label', `a/${file}`, '--label', `b/${file}`, join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
        if (out.stdout) return out.stdout;
    } catch {
        // fall through
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    return `--- a/${file}\n+++ b/${file}\n(diff unavailable)\n`;
}
