/**
 * A review of a change, as `pflow review`, the coding-agent hooks and the MCP server run it:
 *
 *   analysis of the project → findings on the changed lines (duplicates reported on the side the
 *   change touched) → test findings (uncovered changed lines, or source changed without tests) →
 *   optional mutation testing of the changed lines → only what the change adds (against the base
 *   revision's analysis and the baseline) → what fails, with the stricter policy for agent-written
 *   lines.
 */
import { join, resolve } from 'node:path';
import { loadConfig, type ProvenflowConfig } from './config.js';
import { readSafe } from './fixes.js';
import { agentLines, baselinePath, baselineReference, baseOverrides, changeTestFindings, compareWithReference, failing, findingsReference, orientToChange, readBaseline, type AgentLines } from './gate.js';
import { extractProject, type ExtractionResult, type ExtractOptions } from './project.js';
import type { Finding, Severity } from './models.js';
import { runMutation, type MutationRun } from './mutation.js';
import { readCoverage } from './quality/coverage.js';
import { changedLines, onChanged, type ChangedLines } from './review.js';

export interface ReviewOptions extends ExtractOptions {
    /** Git revision the change is compared with (all findings when omitted). */
    base?: string;
    /** Findings on the changed lines (default) or anywhere in the changed files. */
    scope?: 'lines' | 'files';
    /** Analyse the base revision too, and keep only the findings the change adds. */
    newOnly?: boolean;
    /** Baseline file (default: the config's, or provenflow-baseline.json when it exists); false: none. */
    baseline?: string | false;
    /** Mutation-test up to this many changed lines (0: no mutation testing). */
    mutate?: number;
    /** Test command for mutation testing (default: detected). */
    mutationTest?: string;
    failOn?: Severity | 'none';
}

export interface ReviewRun {
    result: ExtractionResult;
    config: ProvenflowConfig;
    base?: string;
    changed?: ChangedLines;
    /** The findings the review reports. */
    relevant: Finding[];
    /** On changed lines, but already there at the base revision. */
    existing: Finding[];
    /** Accepted in the baseline. */
    accepted: Finding[];
    /** Baseline entries that no longer occur anywhere (the baseline can be tightened). */
    stale: number;
    agents?: AgentLines;
    mutation?: MutationRun;
    /** The findings that fail the check. */
    failing: Finding[];
    /** Lines for the review's summary. */
    extras: string[];
    notes: string[];
}

export async function runReview(folder: string, options: ReviewOptions = {}): Promise<ReviewRun> {
    const root = resolve(folder);
    const config = options.config ?? loadConfig(root, options.configFile);
    const result = await extractProject(root, { ...options, config });
    const changed = options.base ? changedLines(root, options.base) : undefined;
    const run: ReviewRun = { result, config, base: options.base, changed, relevant: result.findings, existing: [], accepted: [], stale: 0, failing: [], extras: [], notes: [] };
    if (changed) {
        withTests(run, changed, options);
        await withMutation(run, changed, root, options);
        if (options.newOnly && options.base) await withoutBaseFindings(run, root, options.base, options);
    }
    if (options.baseline !== false) withBaseline(run, root, options.baseline || undefined);
    if (changed && options.base) withAgents(run, root, options.base, changed);
    const agents = run.agents?.commits.length ? { lines: run.agents.lines, policy: config.agents ?? {} } : undefined;
    run.failing = failing(run.relevant, options.failOn ?? 'error', agents);
    return run;
}

/** Findings on the changed lines (duplicates on the side the change touched), with the test findings of the change. */
function withTests(run: ReviewRun, changed: ChangedLines, options: ReviewOptions): void {
    const reports = [...(run.config.coverage?.reports ?? []), ...(options.coverage ?? [])];
    const coverage = reports.length ? readCoverage(run.result.root, reports, run.result.facts.files).coverage : undefined;
    const tests = changeTestFindings(changed, run.result.facts.functions, coverage, run.config);
    run.relevant = onChanged([...orientToChange(run.result.findings, changed), ...tests.findings], changed, options.scope ?? 'lines');
    run.notes.push(...tests.notes);
}

async function withMutation(run: ReviewRun, changed: ChangedLines, root: string, options: ReviewOptions): Promise<void> {
    if ((options.mutate ?? 0) <= 0) return;
    const first = new Set(run.relevant.filter(f => f.loc).map(f => `${f.loc!.file}:${f.loc!.line}`));
    const mutation = await runMutation(root, run.result.facts.files, changed, run.config, { max: options.mutate, test: options.mutationTest, first });
    run.mutation = mutation;
    run.relevant = [...run.relevant, ...mutation.findings];
    run.notes.push(...mutation.notes);
    if (mutation.mutants.length) run.extras.push(`Mutation testing: ${mutation.mutants.filter(m => m.killed).length} of ${mutation.mutants.length} mutants of the changed lines caught by the tests (${mutation.score}%).`);
}

/** Only what the change adds: the same analysis of the base revision, compared. */
async function withoutBaseFindings(run: ReviewRun, root: string, base: string, options: ReviewOptions): Promise<void> {
    const before = await extractProject(root, { ...options, config: run.config, overrides: baseOverrides(root, base), quickFixes: 0, llmFixes: 0, llm: undefined, confirm: false, previous: undefined, onProgress: undefined });
    const split = compareWithReference(run.relevant, findingsReference(before.findings));
    run.relevant = split.fresh;
    run.existing = split.existing;
    if (split.existing.length) run.extras.push(`${split.existing.length} finding(s) on the changed lines were already there at the base, and are not counted.`);
}

function withBaseline(run: ReviewRun, root: string, file: string | undefined): void {
    const path = baselinePath(root, run.config, file);
    const baseline = readBaseline(path);
    if (!baseline) return;
    const reference = baselineReference(baseline);
    const split = compareWithReference(run.relevant, reference);
    run.relevant = split.fresh;
    run.accepted = split.existing;
    run.stale = compareWithReference(run.result.findings, reference).gone.length;
    if (run.accepted.length) run.extras.push(`${run.accepted.length} finding(s) accepted in the baseline (${path.slice(root.length + 1)}).`);
    if (run.stale) run.extras.push(`${run.stale} baseline entr${run.stale === 1 ? 'y no longer occurs' : 'ies no longer occur'}: run \`pflow baseline --update\` to tighten it.`);
}

function withAgents(run: ReviewRun, root: string, base: string, changed: ChangedLines): void {
    run.agents = agentLines(root, base, changed, run.config.agents);
    if (!run.agents.commits.length) return;
    const lines = [...run.agents.lines.values()].reduce((n, s) => n + s.size, 0);
    const policy = run.config.agents ?? {};
    run.extras.push(`${run.agents.commits.length} commit(s) by coding agents wrote ${lines} of the changed lines: findings there fail at ${policy.failOn ?? 'warning'} level${policy.requireTests !== false ? ', and changes need tests' : ''}.`);
}

/** The text of a file of the project. */
export function projectReader(root: string): (file: string) => string | undefined {
    return file => readSafe(join(root, file));
}
