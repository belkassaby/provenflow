/**
 * Incremental re-analysis: after changes are applied, "Run the analysis again" redoes only what the
 * changed files can affect. The models are always extracted and checked again (they span files,
 * and it is quick); the expensive steps (the external analysers, verifying proposed changes,
 * replaying findings on the code) run for the changed files and for new findings only. Results for
 * the unchanged files are taken from the previous run.
 */
import { createHash } from 'node:crypto';
import type { ProvenflowConfig } from './config.js';
import type { CodeProof, ExtractedModel, Finding } from './models.js';
import type { SpecVerdict } from './verify.js';
import type { ToolRun } from './analyzers/index.js';

/** What a later run reuses from this one. */
export interface PreviousRun {
    /** Content hash of every source file analysed. */
    fingerprints: Record<string, string>;
    /** The options and config that shape the results: a different key means a full run. */
    settings: string;
    findings: Finding[];
    proofs: CodeProof[];
    tools: ToolRun[];
    /** The models and verdicts, to show a change's effect on them (before/after). */
    models: ExtractedModel[];
    verdicts: SpecVerdict[];
}

export interface IncrementalInfo {
    /** Files added, changed or removed since the previous run. */
    changed: string[];
    /** Proposed changes, confirmations and analyser findings taken from the previous run. */
    reused: { patches: number; confirmations: number; toolFindings: number };
}

const TOOL_SOURCES = new Set<Finding['source']>(['semgrep', 'codeql', 'infer', 'esbmc', 'cbmc', 'kani', 'sarif']);

export function isToolFinding(f: Finding): boolean {
    return TOOL_SOURCES.has(f.source);
}

export function fingerprints(files: string[], read: (file: string) => string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of files) out[f] = createHash('sha1').update(read(f) ?? '').digest('hex');
    return out;
}

export function settingsKey(config: ProvenflowConfig, options: Record<string, unknown>): string {
    return createHash('sha1').update(JSON.stringify({ config, options })).digest('hex');
}

/** Files that differ between two runs (added, changed, removed). */
export function changedFiles(before: Record<string, string>, now: Record<string, string>): Set<string> {
    const changed = new Set<string>();
    for (const [f, h] of Object.entries(now)) if (before[f] !== h) changed.add(f);
    for (const f of Object.keys(before)) if (!(f in now)) changed.add(f);
    return changed;
}

/** Identifies a finding across runs (lines move when a file changes, so they are not part of it). */
export function findingKey(f: Finding): string {
    return `${f.rule}|${f.subject}|${f.loc?.file ?? ''}`;
}

/** Whether a finding is about a changed file (its location, or a file its proposed change edits). */
export function touches(f: Finding, changed: Set<string>): boolean {
    return (!!f.loc && changed.has(f.loc.file)) || (f.suggestedPatch?.files ?? []).some(p => changed.has(p.file)) || (f.suggestedPatch?.edits ?? []).some(e => changed.has(e.file));
}
