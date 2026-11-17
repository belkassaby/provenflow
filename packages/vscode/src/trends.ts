/**
 * The Trends view: how the folder's quality moved over its measured commits, from
 * `pflow trends <folder> --json` (the history `pflow extract` keeps, and `--backfill` measures from
 * git). No `vscode` import here.
 */
import type { TreeNode } from './sidebar';

/** One measured commit, as `pflow trends --json` gives it (see packages/extract/src/history.ts). */
export interface MeasuredRun {
    date: string;
    commit?: string;
    codeLines: number;
    findings: { error: number; warning: number; info: number };
    duplication: { percent: number };
    complexity: { p90: number; overLimit: number };
    coverage?: number;
    properties: { failed: number };
}

interface Measure {
    label: string;
    value: (run: MeasuredRun) => number | undefined;
    unit?: string;
    /** Which way is good news: down (the default: findings, duplication, complexity), up (coverage), or neither (code lines). */
    better?: 'up' | 'neither';
}

const MEASURES: Measure[] = [
    { label: 'Errors', value: r => r.findings.error },
    { label: 'Warnings', value: r => r.findings.warning },
    { label: 'Properties false', value: r => r.properties.failed },
    { label: 'Duplicated code', value: r => r.duplication.percent, unit: '%' },
    { label: 'Complexity, 90th percentile', value: r => r.complexity.p90 },
    { label: 'Functions over the limit', value: r => r.complexity.overLimit },
    { label: 'Line coverage', value: r => r.coverage, unit: '%', better: 'up' },
    { label: 'Code lines', value: r => r.codeLines, better: 'neither' }
];

const LEVELS = '▁▂▃▄▅▆▇█';

/** A bar per value, from the lowest (▁) to the highest (█). */
export function bars(values: number[]): string {
    const low = Math.min(...values);
    const span = Math.max(...values) - low;
    return values.map(v => LEVELS[span === 0 ? 0 : Math.round(((v - low) / span) * (LEVELS.length - 1))]).join('');
}

/** The runs of the folder in `pflow trends --json`'s output (the first code base), or undefined when it is not that output. */
export function runsOf(json: string): MeasuredRun[] | undefined {
    try {
        const projects = JSON.parse(json) as Array<{ entries?: MeasuredRun[] }>;
        return Array.isArray(projects) ? (projects[0]?.entries ?? []) : undefined;
    } catch {
        return undefined;
    }
}

/** A row per measure: its latest value, the change since the first run, and a bar per run (the last `last`). */
export function trendNodes(all: MeasuredRun[], last = 30): TreeNode[] {
    const runs = all.slice(-last);
    if (runs.length === 0) return [];
    const span = `${runs.length} run(s), ${runs[0].date.slice(0, 10)} to ${runs[runs.length - 1].date.slice(0, 10)}`;
    return MEASURES.flatMap(m => {
        const values = runs.map(m.value).filter((v): v is number => v !== undefined);
        return values.length ? [trendNode(m, values, span)] : [];
    });
}

function trendNode(m: Measure, values: number[], span: string): TreeNode {
    const [first, latest] = [values[0], values[values.length - 1]];
    const change = Math.round((latest - first) * 10) / 10;
    const unit = m.unit ?? '';
    const shown = change === 0 ? '=' : `${change > 0 ? '+' : ''}${change}${unit}`;
    return {
        id: `trend:${m.label}`,
        label: m.label,
        description: `${latest}${unit}  ${shown}  ${bars(values)}`,
        tooltip: `${m.label}: ${first}${unit} at the first run, ${latest}${unit} now (${span}).`,
        icon: change === 0 ? 'dash' : change > 0 ? 'arrow-up' : 'arrow-down',
        tone: toneOf(change, m.better)
    };
}

/** Good news (ok) or bad (warning); none when nothing changed. */
function toneOf(change: number, better: Measure['better']): TreeNode['tone'] {
    if (change === 0 || better === 'neither') return undefined;
    return change > 0 === (better === 'up') ? 'ok' : 'warning';
}
