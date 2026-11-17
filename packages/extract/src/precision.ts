/**
 * How often ProvenFlow's counterexamples are real (`pflow bench`): every counterexample that can be
 * replayed on the code is, and the share the code confirms is counted per rule. A counterexample the
 * code refutes is a false alarm of the model (it is coarser than the code); one that cannot run says
 * nothing either way.
 */
import type { Finding } from './models.js';

export interface PrecisionRow {
    rule: string;
    findings: number;
    /** Findings that come with a counterexample (a run of the model). */
    counterexamples: number;
    /** Checked on the code: replayed, or checked by a code model checker. */
    checked: number;
    confirmed: number;
    refuted: number;
    /** Checked, but the run could not tell (the class needs real dependencies, a tool failed...). */
    unknown: number;
}

export interface PrecisionProject {
    name: string;
    files: number;
    rows: PrecisionRow[];
}

/** The counts per rule of the findings of one run (rules without a counterexample are left out). */
export function precisionOf(findings: Finding[]): PrecisionRow[] {
    const rows = new Map<string, PrecisionRow>();
    for (const f of findings) {
        const row = rows.get(f.rule) ?? { rule: f.rule, findings: 0, counterexamples: 0, checked: 0, confirmed: 0, refuted: 0, unknown: 0 };
        row.findings++;
        if (f.counterexample?.length) row.counterexamples++;
        if (f.confirmation) {
            row.checked++;
            row[f.confirmation.status]++;
        }
        rows.set(f.rule, row);
    }
    return [...rows.values()].filter(r => r.counterexamples || r.checked).sort((a, b) => b.checked - a.checked || a.rule.localeCompare(b.rule));
}

/** The rows of several runs added up, per rule. */
export function totalPrecision(projects: PrecisionProject[]): PrecisionRow[] {
    const total = new Map<string, PrecisionRow>();
    for (const r of projects.flatMap(p => p.rows)) {
        const t = total.get(r.rule) ?? { rule: r.rule, findings: 0, counterexamples: 0, checked: 0, confirmed: 0, refuted: 0, unknown: 0 };
        for (const k of ['findings', 'counterexamples', 'checked', 'confirmed', 'refuted', 'unknown'] as const) t[k] += r[k];
        total.set(r.rule, t);
    }
    return [...total.values()].sort((a, b) => b.checked - a.checked || a.rule.localeCompare(b.rule));
}

function percent(part: number, whole: number): string {
    return whole ? `${Math.round((part / whole) * 100)}%` : '-';
}

/** The share confirmed of the counterexamples the code could decide (confirmed or refuted). */
export function precisionMarkdown(projects: PrecisionProject[]): string {
    const total = totalPrecision(projects);
    const sum = (k: keyof Omit<PrecisionRow, 'rule'>) => total.reduce((n, r) => n + r[k], 0);
    const [confirmed, refuted, unknown, checked] = [sum('confirmed'), sum('refuted'), sum('unknown'), sum('checked')];
    const row = (r: PrecisionRow) => `| ${r.rule} | ${r.findings} | ${r.counterexamples} | ${r.checked} | ${r.confirmed} | ${r.refuted} | ${r.unknown} | ${percent(r.confirmed, r.confirmed + r.refuted)} |`;
    const header = ['| rule | findings | with a counterexample | checked on the code | confirmed | refuted | could not tell | confirmed of decided |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
    return [
        '# How often counterexamples are real',
        '',
        `${projects.length} code base(s), ${projects.reduce((n, p) => n + p.files, 0)} files. Of ${checked} counterexample(s) checked on the code, ${confirmed} were confirmed and ${refuted} refuted: **${percent(confirmed, confirmed + refuted)} of those the code decided are real**. ${unknown} could not be run (the class needs real dependencies, or a tool was missing).`,
        '',
        ...header,
        ...total.map(row),
        '',
        ...projects.flatMap(p => [`## ${p.name} (${p.files} files)`, '', ...(p.rows.length ? [...header, ...p.rows.map(row)] : ['No finding with a counterexample.']), ''])
    ].join('\n');
}
