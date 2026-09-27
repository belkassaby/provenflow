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

export interface LlmProvider {
    /** e.g. `anthropic:claude-sonnet-5`. */
    name: string;
    complete(system: string, user: string): Promise<string>;
}

type Fetch = typeof fetch;

/** `anthropic:<model>`, `openai:<model>` (any OpenAI-compatible server via OPENAI_BASE_URL) or `ollama:<model>`. */
export function providerFromSpec(spec: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): LlmProvider {
    const [kind, ...rest] = spec.split(':');
    const model = rest.join(':');
    const post = async (url: string, headers: Record<string, string>, body: unknown): Promise<unknown> => {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
        if (!response.ok) {
            const text = (await response.text()).slice(0, 300);
            const hint = /anthropic-workspace-id/.test(text) ? ' Set the workspace ID (LLM settings, or ANTHROPIC_WORKSPACE_ID): it is in the Claude Console under Settings → Workspaces. Or create the key inside a workspace.' : '';
            throw new Error(`${spec}: HTTP ${response.status} ${text}${hint}`);
        }
        return response.json();
    };
    switch (kind) {
        case 'anthropic': {
            const key = env['ANTHROPIC_API_KEY'];
            if (!key) throw new Error('Set ANTHROPIC_API_KEY to use anthropic:<model>.');
            return {
                name: spec,
                async complete(system, user) {
                    // A key not scoped to a workspace needs the workspace named in each request.
                    const workspace: Record<string, string> = env['ANTHROPIC_WORKSPACE_ID'] ? { 'anthropic-workspace-id': env['ANTHROPIC_WORKSPACE_ID'] } : {};
                    const json = (await post(`${env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com'}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...workspace }, { model: model || 'claude-sonnet-5', max_tokens: 4096, system, messages: [{ role: 'user', content: user }] })) as { content: Array<{ type: string; text?: string }> };
                    return json.content.filter(c => c.type === 'text').map(c => c.text).join('');
                }
            };
        }
        case 'openai': {
            const key = env['OPENAI_API_KEY'] ?? '';
            return {
                name: spec,
                async complete(system, user) {
                    const url = `${env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'}/chat/completions`;
                    const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
                    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
                    // Reasoning models refuse a temperature: ask again without it.
                    const json = (await post(url, headers, { ...body, temperature: 0 }).catch(error => {
                        if (/HTTP 400.*temperature/s.test((error as Error).message)) return post(url, headers, body);
                        throw error;
                    })) as { choices: Array<{ message: { content: string } }> };
                    return json.choices[0]?.message.content ?? '';
                }
            };
        }
        case 'ollama':
            return {
                name: spec,
                async complete(system, user) {
                    const json = (await post(`${env['OLLAMA_HOST'] ?? 'http://localhost:11434'}/api/chat`, {}, { model, stream: false, options: { temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })) as { message: { content: string } };
                    return json.message.content;
                }
            };
        default:
            throw new Error(`Unknown LLM provider '${kind}': use anthropic:<model>, openai:<model> or ollama:<model>.`);
    }
}

/** Caches answers on disk by the hash of provider, system prompt and user prompt. */
export function cachedProvider(provider: LlmProvider, dir: string): LlmProvider {
    return {
        name: provider.name,
        async complete(system, user) {
            const key = createHash('sha256').update(`${provider.name}\n${system}\n${user}`).digest('hex');
            const file = join(dir, `${key}.json`);
            if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { answer: string }).answer;
            const answer = await provider.complete(system, user);
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
