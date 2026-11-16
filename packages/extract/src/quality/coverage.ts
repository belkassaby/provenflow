/**
 * Test coverage, read from the reports the project's own test run writes (ProvenFlow does not run
 * the tests for this): LCOV (`lcov.info`: Jest, Vitest, c8, nyc, gcov/lcov, cargo-llvm-cov),
 * Cobertura XML (coverage.py, pytest-cov, gcovr, .NET coverlet) and JaCoCo XML (Java, Kotlin).
 *
 * Used for: changed lines that no test runs (`uncovered-change`, in a review), complex functions no
 * test runs at all (`untested-complex-function`), and the coverage figure of the quality metrics.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { FunctionFact } from '../ir.js';
import type { Finding } from '../models.js';
import { functionLabel } from './duplication.js';

/** Hits per executable line, per project file. */
export type Coverage = Map<string, Map<number, number>>;

export function readCoverage(root: string, reports: string[], files: string[]): { coverage: Coverage; notes: string[] } {
    const coverage: Coverage = new Map();
    const notes: string[] = [];
    for (const report of reports) {
        const path = isAbsolute(report) ? report : join(root, report);
        if (!existsSync(path)) {
            notes.push(`Coverage report ${report} not found: run the tests with coverage first.`);
            continue;
        }
        const parsed = parseReport(readFileSync(path, 'utf8'));
        const matched = [...parsed].filter(([file, lines]) => merge(coverage, toProjectFile(root, file, files), lines)).length;
        if (parsed.size > 0 && matched === 0) notes.push(`Coverage report ${report}: none of its ${parsed.size} file(s) matched a source file of the project (check the paths it records).`);
    }
    return { coverage, notes };
}

/** A report in whichever of the three formats it is. */
export function parseReport(text: string): Map<string, Map<number, number>> {
    if (text.includes('<coverage') && text.includes('<class')) return parseCobertura(text);
    if (text.includes('<report') && text.includes('<sourcefile')) return parseJacoco(text);
    return parseLcov(text);
}

/** Adds a file's hits (the highest per line, when several reports cover it); false when the file is not the project's. */
function merge(coverage: Coverage, file: string | undefined, lines: Map<number, number>): boolean {
    if (!file) return false;
    const into = coverage.get(file) ?? new Map<number, number>();
    for (const [line, hits] of lines) into.set(line, Math.max(into.get(line) ?? 0, hits));
    coverage.set(file, into);
    return true;
}

export function parseLcov(text: string): Map<string, Map<number, number>> {
    const out = new Map<string, Map<number, number>>();
    let current: Map<number, number> | undefined;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('SF:')) {
            const file = line.slice(3);
            current = out.get(file) ?? new Map();
            out.set(file, current);
        } else if (line.startsWith('DA:') && current) {
            const [n, hits] = line.slice(3).split(',');
            current.set(Number(n), Number(hits));
        } else if (line === 'end_of_record') current = undefined;
    }
    return out;
}

export function parseCobertura(text: string): Map<string, Map<number, number>> {
    const out = new Map<string, Map<number, number>>();
    const sources = [...text.matchAll(/<source>([^<]*)<\/source>/g)].map(m => m[1].trim());
    for (const cls of text.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
        const file = sources.length === 1 && !isAbsolute(cls[1]) ? join(sources[0], cls[1]) : cls[1];
        const lines = out.get(file) ?? new Map<number, number>();
        for (const l of cls[2].matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) lines.set(Number(l[1]), Math.max(lines.get(Number(l[1])) ?? 0, Number(l[2])));
        out.set(file, lines);
    }
    return out;
}

export function parseJacoco(text: string): Map<string, Map<number, number>> {
    const out = new Map<string, Map<number, number>>();
    for (const pkg of text.matchAll(/<package\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g)) {
        for (const sf of pkg[2].matchAll(/<sourcefile\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g)) {
            const lines = new Map<number, number>();
            for (const l of sf[2].matchAll(/<line\b[^>]*\bnr="(\d+)"[^>]*\bmi="(\d+)"[^>]*\bci="(\d+)"/g)) lines.set(Number(l[1]), Number(l[3]));
            out.set(pkg[1] ? `${pkg[1]}/${sf[1]}` : sf[1], lines);
        }
    }
    return out;
}

/** The project file a report's path stands for: relative to the root, or the file it ends with. */
function toProjectFile(root: string, file: string, files: string[]): string | undefined {
    const normalized = file.split('\\').join('/');
    const rel = isAbsolute(normalized) ? relative(root, normalized).split('\\').join('/') : normalized.replace(/^\.\//, '');
    if (files.includes(rel)) return rel;
    const candidates = files.filter(f => f.endsWith(`/${rel}`) || rel.endsWith(`/${f}`));
    return candidates.length === 1 ? candidates[0] : candidates.sort((a, b) => b.length - a.length)[0];
}

export function coveredShare(coverage: Coverage): { covered: number; total: number; percent: number } {
    let covered = 0;
    let total = 0;
    for (const lines of coverage.values()) {
        for (const hits of lines.values()) {
            total++;
            if (hits > 0) covered++;
        }
    }
    return { covered, total, percent: total ? Math.round((covered / total) * 1000) / 10 : 0 };
}

/** Executable lines of a function, and how many a test ran (undefined: its file is not in the report). */
export function functionCoverage(coverage: Coverage, f: FunctionFact): { covered: number; total: number } | undefined {
    const lines = coverage.get(f.loc.file);
    if (!lines) return undefined;
    let covered = 0;
    let total = 0;
    for (let l = f.loc.line; l < f.loc.line + f.lines; l++) {
        const hits = lines.get(l);
        if (hits === undefined) continue;
        total++;
        if (hits > 0) covered++;
    }
    return { covered, total };
}

/** Functions above half the complexity limit that no test runs. */
export function untestedComplexFunctions(coverage: Coverage, functions: FunctionFact[], cognitiveLimit: (f: FunctionFact) => number): Finding[] {
    const findings: Finding[] = [];
    for (const f of functions) {
        const limit = cognitiveLimit(f);
        if (!f.complexity || f.complexity.cognitive < Math.ceil(limit / 2)) continue;
        const c = functionCoverage(coverage, f);
        if (!c || c.total === 0 || c.covered > 0) continue;
        const name = functionLabel(f);
        findings.push({
            rule: 'untested-complex-function',
            category: 'tests',
            severity: 'info',
            subject: name,
            message: `No test runs ${name} (Cognitive Complexity ${f.complexity.cognitive}, ${c.total} executable lines, 0 covered): a change to it is not checked by anything.`,
            fix: `Add a test that calls ${name} on its main paths (each branch of its conditions).`,
            loc: f.loc,
            endLine: f.loc.line + f.lines - 1,
            source: 'analysis',
            measure: { name: 'covered lines', value: 0, limit: c.total }
        });
    }
    return findings;
}

/**
 * Changed lines no test runs, grouped by function (or by contiguous block outside functions).
 * Lines that are not executable (absent from the report) are ignored.
 */
export function uncoveredChanges(coverage: Coverage, changed: Map<string, Set<number>>, functions: FunctionFact[], severity: Finding['severity'] = 'warning'): { findings: Finding[]; unmeasured: string[] } {
    const findings: Finding[] = [];
    const unmeasured: string[] = [];
    for (const [file, lines] of changed) {
        const hits = coverage.get(file);
        if (hits) findings.push(...uncoveredIn(file, [...lines].filter(l => hits.get(l) === 0), functions, severity));
        else if (functions.some(f => f.loc.file === file)) unmeasured.push(file);
    }
    return { findings, unmeasured };
}

function uncoveredIn(file: string, uncovered: number[], functions: FunctionFact[], severity: Finding['severity']): Finding[] {
    const groups = new Map<string, { fn?: FunctionFact; lines: number[] }>();
    for (const l of uncovered.sort((a, b) => a - b)) {
        const fn = functions.filter(f => f.loc.file === file && f.loc.line <= l && f.loc.line + f.lines > l).sort((a, b) => a.lines - b.lines)[0];
        const key = fn?.id ?? `block-${file}`;
        const g = groups.get(key) ?? { fn, lines: [] };
        g.lines.push(l);
        groups.set(key, g);
    }
    return [...groups.values()].map(g => {
        const name = g.fn ? functionLabel(g.fn) : file;
        const paths = g.fn?.complexity && g.fn.complexity.cyclomatic > 1 ? ` (its ${g.fn.complexity.cyclomatic} paths)` : '';
        return {
            rule: 'uncovered-change',
            category: 'tests',
            severity,
            subject: name,
            message: `${g.lines.length} changed line(s) of ${name} run in no test (${toRanges(g.lines)}).`,
            fix: `Add or extend a test so that it runs ${name} through the changed lines${paths}.`,
            loc: { file, line: g.lines[0] },
            endLine: g.lines[g.lines.length - 1],
            source: 'analysis',
            measure: { name: 'uncovered changed lines', value: g.lines.length, limit: 0 }
        };
    });
}

function toRanges(lines: number[]): string {
    const out: string[] = [];
    let start = lines[0];
    let prev = lines[0];
    for (const l of [...lines.slice(1), Number.NaN]) {
        if (l === prev + 1) {
            prev = l;
            continue;
        }
        out.push(start === prev ? `line ${start}` : `lines ${start}-${prev}`);
        start = prev = l;
    }
    return out.join(', ');
}
