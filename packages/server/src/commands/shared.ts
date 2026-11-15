/** What the `pflow` commands share: the parsed options, the nuXmv checker, progress on the terminal. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Checker, Progress } from '@provenflow/extract';
import { configFromEnv, nuxmvInfo, runNuxmv, type Engine } from '../nuxmv-runner.js';

export const OPTIONS = {
    output: { type: 'string', short: 'o' },
    engine: { type: 'string', default: 'bdd' },
    bound: { type: 'string', default: '10' },
    help: { type: 'boolean', short: 'h' },
    verify: { type: 'boolean', default: false },
    reach: { type: 'string', multiple: true },
    within: { type: 'string' },
    steps: { type: 'string', multiple: true },
    visits: { type: 'string' },
    until: { type: 'string' },
    config: { type: 'string' },
    'fail-on': { type: 'string', default: 'error' },
    llm: { type: 'string' },
    'llm-fixes': { type: 'string', default: '0' },
    fix: { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
    base: { type: 'string' },
    files: { type: 'boolean', default: false },
    github: { type: 'boolean', default: false },
    'github-out': { type: 'string' },
    'check-run': { type: 'boolean', default: false },
    state: { type: 'string' },
    'no-analyzers': { type: 'boolean', default: false },
    analyzers: { type: 'boolean', default: false },
    'no-confirm': { type: 'boolean', default: false },
    coverage: { type: 'string', multiple: true },
    baseline: { type: 'string' },
    'no-baseline': { type: 'boolean', default: false },
    'new-only': { type: 'boolean', default: false },
    mutate: { type: 'string' },
    test: { type: 'string' },
    max: { type: 'string' },
    before: { type: 'string' },
    update: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    instructions: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }
} as const;

export function parse(argv: string[]) {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
}

export type Values = ReturnType<typeof parse>['values'];

/** nuXmv when NUXMV_PATH (or PATH) has it; otherwise the explicit-state checker is used. */
export async function nuxmvChecker(values: Values): Promise<{ checker?: Checker; available: boolean }> {
    const nuxmv = configFromEnv();
    const available = (await nuxmvInfo(nuxmv)).available;
    return { available, checker: available ? (smv: string) => runNuxmv(smv, { engine: values.engine as Engine, bound: Number(values.bound) }, nuxmv) : undefined };
}

/** A progress line on the terminal (stderr), rewritten in place; nothing when stderr is not a terminal. */
export function terminalProgress(): ((p: Progress) => void) | undefined {
    if (!process.stderr.isTTY) return undefined;
    return p => {
        const line = `[${String(p.percent).padStart(3)}%] ${p.message}`;
        process.stderr.write(`\r\x1b[K${line.slice(0, (process.stderr.columns || 100) - 1)}`);
    };
}

export function clearProgress(): void {
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
}

/** The base of the pull request in a GitHub Actions run. */
export function githubBase(): string | undefined {
    try {
        const path = process.env['GITHUB_EVENT_PATH'];
        const event = path ? (JSON.parse(readFileSync(path, 'utf8')) as { pull_request?: { base?: { sha?: string } } }) : undefined;
        return event?.pull_request?.base?.sha;
    } catch {
        return undefined;
    }
}

export function failOnLevel(values: Values): 'error' | 'warning' | 'info' | 'none' {
    const v = values['fail-on'];
    if (v === 'error' || v === 'warning' || v === 'info' || v === 'none') return v;
    throw new Error(`--fail-on must be error, warning, info or none (not ${v}).`);
}
