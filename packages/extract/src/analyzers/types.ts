/** External analysers run next to ProvenFlow's own checks; each is optional and detected on the machine. */
import type { ProvenflowConfig } from '../config.js';
import type { Facts, Location } from '../ir.js';
import type { CodeProof, Finding } from '../models.js';

export interface AnalyzerContext {
    /** The project as analysed (paths in findings are relative to it). */
    root: string;
    /** Where to run the tools: the project, or a temporary copy with proposed changes applied. */
    dir: string;
    facts: Facts;
    config: ProvenflowConfig;
    env: NodeJS.ProcessEnv;
    /** Re-run for a proposed change: only these files changed (tools look at them only). */
    onlyFiles?: string[];
}

/** A search/replace edit an external tool proposes (e.g. Semgrep's autofix). */
export interface ToolFix {
    finding: Finding;
    file: string;
    search: string;
    replace: string;
    explanation: string;
}

export interface AnalyzerOutput {
    findings: Finding[];
    proofs: CodeProof[];
    fixes: ToolFix[];
    notes: string[];
    /** What ran: tool, version, time, and what it looked at. */
    ran: ToolRun[];
}

export interface ToolRun {
    tool: string;
    version?: string;
    ms: number;
    scope: string;
    ok: boolean;
}

export interface Analyzer {
    id: string;
    run(ctx: AnalyzerContext): Promise<AnalyzerOutput>;
}

export function emptyOutput(): AnalyzerOutput {
    return { findings: [], proofs: [], fixes: [], notes: [], ran: [] };
}

export function loc(file: string, line: number | undefined): Location {
    return { file, line: Math.max(1, line ?? 1) };
}

/** An analyser's options from the config: false turns it off; objects give options. */
export function option<T extends object>(value: boolean | T | undefined, defaultOn: boolean): { on: boolean; options: Partial<T> } {
    if (value === false) return { on: false, options: {} };
    if (value === true) return { on: true, options: {} };
    if (value && typeof value === 'object') return { on: true, options: value };
    return { on: defaultOn, options: {} };
}
