/**
 * Quality over time: each run of `pflow extract` adds a line of measures to a history file (JSON
 * Lines, default .provenflow/history.jsonl), and `pflow trends` shows how they moved, for one code base
 * or for several (the projects of one owner). Older versions can be measured after the fact from git
 * (`pflow trends --backfill`), so a trend shows from the first day.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProvenflowConfig } from './config.js';
import type { ExtractionResult } from './project.js';

export interface HistoryEntry {
    /** When the measured version was made (the commit's date for a backfilled one), ISO 8601. */
    date: string;
    commit?: string;
    files: number;
    codeLines: number;
    findings: { error: number; warning: number; info: number };
    /** Findings per category. */
    categories: Record<string, number>;
    duplication: { percent: number; clones: number };
    complexity: { mean: number; p90: number; overLimit: number };
    coverage?: number;
    /** Properties nuXmv (or the explicit checker) found false, of all checked. */
    properties: { checked: number; failed: number };
}

export const DEFAULT_HISTORY = join('.provenflow', 'history.jsonl');

/** The history file of a code base: the option, else the config's `history`, else the default; none when the config says false. */
export function historyPath(root: string, config: ProvenflowConfig, option?: string): string | undefined {
    if (option) return resolve(option);
    if (config.history === false) return undefined;
    const file = config.history ?? DEFAULT_HISTORY;
    return isAbsolute(file) ? file : join(root, file);
}

/** The measures of a run. */
export function historyEntry(result: ExtractionResult, date = new Date().toISOString(), commit = headCommit(result.root)): HistoryEntry {
    const m = result.quality.metrics;
    const count = (s: 'error' | 'warning' | 'info') => result.findings.filter(f => f.severity === s).length;
    const categories: Record<string, number> = {};
    for (const f of result.findings) categories[f.category] = (categories[f.category] ?? 0) + 1;
    return {
        date,
        ...(commit ? { commit } : {}),
        files: result.files,
        codeLines: m.codeLines,
        findings: { error: count('error'), warning: count('warning'), info: count('info') },
        categories,
        duplication: { percent: m.duplication.percent, clones: m.duplication.clones },
        complexity: { mean: m.complexity.mean, p90: m.complexity.p90, overLimit: m.complexity.overLimit },
        ...(m.coverage ? { coverage: m.coverage.percent } : {}),
        properties: { checked: result.verdicts.length, failed: result.verdicts.filter(v => v.verdict === 'false').length }
    };
}

/**
 * Adds a run to its code base's history (unless the config turns it off) and returns the history with
 * it, for the report's trends.
 */
export function recordRun(result: ExtractionResult, file = historyPath(result.root, result.config)): HistoryEntry[] {
    if (!file) return [];
    appendHistory(file, historyEntry(result));
    return readHistory(file);
}

export function appendHistory(file: string, entry: HistoryEntry): void {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** The entries of a history file, oldest first (a commit measured twice keeps its latest measure). */
export function readHistory(file: string): HistoryEntry[] {
    if (!existsSync(file)) return [];
    const entries = readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .flatMap(l => {
            try {
                return [JSON.parse(l) as HistoryEntry];
            } catch {
                return [];
            }
        });
    const latest = new Map(entries.map((e, i) => [e.commit ?? `#${i}`, e]));
    return [...latest.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function headCommit(root: string): string | undefined {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Up to `count` commits of the first-parent history, evenly spread over the last `months`, oldest first, with their dates. */
export function commitsToBackfill(root: string, count: number, months = 12): Array<{ commit: string; date: string }> {
    const r = spawnSync('git', ['log', '--first-parent', `--since=${months}.months`, '--format=%h %cI'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return [];
    const all = r.stdout
        .split('\n')
        .filter(Boolean)
        .map(l => {
            const [commit, date] = l.split(' ');
            return { commit, date };
        })
        .reverse();
    if (all.length <= count) return all;
    const step = (all.length - 1) / Math.max(1, count - 1);
    return [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * step)))].map(i => all[i]);
}

// ------------------------------------------------------------------ trends

const BARS = '▁▂▃▄▅▆▇█';

/** A sparkline of values: ▁ the lowest, █ the highest. */
export function sparkline(values: number[]): string {
    const [lo, hi] = [Math.min(...values), Math.max(...values)];
    return values.map(v => BARS[hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * (BARS.length - 1))]).join('');
}

interface Measure {
    label: string;
    value: (e: HistoryEntry) => number | undefined;
    unit?: string;
}

const MEASURES: Measure[] = [
    { label: 'errors', value: e => e.findings.error },
    { label: 'warnings', value: e => e.findings.warning },
    { label: 'duplicated code', value: e => e.duplication.percent, unit: '%' },
    { label: 'complexity, 90th percentile', value: e => e.complexity.p90 },
    { label: 'functions over the complexity limit', value: e => e.complexity.overLimit },
    { label: 'properties false', value: e => e.properties.failed },
    { label: 'line coverage', value: e => e.coverage, unit: '%' },
    { label: 'code lines', value: e => e.codeLines }
];

function change(first: number, last: number, unit = ''): string {
    const d = Math.round((last - first) * 10) / 10;
    return d === 0 ? 'no change' : `${d > 0 ? '+' : ''}${d}${unit}`;
}

/** How the measures of a code base moved over its runs (Markdown lines): first, latest, change and a sparkline each. */
export function trendTable(all: HistoryEntry[], last = 30): string[] {
    const entries = all.slice(-last);
    if (entries.length < 2) {
        return [entries.length ? 'One run measured so far: the trend shows from the next one (or measure older versions with `pflow trends --backfill N`).' : 'No runs measured yet (`pflow extract` adds one; `pflow trends --backfill N` measures older versions).', ''];
    }
    const [first, latest] = [entries[0], entries[entries.length - 1]];
    const rows = MEASURES.flatMap(m => {
        const values = entries.map(m.value).filter((v): v is number => v !== undefined);
        if (values.length < 2) return [];
        const [a, b] = [values[0], values[values.length - 1]];
        return [`| ${m.label} | ${a}${m.unit ?? ''} | ${b}${m.unit ?? ''} | ${change(a, b, m.unit)} | ${sparkline(values)} |`];
    });
    return [`${entries.length} runs, ${first.date.slice(0, 10)} (${first.commit ?? '-'}) to ${latest.date.slice(0, 10)} (${latest.commit ?? '-'}).`, '', '| measure | first | latest | change | trend |', '| --- | --- | --- | --- | --- |', ...rows, ''];
}

/** The trends of one or more code bases (the projects of one owner), as Markdown. */
export function trendsMarkdown(projects: Array<{ name: string; entries: HistoryEntry[] }>, last = 30): string {
    return ['# Quality trends', '', ...projects.flatMap(p => [`## ${p.name}`, '', ...trendTable(p.entries, last)])].join('\n');
}
