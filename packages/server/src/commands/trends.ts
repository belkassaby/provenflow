/** `pflow trends`: how a code base's quality moved over its runs, or the trends of several (the projects of one owner). */
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { appendHistory, baseOverrides, commitsToBackfill, extractProject, historyEntry, historyPath, loadConfig, mapProjects, readHistory, trendsMarkdown, type HistoryEntry } from '@provenflow/extract';
import type { Values } from './shared.js';

const DEFAULT_LAST = 30;

export async function trendsCommand(values: Values, dirs: string[]): Promise<number> {
    const roots = withOwnersProjects(dirs.length ? dirs.map(d => resolve(d)) : [resolve('.')], values);
    const projects: Array<{ name: string; entries: HistoryEntry[] }> = [];
    for (const root of roots) {
        const file = historyPath(root, loadConfig(root, values.config), roots.length === 1 ? values.history : undefined);
        if (!file) continue;
        if (values.backfill) await backfill(root, file, Number(values.backfill), values);
        projects.push({ name: basename(root), entries: readHistory(file) });
    }
    const text = values.json ? `${JSON.stringify(projects, null, 2)}\n` : trendsMarkdown(projects, values.last ? Number(values.last) : DEFAULT_LAST);
    if (values.output) writeFileSync(values.output, text);
    else process.stdout.write(text);
    return 0;
}

/** --projects: the projects around the first code base with the same owner (as pflow c4 maps them), besides those given. */
function withOwnersProjects(roots: string[], values: Values): string[] {
    if (!values.projects) return roots;
    const map = mapProjects(roots[0], { sources: false });
    return [...new Set([...roots, ...map.projects.filter(p => p.owned).map(p => p.dir)])];
}

/** Measures up to `count` older commits of the code base (spread over the last year) that the history does not have yet. */
async function backfill(root: string, file: string, count: number, values: Values): Promise<void> {
    const known = new Set(readHistory(file).map(e => e.commit));
    const commits = commitsToBackfill(root, count).filter(c => !known.has(c.commit));
    for (const [i, c] of commits.entries()) {
        if (!values.quiet) console.error(`Measuring ${basename(root)} at ${c.commit} (${c.date.slice(0, 10)}), ${i + 1} of ${commits.length}…`);
        const result = await extractProject(root, { configFile: values.config, overrides: baseOverrides(root, c.commit), analyzers: false, confirm: false, quickFixes: 0 });
        appendHistory(file, historyEntry(result, c.date, c.commit));
    }
}
