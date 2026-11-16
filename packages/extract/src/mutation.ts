/**
 * Mutation testing of changed lines: does any test notice when a changed line is altered?
 * Coverage says a line ran; a surviving mutant says no test checks what it does.
 *
 * As in Google's code-review mutation testing (Petrović et al., "Practical Mutation Testing at
 * Scale"): at most one mutant per changed line, none on "arid" lines (logging, imports, comments,
 * braces), a cap per run, and only the surviving mutants reported. Each mutant is applied to a
 * temporary copy of the project (dependencies linked), where the project's own tests run.
 */
import type { ProvenflowConfig } from './config.js';
import { detectChecks, runChecks, type CheckCommand } from './buildcheck.js';
import { readSafe } from './fixes.js';
import type { Finding } from './models.js';
import type { ChangedLines } from './review.js';
import { isTestFile } from './scan.js';
import { materialize } from './tools/workspace.js';
import { join } from 'node:path';

export interface Mutant {
    file: string;
    line: number;
    operator: string;
    before: string;
    after: string;
}

export interface MutantResult extends Mutant {
    killed: boolean;
    ms: number;
    /** The test output when a test failed (what killed it). */
    output?: string;
}

export interface MutationRun {
    tests: string[];
    mutants: MutantResult[];
    findings: Finding[];
    /** Killed / tested, in percent. */
    score?: number;
    notes: string[];
}

interface Operator {
    name: string;
    find: RegExp;
    replace: (match: string) => string;
}

const OPERATORS: Operator[] = [
    { name: 'negate equality', find: /===|!==|(?<![=!<>])==(?!=)|!=(?!=)/, replace: m => ({ '===': '!==', '!==': '===', '==': '!=', '!=': '==' })[m]! },
    { name: 'change boundary', find: /<=|>=|(?<=\s)<(?=\s)|(?<=\s)>(?=\s)/, replace: m => ({ '<=': '<', '>=': '>', '<': '<=', '>': '>=' })[m]! },
    { name: 'swap logical operator', find: /&&|\|\||(?<=\s)and(?=\s)|(?<=\s)or(?=\s)/, replace: m => ({ '&&': '||', '||': '&&', and: 'or', or: 'and' })[m]! },
    { name: 'flip boolean', find: /\b(true|false|True|False)\b/, replace: m => ({ true: 'false', false: 'true', True: 'False', False: 'True' })[m]! },
    { name: 'swap arithmetic', find: /(?<=\s)[+-](?=\s)/, replace: m => (m === '+' ? '-' : '+') },
    { name: 'remove negation', find: /!(?=[\w(])/, replace: () => '' }
];

const ARID = /^\s*($|\/\/|#|\/?\*|import\b|from\s+\S+\s+import\b|export\s+\{|package\b|using\b|require\b|[{}()[\];,]+\s*$)|console\.|\bprint(ln|f)?\(|\blog(ger|ging)?\.|System\.(out|err)|fmt\.Print|\bdebug\(/;

/** The line with string contents and trailing comments blanked out, so operators inside them are not mutated. */
function masked(line: string, file: string): string {
    const strings = line.replace(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, (_, quote: string, body: string) => `${quote}${' '.repeat(body.length)}${quote}`);
    const comment = strings.indexOf(/\.(py|rb|r|R|sh)$/.test(file) ? '#' : '//');
    return comment < 0 ? strings : strings.slice(0, comment) + ' '.repeat(strings.length - comment);
}

/** The first mutant an operator can make on a line, if any. */
export function mutateLine(line: string, file: string): { operator: string; after: string } | undefined {
    if (ARID.test(line)) return undefined;
    const visible = masked(line, file);
    for (const op of OPERATORS) {
        const m = op.find.exec(visible);
        if (!m) continue;
        return { operator: op.name, after: line.slice(0, m.index) + op.replace(m[0]) + line.slice(m.index + m[0].length) };
    }
    return undefined;
}

/** Mutants of the changed lines: one per line, lines in `first` before the others, at most `max`. */
export function planMutants(changed: ChangedLines, read: (file: string) => string | undefined, max: number, first: Set<string> = new Set()): Mutant[] {
    const all: Array<Mutant & { priority: boolean }> = [];
    for (const [file, lines] of changed) {
        if (isTestFile(file)) continue;
        const text = read(file);
        if (text === undefined) continue;
        const rows = text.split('\n');
        for (const l of [...lines].sort((a, b) => a - b)) {
            const before = rows[l - 1];
            if (before === undefined) continue;
            const m = mutateLine(before, file);
            if (m) all.push({ file, line: l, operator: m.operator, before, after: m.after, priority: first.has(`${file}:${l}`) });
        }
    }
    // Spread the cap over the files: priority lines first, then round-robin by file.
    const ordered = [...all.filter(m => m.priority), ...roundRobin(all.filter(m => !m.priority))];
    return ordered.slice(0, max).map(({ priority: _p, ...m }) => m);
}

function roundRobin<T extends { file: string }>(items: T[]): T[] {
    const byFile = new Map<string, T[]>();
    for (const i of items) byFile.set(i.file, [...(byFile.get(i.file) ?? []), i]);
    const out: T[] = [];
    for (let k = 0; out.length < items.length; k++) for (const list of byFile.values()) if (list[k]) out.push(list[k]);
    return out;
}

export async function runMutation(root: string, files: string[], changed: ChangedLines, config: ProvenflowConfig, options: { max?: number; test?: string; first?: Set<string>; onMutant?: (m: Mutant, i: number, n: number) => void } = {}): Promise<MutationRun> {
    const notes: string[] = [];
    const settings = config.mutation ?? {};
    const command = options.test ?? settings.test;
    const tests: CheckCommand[] = command ? [{ name: 'tests', command }] : detectChecks(root, files, { ...config, verification: { ...config.verification, test: 'auto' } }).test;
    if (tests.length === 0) return { tests: [], mutants: [], findings: [], notes: ['Mutation testing needs a test command: none was detected (set "mutation": { "test": "..." } in provenflow.config.json, or --test).'] };
    const timeoutSec = settings.timeoutSec ?? 300;
    const read = (f: string) => readSafe(join(root, f));
    const mutants = planMutants(changed, read, options.max ?? settings.max ?? 20, options.first);
    if (mutants.length === 0) return { tests: tests.map(t => t.command), mutants: [], findings: [], notes: ['No changed line could be mutated (only arid lines: logging, imports, comments, braces).'] };
    const clean = await runChecks(root, tests, [], timeoutSec);
    if (!clean.every(r => r.ok)) {
        return { tests: tests.map(t => t.command), mutants: [], findings: [], notes: [`The tests fail without any mutant (${clean.filter(r => !r.ok).map(r => r.name).join(', ')}): fix them before mutation testing.`] };
    }
    const results: MutantResult[] = [];
    for (const [i, m] of mutants.entries()) {
        options.onMutant?.(m, i, mutants.length);
        const text = read(m.file)!;
        const rows = text.split('\n');
        rows[m.line - 1] = m.after;
        const ws = materialize(root, new Map([[m.file, rows.join('\n')]]));
        try {
            const r = await runChecks(ws.dir, tests, [m.file], timeoutSec);
            const failed = r.find(x => !x.ok);
            results.push({ ...m, killed: !!failed, ms: r.reduce((n, x) => n + x.ms, 0), output: failed?.output });
        } finally {
            ws.dispose();
        }
    }
    const findings: Finding[] = results
        .filter(r => !r.killed)
        .map(r => ({
            rule: 'mutant-survived',
            category: 'tests',
            severity: 'warning',
            subject: `${r.file}:${r.operator}`,
            message: `Changing \`${r.before.trim()}\` to \`${r.after.trim()}\` (${r.operator}) leaves every test passing: no test checks what this line does.`,
            fix: 'Add a test whose expectation depends on this line (it should fail with the mutated line and pass with the original).',
            loc: { file: r.file, line: r.line },
            source: 'analysis'
        }));
    const killed = results.filter(r => r.killed).length;
    return { tests: tests.map(t => t.command), mutants: results, findings, score: results.length ? Math.round((killed / results.length) * 100) : undefined, notes };
}
