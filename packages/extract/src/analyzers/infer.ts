/**
 * Infer (Meta): interprocedural heap analysis (null dereferences, memory and resource leaks,
 * use-after-free...) of C, C++, Objective-C and Java. C/C++ files are captured with
 * `clang -fsyntax-only` (nothing is written in the project); Java with javac into a temporary folder,
 * or with the project's own build (analyzers.infer.build, e.g. "mvn compile").
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Finding } from '../models.js';
import { findTool, run, toolVersion } from '../tools/process.js';
import { emptyOutput, loc, option, type AnalyzerContext, type AnalyzerOutput } from './types.js';

interface InferIssue {
    bug_type: string;
    bug_type_hum?: string;
    qualifier: string;
    severity: string;
    line: number;
    file: string;
    procedure: string;
    bug_trace?: Array<{ filename: string; line_number: number; description: string }>;
}

const MEMORY = /LEAK|USE_AFTER|DANGLING|BUFFER|OVERRUN|UNINITIALIZED|NULL|NIL/;

export async function infer(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = emptyOutput();
    const { on, options } = option(ctx.config.analyzers?.infer, true);
    if (!on) return out;
    const languages = new Set(ctx.facts.modules.filter(m => !m.isTest).map(m => m.language));
    const inScope = (f: string) => !ctx.facts.modules.find(m => m.file === f)?.isTest && (!ctx.onlyFiles || ctx.onlyFiles.includes(f));
    const c = ctx.facts.files.filter(f => /\.(c|cc|cpp|cxx|m|mm)$/.test(f) && inScope(f));
    const java = ctx.facts.files.filter(f => f.endsWith('.java') && inScope(f));
    if (ctx.onlyFiles && options.build) return out; // a whole-project build is not re-run per change
    if (!options.build && c.length === 0 && java.length === 0) return out;
    const exe = findTool('infer', ctx.env);
    if (!exe) {
        out.notes.push(`Infer is not installed (github.com/facebook/infer releases, or set INFER_PATH): no interprocedural heap analysis of ${[...languages].filter(l => ['c', 'cpp', 'java'].includes(l)).join(', ')}.`);
        return out;
    }
    const version = toolVersion(exe);
    const work = mkdtempSync(join(tmpdir(), 'provenflow-infer-'));
    try {
        const captures: Array<{ scope: string; command: string[] }> = [];
        if (options.build) captures.push({ scope: `build: ${options.build}`, command: ['sh', '-c', options.build] });
        else {
            if (c.length > 0) {
                const includes = [...new Set(ctx.facts.files.filter(f => /\.(h|hpp|hh)$/.test(f)).map(f => dirname(f)))].flatMap(d => ['-I', d]);
                captures.push({ scope: `${c.length} C/C++ file(s)`, command: ['clang', '-fsyntax-only', ...includes, ...c] });
            }
            if (java.length > 0) captures.push({ scope: `${java.length} Java file(s)`, command: ['javac', '-d', join(work, 'classes'), '-nowarn', ...java] });
        }
        let index = 0;
        for (const capture of captures) {
            const results = join(work, `results-${index++}`);
            const r = await run(exe, ['run', '--results-dir', results, '--keep-going', '--', ...capture.command], { cwd: ctx.dir, timeoutMs: 900_000 });
            const report = join(results, 'report.json');
            out.ran.push({ tool: 'Infer', version, ms: r.ms, scope: capture.scope, ok: existsSync(report) });
            if (!existsSync(report)) {
                out.notes.push(`Infer (${capture.scope}) did not produce a report: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
                continue;
            }
            for (const issue of JSON.parse(readFileSync(report, 'utf8')) as InferIssue[]) out.findings.push(toFinding(issue));
        }
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
    return out;
}

function toFinding(issue: InferIssue): Finding {
    const kind = issue.bug_type_hum ?? issue.bug_type;
    const trace = (issue.bug_trace ?? []).map(t => ({ state: t.description, loc: loc(t.filename, t.line_number) }));
    return {
        rule: `infer:${issue.bug_type}`,
        category: MEMORY.test(issue.bug_type) ? 'heap' : 'memory',
        severity: issue.severity === 'ERROR' ? 'error' : issue.severity === 'INFO' || issue.severity === 'ADVICE' ? 'info' : 'warning',
        subject: `${issue.procedure}`,
        message: `${kind} in ${issue.procedure}: ${issue.qualifier.replace(/`/g, "'")}`,
        fix: /LEAK/.test(issue.bug_type)
            ? 'Release the resource on every path that leaves the function (free/close/try-with-resources), or return it to a caller that releases it.'
            : /NULL|NIL/.test(issue.bug_type)
              ? 'Check the value for null before using it, or make the callee never return null.'
              : 'Follow the trace: each step names the call or line involved.',
        loc: loc(issue.file, issue.line),
        related: trace.map(t => t.loc),
        counterexample: trace.length > 1 ? trace : undefined,
        source: 'infer'
    };
}
