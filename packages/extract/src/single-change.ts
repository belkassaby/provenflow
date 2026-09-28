/**
 * One change for one finding, on demand from the review: a fix written by the LLM from the
 * finding's suggested fix, or the version the reviewer edited ("Verify this version"). Either is
 * verified like the automatic fixes: the analysis is run again on the changed files (in memory),
 * the finding must be gone and nothing new appear, and the project must still build.
 */
import { findingKey } from './incremental.js';
import { isApplied, readSafe, verifyProposals, type BuildCheck, type Proposal, type Rerun } from './fixes.js';
import { proposeFixFor, type LlmProvider } from './llm.js';
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
    const findings = ctx.baseline.findings.includes(finding) ? ctx.baseline.findings : [...ctx.baseline.findings, finding];
    const read = (file: string) => readSafe(join(ctx.root, file));
    const result = await verifyProposals(findings, [proposal], ctx.root, ctx.rerun, read, ctx.baseline, ctx.buildCheck);
    return result.findings.find(f => findingKey(f) === findingKey(finding)) ?? finding;
}

/** Asks the LLM to implement the finding's suggested fix, then verifies its edits. */
export async function fixWithLlm(ctx: ChangeContext, finding: Finding, provider: LlmProvider): Promise<SingleChange> {
    const f = current(ctx, finding);
    const proposal = await proposeFixFor({ ...f, suggestedPatch: undefined }, ctx.root, provider);
    if (!proposal) return { finding: f, error: `${provider.name} proposed no edit for this finding.` };
    const verified = await verify(ctx, f, { ...proposal, finding: f });
    if (!verified.suggestedPatch) return { finding: verified, error: `${provider.name} proposed a change that is already in the code: the finding remains.` };
    return { finding: verified };
}

/** Verifies the reviewer's version of the changed files (whole texts). */
export async function verifyVersion(ctx: ChangeContext, finding: Finding, files: Array<{ file: string; after: string }>, by = 'your version'): Promise<SingleChange> {
    const f = current(ctx, finding);
    const edits = files
        .map(({ file, after }) => ({ file, search: readSafe(join(ctx.root, file)) ?? '', replace: after }))
        .filter(e => e.search !== e.replace);
    if (edits.length === 0) return { finding: f, error: 'This version is the same as the files on disk: nothing to verify.' };
    const missing = edits.find(e => e.search === '');
    if (missing) return { finding: f, error: `${missing.file} is not in the analysed folder.` };
    if (edits.every(e => isApplied(e.search, e))) return { finding: f, error: 'This version only repeats lines already in the file (the change is already applied).' };
    const verified = await verify(ctx, f, { finding: f, edits, explanation: 'The version you reviewed.', by });
    return { finding: verified };
}
