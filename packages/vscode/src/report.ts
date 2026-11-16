/**
 * What the extension reads from pflow's report.json (written by `pflow extract`, see
 * packages/extract/src/report.ts), and the problems it shows for it, file by file. No `vscode`
 * import here: the editor's types are made from these in diagnostics.ts.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Location {
    /** Relative to the analysed folder. */
    file: string;
    line: number;
}

export interface PatchFile {
    file: string;
    after: string;
}

export interface ReportFinding {
    rule: string;
    severity: Severity;
    subject: string;
    message: string;
    fix: string;
    loc?: Location;
    endLine?: number;
    related?: Location[];
    spec?: string;
    counterexample?: Array<{ state: string; event?: string; loc?: Location }>;
    confirmation?: { by: string; status: 'confirmed' | 'refuted' | 'unknown'; detail: string };
    suggestedPatch?: { verified: boolean; note: string; by?: string; files?: PatchFile[] };
}

export interface Report {
    findings: ReportFinding[];
    summary: Record<Severity, number>;
}

/** A proposed change: the whole new text of each file it touches. */
export interface ProblemFix {
    title: string;
    verified: boolean;
    files: PatchFile[];
}

export interface RelatedPlace extends Location {
    message: string;
}

/** A finding as the editor shows it; lines are 0-based, as editors count them. */
export interface Problem {
    file: string;
    line: number;
    endLine: number;
    severity: Severity;
    code: string;
    message: string;
    related: RelatedPlace[];
    fix?: ProblemFix;
}

/** Reads report.json's text; undefined when it is not a report. */
export function parseReport(text: string): Report | undefined {
    try {
        const value = JSON.parse(text) as Partial<Report>;
        if (!Array.isArray(value.findings)) return undefined;
        return { findings: value.findings, summary: value.summary ?? countSeverities(value.findings) };
    } catch {
        return undefined;
    }
}

function countSeverities(findings: ReportFinding[]): Record<Severity, number> {
    const count = (s: Severity) => findings.filter(f => f.severity === s).length;
    return { error: count('error'), warning: count('warning'), info: count('info') };
}

/** The problems of each file (findings with no place in a file stay in the report). */
export function problemsByFile(report: Report): Map<string, Problem[]> {
    const out = new Map<string, Problem[]>();
    for (const finding of report.findings) {
        const problem = problemOf(finding);
        if (!problem) continue;
        out.set(problem.file, [...(out.get(problem.file) ?? []), problem]);
    }
    return out;
}

export function problemOf(finding: ReportFinding): Problem | undefined {
    if (!finding.loc) return undefined;
    const line = Math.max(0, finding.loc.line - 1);
    return {
        file: finding.loc.file,
        line,
        endLine: Math.max(line, (finding.endLine ?? finding.loc.line) - 1),
        severity: finding.severity,
        code: finding.rule,
        message: messageOf(finding),
        related: relatedOf(finding),
        fix: fixOf(finding)
    };
}

function messageOf(finding: ReportFinding): string {
    const lines = [finding.message, `Fix: ${finding.fix}`];
    if (finding.spec) lines.push(`Property: ${finding.spec}`);
    if (finding.confirmation) lines.push(`On the code (${finding.confirmation.by}): ${finding.confirmation.status}. ${finding.confirmation.detail}`);
    return lines.join('\n');
}

/** The other places of a finding, and the steps of its counterexample that have a place in the code. */
function relatedOf(finding: ReportFinding): RelatedPlace[] {
    const others = (finding.related ?? []).map(loc => ({ ...loc, message: `Also: ${finding.subject}` }));
    const steps = (finding.counterexample ?? []).flatMap((step, i) => (step.loc ? [{ ...step.loc, message: `Step ${i}: ${step.event ? `${step.event} → ` : ''}${step.state}` }] : []));
    return [...others, ...steps];
}

function fixOf(finding: ReportFinding): ProblemFix | undefined {
    const patch = finding.suggestedPatch;
    if (!patch?.files?.length) return undefined;
    const title = patch.verified ? 'ProvenFlow: apply verified fix' : 'ProvenFlow: apply unverified fix (review it)';
    return { title, verified: patch.verified, files: patch.files.map(f => ({ file: f.file, after: f.after })) };
}

/** The fixes a user is offered: verified ones, and unverified ones only when asked for. */
export function offeredFixes(problems: Problem[], policy: { unverified: boolean }): ProblemFix[] {
    return problems.flatMap(p => (p.fix && (p.fix.verified || policy.unverified) ? [p.fix] : []));
}

/** The status bar's text for the counts of a report (with VS Code's icons). */
export function countsText(summary: Record<Severity, number>): string {
    return `ProvenFlow $(error) ${summary.error} $(warning) ${summary.warning}`;
}
