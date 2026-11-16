/**
 * What a check fails on. A code base adopting ProvenFlow already has findings; a pull request should
 * be held responsible only for what it adds:
 *
 * - **Baseline** (`provenflow-baseline.json`): findings accepted when the check was introduced, keyed
 *   by rule, subject and file (no line numbers, so they survive edits; counted, like PHPStan's). Only
 *   findings beyond it fail; entries that no longer occur are reported, so the file can only shrink.
 * - **New code** (`--new-only`): the same analysis of the base revision; a finding on a changed line
 *   that the base already had is not the change's doing. A finding with a measure (complexity,
 *   nesting) counts as new when the change raises the measure.
 * - **Agent-written lines**: lines whose commit was written by a coding agent (author or
 *   `Co-authored-by` trailer, or a Git AI note) can be held to a stricter threshold.
 * - **Tests**: changed lines no test runs (with a coverage report), and source changes without any
 *   test change.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPolicyConfig, ProvenflowConfig } from './config.js';
import type { FunctionFact } from './ir.js';
import { findingKey } from './incremental.js';
import type { Finding, Severity } from './models.js';
import { uncoveredChanges, type Coverage } from './quality/coverage.js';
import type { ChangedLines } from './review.js';
import { isTestFile } from './scan.js';

// ------------------------------------------------------------------------------ baseline

export const BASELINE_FILE = 'provenflow-baseline.json';

export interface BaselineEntry {
    rule: string;
    subject: string;
    file: string;
    count: number;
    /** For findings with a measure: the highest value accepted. */
    measure?: number;
    /** The message when the baseline was written, for people reading the file. */
    message?: string;
}

export interface Baseline {
    tool: 'provenflow';
    version: 1;
    entries: BaselineEntry[];
}

export function createBaseline(findings: Finding[]): Baseline {
    const entries = new Map<string, BaselineEntry>();
    for (const f of findings) {
        const key = findingKey(f);
        const e = entries.get(key);
        if (e) {
            e.count++;
            if (f.measure) e.measure = Math.max(e.measure ?? 0, f.measure.value);
        } else entries.set(key, { rule: f.rule, subject: f.subject, file: f.loc?.file ?? '', count: 1, ...(f.measure ? { measure: f.measure.value } : {}), message: f.message.slice(0, 200) });
    }
    return { tool: 'provenflow', version: 1, entries: [...entries.values()].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.subject.localeCompare(b.subject)) };
}

export function baselinePath(root: string, config: ProvenflowConfig, path?: string): string {
    return path ?? join(root, config.baseline ?? BASELINE_FILE);
}

export function readBaseline(path: string): Baseline | undefined {
    if (!existsSync(path)) return undefined;
    const data = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    if (data.tool !== 'provenflow' || !Array.isArray(data.entries)) throw new Error(`${path} is not a ProvenFlow baseline.`);
    return data;
}

export function writeBaseline(path: string, baseline: Baseline): void {
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** What the reference (a baseline or the base revision's findings) already had. */
interface Reference {
    key: string;
    measure?: number;
}

/**
 * Splits findings into those the reference already had (`existing`) and the others (`fresh`), and
 * lists the reference entries no finding matches any more (`gone`). A finding whose measure is
 * higher than the reference's is fresh: the change made it worse.
 */
export function compareWithReference(findings: Finding[], reference: Reference[]): { fresh: Finding[]; existing: Finding[]; gone: Reference[] } {
    const available = new Map<string, Array<number | undefined>>();
    for (const r of reference) available.set(r.key, [...(available.get(r.key) ?? []), r.measure]);
    const fresh: Finding[] = [];
    const existing: Finding[] = [];
    // Lowest measures first, so each takes the reference entry closest to it.
    const ordered = [...findings].sort((a, b) => (a.measure?.value ?? 0) - (b.measure?.value ?? 0));
    for (const f of ordered) {
        const key = findingKey(f);
        const left = available.get(key);
        if (!left?.length) {
            fresh.push(f);
            continue;
        }
        left.sort((a, b) => (a ?? 0) - (b ?? 0));
        const index = f.measure ? left.findIndex(m => m === undefined || m >= f.measure!.value) : 0;
        if (index < 0) {
            const was = left.shift();
            fresh.push({ ...f, message: `${f.message} (Raised from ${was} by this change.)` });
            continue;
        }
        left.splice(index, 1);
        existing.push(f);
    }
    const gone = [...available].flatMap(([key, measures]) => measures.map(measure => ({ key, measure })));
    const order = new Map(findings.map((f, i) => [f, i]));
    const original = (list: Finding[]) => list.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return { fresh: original(fresh), existing: original(existing), gone };
}

export function baselineReference(baseline: Baseline): Reference[] {
    return baseline.entries.flatMap(e => Array.from({ length: e.count }, () => ({ key: `${e.rule}|${e.subject}|${e.file}`, measure: e.measure })));
}

export function findingsReference(findings: Finding[]): Reference[] {
    return findings.map(f => ({ key: findingKey(f), measure: f.measure?.value }));
}

// -------------------------------------------------------------------- the base revision

/**
 * The project as it was at `base`, as file overrides of the working tree: changed and deleted files
 * take their old text, added files are emptied. Dependencies (node_modules...) stay those of the working tree,
 * so the two analyses differ only by the change.
 */
export function baseOverrides(root: string, base: string): Map<string, string> {
    const r = spawnSync('git', ['diff', '--name-status', '--no-renames', '--relative', base, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git diff ${base} failed: ${r.stderr.trim()}`);
    const overrides = new Map<string, string>();
    for (const line of r.stdout.split('\n').filter(Boolean)) {
        const [status, file] = line.split('\t');
        if (status === 'A') overrides.set(file, '');
        else if (status === 'M' || status === 'T' || status === 'D') {
            const old = spawnSync('git', ['show', `${base}:./${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            if (old.status === 0) overrides.set(file, old.stdout);
        }
    }
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    for (const f of untracked) overrides.set(f, '');
    return overrides;
}

// --------------------------------------------------------------------------------- agents

const AGENTS = /\b(claude|anthropic|copilot|codex|openai|cursor|devin|cognition|jules|gemini|aider|openhands|sweep|codewhisperer|amazon q|tabnine|windsurf|cline|roo ?code|bolt|lovable|replit agent)\b/i;
const NOT_AGENTS = /dependabot|renovate|github-actions/i;

export interface AgentLines {
    /** Commits since the base written (or co-written) by a coding agent. */
    commits: string[];
    /** Changed lines those commits wrote. */
    lines: ChangedLines;
}

/** Whether a commit's author or co-authors are coding agents. */
export function isAgentCommit(author: string, message: string, extra: RegExp[] = []): boolean {
    const people = [author, ...[...message.matchAll(/^co-authored-by:\s*(.+)$/gim)].map(m => m[1])];
    return people.some(p => !NOT_AGENTS.test(p) && (AGENTS.test(p) || extra.some(re => re.test(p))));
}

export function agentLines(root: string, base: string, changed: ChangedLines, policy: AgentPolicyConfig = {}): AgentLines {
    const commits = agentCommits(root, base, (policy.authors ?? []).map(a => new RegExp(a, 'i')));
    const lines: ChangedLines = new Map();
    if (commits.size === 0) return { commits: [], lines };
    for (const [file, set] of changed) {
        const mine = [...blame(root, file)].filter(([line, sha]) => set.has(line) && commits.has(sha)).map(([line]) => line);
        if (mine.length) lines.set(file, new Set(mine));
    }
    return { commits: [...commits], lines };
}

/** Commits since `base` by coding agents: their author or co-authors, or a Git AI note (refs/notes/ai). */
function agentCommits(root: string, base: string, extra: RegExp[]): Set<string> {
    const commits = new Set<string>();
    const log = spawnSync('git', ['log', '--format=%H%x1f%an <%ae>%x1f%B%x1e', `${base}..HEAD`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const record of log.status === 0 ? log.stdout.split('\x1e') : []) {
        const [sha, author, message] = record.trim().split('\x1f');
        if (sha && isAgentCommit(author ?? '', message ?? '', extra)) commits.add(sha);
    }
    const notes = spawnSync('git', ['notes', '--ref=ai', 'list'], { cwd: root, encoding: 'utf8' });
    for (const line of notes.status === 0 ? notes.stdout.split('\n') : []) if (line.trim()) commits.add(line.trim().split(/\s+/)[1]);
    return commits;
}

/** The commit of each line of a file at HEAD (git blame). */
function blame(root: string, file: string): Map<number, string> {
    const out = new Map<number, string>();
    const r = spawnSync('git', ['blame', '--porcelain', 'HEAD', '--', file], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return out;
    for (const m of r.stdout.matchAll(/^([0-9a-f]{40}) \d+ (\d+)(?: (\d+))?$/gm)) {
        for (let l = Number(m[2]); l < Number(m[2]) + Number(m[3] ?? 1); l++) out.set(l, m[1]);
    }
    return out;
}

// ---------------------------------------------------------------------------------- tests

/** Findings about the tests of a change: changed lines no test runs, and source changes without tests. */
export function changeTestFindings(changed: ChangedLines, functions: FunctionFact[], coverage: Coverage | undefined, config: ProvenflowConfig): { findings: Finding[]; notes: string[] } {
    if (coverage) {
        const r = uncoveredChanges(coverage, changed, functions, config.coverage?.severity ?? 'warning');
        const notes = r.unmeasured.length ? [`Changed file(s) missing from the coverage report: ${r.unmeasured.slice(0, 5).join(', ')}${r.unmeasured.length > 5 ? ', ...' : ''}.`] : [];
        return { findings: r.findings, notes };
    }
    if ([...changed.keys()].some(isTestFile)) return { findings: [], notes: [] };
    const findings = [...changed].filter(([file]) => !isTestFile(file)).flatMap(([file, lines]) => untestedChange(file, lines, functions));
    return { findings, notes: [] };
}

/** A source file whose functions changed by 3 lines or more, in a change that touches no test. */
function untestedChange(file: string, lines: Set<number>, functions: FunctionFact[]): Finding[] {
    const inside = (f: FunctionFact, l: number) => l >= f.loc.line && l < f.loc.line + f.lines;
    const touched = functions.filter(f => f.loc.file === file && [...lines].some(l => inside(f, l)));
    const changedInCode = [...lines].filter(l => touched.some(f => inside(f, l)));
    if (changedInCode.length < 3) return [];
    const names = `${touched.slice(0, 3).map(f => f.name).join(', ')}${touched.length > 3 ? ', ...' : ''}`;
    return [
        {
            rule: 'change-without-test',
            category: 'tests',
            severity: 'info',
            subject: file,
            message: `${changedInCode.length} line(s) of ${touched.length} function(s) in ${file} changed (${names}), and no test file changed with them.`,
            fix: 'Add or update a test that exercises the changed behaviour, or pass a coverage report (--coverage) to show existing tests run these lines.',
            loc: { file, line: Math.min(...changedInCode) },
            source: 'analysis'
        }
    ];
}

// ----------------------------------------------------------------------------------- gate

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function atLeast(f: Finding, level: Severity | 'none'): boolean {
    return level !== 'none' && RANK[f.severity] <= RANK[level];
}

/** The findings that fail the check: at `failOn` or above, or at the agent policy's level on agent-written lines. */
export function failing(findings: Finding[], failOn: Severity | 'none', agents?: { lines: ChangedLines; policy: AgentPolicyConfig }): Finding[] {
    return findings.filter(f => {
        if (atLeast(f, failOn)) return true;
        if (!agents || !f.loc || !agents.lines.get(f.loc.file)?.has(f.loc.line)) return false;
        return atLeast(f, agents.policy.failOn ?? 'warning') || (f.rule === 'change-without-test' && agents.policy.requireTests !== false);
    });
}

/**
 * Duplicated code has two places; a review reports it on the one the change touched (a new copy of
 * old code is reported on the copy, wherever it sits in the file order).
 */
export function orientToChange(findings: Finding[], changed: ChangedLines): Finding[] {
    return findings.map(f => {
        if (f.category !== 'duplication' || !f.loc || !f.related?.length) return f;
        const onLoc = changed.get(f.loc.file)?.has(f.loc.line);
        const other = f.related[0];
        if (onLoc || !changed.get(other.file)?.has(other.line)) return f;
        return { ...f, loc: other, related: [f.loc, ...f.related.slice(1)], endLine: undefined };
    });
}
