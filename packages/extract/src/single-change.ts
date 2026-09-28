/**
 * One change for one finding, on demand from the review: a fix written by the LLM from the
 * finding's suggested fix, or the version the reviewer edited ("Verify this version"). Either is
 * verified like the automatic fixes: the analysis is run again on the changed files (in memory),
 * the finding must be gone and nothing new appear, and the project must still build.
 */
import { findingKey } from './incremental.js';
import { isApplied, lineDiff, quickFixes, readSafe, verifyProposals, type BuildCheck, type Proposal, type Rerun } from './fixes.js';
import type { ProvenflowConfig } from './config.js';
import type { Facts } from './ir.js';
import { proposeFixFor, type LlmEvent, type LlmProvider, type LlmUsage } from './llm.js';
import type { ExtractedModel, Finding } from './models.js';
import type { SpecVerdict } from './verify.js';
import { join } from 'node:path';

/** What checking a change needs: the project, its last results, and how to re-run and build it. */
export interface ChangeContext {
    root: string;
    baseline: { findings: Finding[]; models: ExtractedModel[]; verdicts: SpecVerdict[] };
    rerun: Rerun;
    buildCheck?: BuildCheck;
}

/** What a single change reports while it is made: the LLM's events, and the step being done. */
export type ChangeEvent = LlmEvent | { type: 'stage'; text: string };

export interface SingleChange {
    finding: Finding;
    /** Why no change could be checked (the LLM proposed nothing, the version is unchanged...). */
    error?: string;
}

/** The finding as the last run reported it (the browser's copy may be older). */
function current(ctx: ChangeContext, finding: Finding): Finding {
    return ctx.baseline.findings.find(f => findingKey(f) === findingKey(finding)) ?? finding;
}

async function verify(ctx: ChangeContext, finding: Finding, proposal: Proposal): Promise<Finding> {
    // The finding stands for its copy in the last run (the same key), or is added when that run did not have it.
    const key = findingKey(finding);
    const known = ctx.baseline.findings.some(f => findingKey(f) === key);
    const findings = known ? ctx.baseline.findings.map(f => (findingKey(f) === key ? finding : f)) : [...ctx.baseline.findings, finding];
    const read = (file: string) => readSafe(join(ctx.root, file));
    const result = await verifyProposals(findings, [proposal], ctx.root, ctx.rerun, read, ctx.baseline, ctx.buildCheck);
    return result.findings[findings.indexOf(finding)] ?? finding;
}

/** Asks the LLM to implement the finding's suggested fix, then verifies its edits. */
export async function fixWithLlm(ctx: ChangeContext, finding: Finding, provider: LlmProvider, onEvent?: (e: ChangeEvent) => void): Promise<SingleChange> {
    const f = current(ctx, finding);
    const started = Date.now();
    let usage: LlmUsage | undefined;
    let thinking = '';
    onEvent?.({ type: 'stage', text: `Asking ${provider.name} to implement the suggested fix…` });
    const proposal = await proposeFixFor({ ...f, suggestedPatch: undefined }, ctx.root, provider, e => {
        if (e.type === 'usage') usage = e.usage;
        if (e.type === 'thinking') thinking += e.text;
        onEvent?.(e);
    });
    const llm = { usage, thinking: thinking ? thinking.slice(0, 50_000) : undefined, ms: Date.now() - started };
    if (!proposal) return { finding: f, error: `${provider.name} proposed no edit for this finding.` };
    onEvent?.({ type: 'stage', text: 'Verifying the change: the analysis again on the changed files, then the build or type check…' });
    const verified = await verify(ctx, f, { ...proposal, finding: f });
    if (!verified.suggestedPatch) return { finding: verified, error: `${provider.name} proposed a change that is already in the code: the finding remains.` };
    return { finding: { ...verified, suggestedPatch: { ...verified.suggestedPatch, llm } } };
}

/** A fresh analysis of the project, which the automatic fixes are computed from. */
export interface Analysis {
    findings: Finding[];
    facts: Facts;
    models: ExtractedModel[];
    config: ProvenflowConfig;
}

/**
 * The fix the analysis itself can make for a finding (no LLM): one of the automatic quick fixes,
 * verified. When none applies to this finding, a draft: the suggested fix written as a comment at
 * the line to change, for the reviewer to implement and verify (Verify this version).
 */
export async function fixWithoutLlm(ctx: ChangeContext, finding: Finding, analysis: Analysis, onEvent?: (e: ChangeEvent) => void): Promise<SingleChange> {
    const f = analysis.findings.find(x => findingKey(x) === findingKey(finding)) ?? current(ctx, finding);
    const read = (file: string) => readSafe(join(ctx.root, file));
    const [proposal] = quickFixes([{ ...f, suggestedPatch: undefined }], analysis.facts, analysis.models, read, analysis.config);
    if (proposal) {
        onEvent?.({ type: 'stage', text: 'Verifying the automatic fix: the analysis again on the changed files, then the build or type check…' });
        const verified = await verify(ctx, f, { ...proposal, finding: f });
        if (verified.suggestedPatch) return { finding: verified };
    }
    const draft = draftChange(f, read);
    if (!draft) return { finding: f, error: 'This finding has no place in the code to change (it is about the project as a whole): follow its fix.' };
    return { finding: { ...f, suggestedPatch: draft } };
}

const COMMENT: Array<[RegExp, string]> = [
    [/\.(py|rb|r|R|sh|bash|zsh|ya?ml|toml|pl|ex|exs)$/, '#'],
    [/\.(sql|lua|hs)$/, '--']
];

/** The suggested fix as a comment above the line of the finding (not verified: it changes nothing yet). */
function draftChange(f: Finding, read: (file: string) => string | undefined): Finding['suggestedPatch'] {
    if (!f.loc) return undefined;
    const before = read(f.loc.file);
    if (before === undefined) return undefined;
    const lines = before.split('\n');
    const at = Math.min(Math.max(f.loc.line - 1, 0), lines.length - 1);
    const indent = /^(\s*)/.exec(lines[at])![1];
    const mark = COMMENT.find(([re]) => re.test(f.loc!.file))?.[1] ?? '//';
    const words = `TODO(pflow ${f.rule}): ${f.fix}`.split(/\s+/);
    const wrapped: string[] = [];
    for (const w of words) {
        if (wrapped.length && (wrapped[wrapped.length - 1] + ' ' + w).length <= 96) wrapped[wrapped.length - 1] += ` ${w}`;
        else wrapped.push(w);
    }
    const comment = wrapped.map(l => `${indent}${mark} ${l}`);
    const after = [...lines.slice(0, at), ...comment, ...lines.slice(at)].join('\n');
    const anchor = lines.slice(Math.max(0, at - 1), at + 1).join('\n');
    const edits = [{ file: f.loc.file, search: anchor, replace: at > 0 ? `${lines[at - 1]}\n${comment.join('\n')}\n${lines[at]}` : `${comment.join('\n')}\n${lines[at]}` }];
    return {
        diff: lineDiff(f.loc.file, before, after),
        files: [{ file: f.loc.file, before, after }],
        verified: false,
        note: 'No automatic fix applies to this finding: the suggested fix is written as a comment where the code has to change. Replace it with the change on the right, then Verify this version.',
        by: 'draft',
        edits
    };
}

/** Verifies the reviewer's version of the changed files (whole texts). */
export async function verifyVersion(ctx: ChangeContext, finding: Finding, files: Array<{ file: string; after: string }>, by = 'your version', onEvent?: (e: ChangeEvent) => void): Promise<SingleChange> {
    const f = current(ctx, finding);
    const edits = files
        .map(({ file, after }) => ({ file, search: readSafe(join(ctx.root, file)) ?? '', replace: after }))
        .filter(e => e.search !== e.replace);
    if (edits.length === 0) return { finding: f, error: 'This version is the same as the files on disk: nothing to verify.' };
    const missing = edits.find(e => e.search === '');
    if (missing) return { finding: f, error: `${missing.file} is not in the analysed folder.` };
    if (edits.every(e => isApplied(e.search, e))) return { finding: f, error: 'This version only repeats lines already in the file (the change is already applied).' };
    onEvent?.({ type: 'stage', text: 'Verifying your version: the analysis again on the changed files, then the build or type check…' });
    const verified = await verify(ctx, f, { finding: f, edits, explanation: 'The version you reviewed.', by });
    return { finding: verified };
}
