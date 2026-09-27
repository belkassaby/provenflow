/**
 * Bounded model checking of the code itself, with ESBMC or CBMC (C, C++) and Kani (Rust):
 * memory safety (null and invalid pointers, array bounds, leaks), arithmetic overflow and division
 * by zero, for every input, with loops unwound up to a bound. A function without a failed check
 * is a proof (up to the bound); a failed check is a finding with the counterexample.
 *
 * The same checkers confirm ProvenFlow's state-machine findings on C code: a harness calls the
 * functions of the file in any order and asserts the property on the real global state.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodeProof, Finding } from '../models.js';
import { findTool, run, toolVersion } from '../tools/process.js';
import { emptyOutput, loc, option, type AnalyzerContext, type AnalyzerOutput } from './types.js';

type Checker = { name: 'esbmc' | 'cbmc'; exe: string };

export function bmcChecker(ctx: AnalyzerContext): Checker | undefined {
    const { options } = option(ctx.config.analyzers?.bmc, true);
    const order: Array<'esbmc' | 'cbmc'> = options.tool === 'cbmc' ? ['cbmc', 'esbmc'] : ['esbmc', 'cbmc'];
    for (const name of order) {
        const exe = findTool(name, ctx.env);
        if (exe) return { name, exe };
    }
    return undefined;
}

export async function bmc(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = emptyOutput();
    const { on, options } = option(ctx.config.analyzers?.bmc, true);
    if (!on) return out;
    const sources = ctx.facts.files.filter(f => /\.(c|cc|cpp|cxx)$/.test(f) && !ctx.facts.modules.find(m => m.file === f)?.isTest);
    if (sources.length === 0) return out;
    const checker = bmcChecker(ctx);
    if (!checker) {
        out.notes.push('Neither ESBMC nor CBMC is installed (set ESBMC_PATH or CBMC_PATH): memory safety and overflows of the C/C++ code were not model checked.');
        return out;
    }
    const unwind = options.unwind ?? 8;
    const timeoutSec = options.timeoutSec ?? 30;
    const functions = ctx.facts.functions.filter(f => f.free && sources.includes(f.loc.file) && f.name !== 'main' && (!ctx.onlyFiles || ctx.onlyFiles.includes(f.loc.file))).slice(0, options.maxFunctions ?? 60);
    if (functions.length === 0) return out;
    const version = toolVersion(checker.exe);
    const started = Date.now();
    const queue = [...functions];
    const workers = Array.from({ length: 4 }, async () => {
        for (let fn = queue.shift(); fn; fn = queue.shift()) {
            const group = sources.filter(s => s.replace(/\.[^.]+$/, '') !== '' && (s === fn.loc.file || sameKind(s, fn.loc.file)));
            const result = await checkFunction(checker, ctx.dir, group, includeDirs(ctx), fn.name, unwind, timeoutSec);
            if (result.status === 'proved') out.proofs.push({ tool: checker.name, subject: fn.name, property: 'memory safety, overflow and division by zero', status: 'proved', bound: unwind, loc: fn.loc });
            else if (result.status === 'unknown') out.proofs.push({ tool: checker.name, subject: fn.name, property: 'memory safety, overflow and division by zero', status: 'unknown', bound: unwind, loc: fn.loc, detail: result.detail });
            else {
                out.proofs.push({ tool: checker.name, subject: fn.name, property: 'memory safety, overflow and division by zero', status: 'refuted', bound: unwind, loc: fn.loc, detail: result.failures.map(f => f.description).join('; ') });
                for (const f of result.failures) out.findings.push(failureFinding(checker.name, fn.name, f, unwind));
            }
        }
    });
    await Promise.all(workers);
    out.ran.push({ tool: checker.name === 'esbmc' ? 'ESBMC' : 'CBMC', version, ms: Date.now() - started, scope: `${functions.length} C/C++ function(s), loops unwound ${unwind} times`, ok: true });
    return out;
}

export interface Failure {
    description: string;
    property: string;
    file: string;
    line: number;
    trace: Array<{ state: string; file?: string; line?: number }>;
}

export interface FunctionResult {
    status: 'proved' | 'refuted' | 'unknown';
    failures: Failure[];
    detail?: string;
}

function sameKind(a: string, b: string): boolean {
    const cpp = (f: string) => /\.(cc|cpp|cxx)$/.test(f);
    return cpp(a) === cpp(b);
}

function includeDirs(ctx: AnalyzerContext): string[] {
    return [...new Set(ctx.facts.files.filter(f => /\.(h|hpp|hh)$/.test(f)).map(f => dirname(f)))];
}

export async function checkFunction(checker: Checker, cwd: string, files: string[], includes: string[], fn: string, unwind: number, timeoutSec: number): Promise<FunctionResult> {
    const inc = includes.flatMap(d => ['-I', d]);
    if (checker.name === 'cbmc') {
        const args = [...files, ...inc, '--function', fn, '--bounds-check', '--pointer-check', '--signed-overflow-check', '--div-by-zero-check', '--memory-leak-check', '--unwind', String(unwind), '--no-unwinding-assertions', '--json-ui', '--trace'];
        const r = await run(checker.exe, args, { cwd, timeoutMs: timeoutSec * 1000 });
        return r.timedOut ? { status: 'unknown', failures: [], detail: `no answer within ${timeoutSec} s` } : parseCbmcJson(r.stdout);
    }
    const args = [...files, ...inc, '--function', fn, '--unwind', String(unwind), '--no-unwinding-assertions', '--overflow-check', '--memory-leak-check', '--timeout', `${timeoutSec}s`];
    const r = await run(checker.exe, args, { cwd, timeoutMs: (timeoutSec + 10) * 1000 });
    return r.timedOut ? { status: 'unknown', failures: [], detail: `no answer within ${timeoutSec} s` } : parseEsbmc(`${r.stdout}\n${r.stderr}`);
}

/** CBMC --json-ui --trace output. */
export function parseCbmcJson(stdout: string): FunctionResult {
    let messages: Array<{ result?: Array<{ description: string; property: string; status: string; sourceLocation?: { file?: string; line?: string }; trace?: Array<{ stepType?: string; lhs?: string; value?: { data?: string }; sourceLocation?: { file?: string; line?: string } }> }> ; cProverStatus?: string; messageText?: string }>;
    try {
        messages = JSON.parse(stdout);
    } catch {
        return { status: 'unknown', failures: [], detail: stdout.trim().split('\n').slice(-2).join(' ') };
    }
    const results = messages.flatMap(m => m.result ?? []);
    if (results.length === 0) return { status: 'unknown', failures: [], detail: messages.map(m => m.messageText).filter(Boolean).slice(-1)[0] };
    const failures = results
        .filter(r => r.status === 'FAILURE')
        .map(r => ({
            description: r.description,
            property: r.property,
            file: r.sourceLocation?.file ?? '',
            line: Number(r.sourceLocation?.line ?? 1),
            trace: (r.trace ?? []).filter(s => s.stepType === 'assignment' && s.lhs && !s.lhs.startsWith('__CPROVER')).slice(-12).map(s => ({ state: `${s.lhs} = ${s.value?.data ?? '?'}`, file: s.sourceLocation?.file, line: s.sourceLocation?.line ? Number(s.sourceLocation.line) : undefined }))
        }));
    return { status: failures.length ? 'refuted' : 'proved', failures };
}

/** ESBMC text output: "Violated property:" blocks, the counterexample states, and the verdict. */
export function parseEsbmc(output: string): FunctionResult {
    if (/VERIFICATION SUCCESSFUL/.test(output)) return { status: 'proved', failures: [] };
    if (!/VERIFICATION FAILED/.test(output)) return { status: 'unknown', failures: [], detail: output.trim().split('\n').filter(Boolean).slice(-2).join(' ') };
    const trace: Failure['trace'] = [];
    for (const m of output.matchAll(/State \d+ file (\S+) line (\d+)[^\n]*\n-+\n\s*([^\n]+)/g)) trace.push({ state: m[3].trim(), file: m[1], line: Number(m[2]) });
    const failures: Failure[] = [];
    for (const m of output.matchAll(/Violated property:\s*\n\s*file (\S+) line (\d+)[^\n]*\n\s*([^\n]+)/g)) {
        failures.push({ description: m[3].trim(), property: m[3].trim(), file: m[1], line: Number(m[2]), trace: trace.slice(-12) });
    }
    return { status: 'refuted', failures: failures.length ? failures : [{ description: 'a check failed', property: 'unknown', file: '', line: 1, trace }] };
}

function failureFinding(tool: 'esbmc' | 'cbmc', fn: string, f: Failure, unwind: number): Finding {
    const kind = /null|dereference|pointer/i.test(f.description)
        ? 'invalid-pointer'
        : /bound|array|upper|lower/i.test(f.description)
          ? 'out-of-bounds'
          : /overflow/i.test(f.description)
            ? 'arithmetic-overflow'
            : /division|zero/i.test(f.description)
              ? 'division-by-zero'
              : /leak|forgotten memory|memory-leak/i.test(f.description)
                ? 'memory-leak'
                : 'check-failed';
    return {
        rule: `${tool}:${kind}`,
        category: 'memory',
        severity: kind === 'memory-leak' ? 'warning' : 'error',
        subject: fn,
        message: `${f.description} in ${fn} (found by ${tool.toUpperCase()} for some input; loops unwound ${unwind} times).`,
        fix:
            kind === 'invalid-pointer'
                ? 'Check the pointer before dereferencing it, or make the callers guarantee it is valid (and document it).'
                : kind === 'out-of-bounds'
                  ? 'Check the index against the size before the access.'
                  : kind === 'arithmetic-overflow'
                    ? 'Check the operands before the operation (or use a wider type / checked arithmetic).'
                    : kind === 'division-by-zero'
                      ? 'Check the divisor is not zero.'
                      : kind === 'memory-leak'
                        ? 'Free the allocation on every path out of the function.'
                        : 'Follow the counterexample.',
        loc: loc(f.file, f.line),
        related: f.trace.filter(t => t.file).map(t => loc(t.file!, t.line)),
        counterexample: f.trace.length ? f.trace.map(t => ({ state: t.state, loc: t.file ? loc(t.file, t.line) : undefined })) : undefined,
        source: tool
    };
}

/**
 * Checks a ProvenFlow finding on the C code: `state` never takes `value`, over up to `steps` calls
 * of the file's parameterless functions in any order. proved -> the finding is confirmed on the
 * code (up to the bound); refuted -> the code does reach it (the model missed a transition).
 */
export async function confirmUnreachableInC(ctx: AnalyzerContext, file: string, variable: string, value: string, functions: string[], steps = 6): Promise<{ status: 'confirmed' | 'refuted' | 'unknown'; detail: string } | undefined> {
    const checker = bmcChecker(ctx);
    if (!checker || functions.length === 0) return undefined;
    const work = mkdtempSync(join(tmpdir(), 'provenflow-harness-'));
    try {
        const text = readFileSync(join(ctx.dir, file), 'utf8');
        const calls = functions.map((f, i) => `case ${i}: ${f}(); break;`).join(' ');
        const harness = `${text}\n\n/* ProvenFlow harness: any sequence of calls, the property checked after each. */\nint nondet_int(void);\nvoid __pflow_harness(void) {\n    for (int __i = 0; __i < ${steps}; __i++) {\n        switch (nondet_int()) { ${calls} default: break; }\n        __pflow_check(${variable} != ${value});\n    }\n}\n`;
        const withCheck = harness.replace('/* ProvenFlow harness', `#include <assert.h>\n#define __pflow_check(c) assert(c)\n/* ProvenFlow harness`);
        const target = join(work, file.split('/').pop()!);
        writeFileSync(target, withCheck);
        const others = ctx.facts.files.filter(f => f !== file && /\.c$/.test(f)).map(f => join(ctx.dir, f)).filter(existsSync);
        const includes = [dirname(join(ctx.dir, file)), ...[...new Set(ctx.facts.files.filter(f => f.endsWith('.h')).map(f => join(ctx.dir, dirname(f))))]];
        const r = await checkFunction(checker, work, [target, ...others], includes, '__pflow_harness', steps + 2, 60);
        if (r.status === 'proved') return { status: 'confirmed', detail: `${checker.name.toUpperCase()} proved on the code that ${variable} never becomes ${value} over ${steps} calls of ${functions.join(', ')} in any order.` };
        if (r.status === 'refuted') {
            const assertion = r.failures.find(f => /assert|assertion/i.test(f.description) || f.description.includes(variable));
            if (assertion) return { status: 'refuted', detail: `${checker.name.toUpperCase()} found a sequence of calls reaching ${value} on the code: the model missed a transition.` };
            return { status: 'unknown', detail: `The harness hit another failure first: ${r.failures[0]?.description}` };
        }
        return { status: 'unknown', detail: r.detail ?? 'no verdict' };
    } catch (error) {
        return { status: 'unknown', detail: (error as Error).message };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

/** Kani (Rust): `cargo kani autoharness` checks every function it can generate inputs for. */
export async function kani(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = emptyOutput();
    if (ctx.config.analyzers?.kani === false) return out;
    const crates = [...new Set(ctx.facts.files.filter(f => f.endsWith('.rs') && (!ctx.onlyFiles || ctx.onlyFiles.includes(f))).map(f => crateOf(ctx.dir, f)).filter((x): x is string => x !== undefined))];
    if (crates.length === 0) return out;
    const cargo = findTool('cargo', ctx.env);
    const kaniExe = findTool('cargo-kani', ctx.env) ?? findTool('kani', ctx.env);
    if (!cargo || !kaniExe) {
        out.notes.push('Kani is not installed (cargo install --locked kani-verifier; cargo kani setup): the Rust code was not model checked.');
        return out;
    }
    for (const crate of crates) {
        const r = await run(cargo, ['kani', 'autoharness', '-Z', 'autoharness'], { cwd: join(ctx.dir, crate), timeoutMs: 1_800_000 });
        const parsed = parseKani(`${r.stdout}\n${r.stderr}`, crate);
        out.proofs.push(...parsed.proofs);
        out.findings.push(...parsed.findings);
        out.ran.push({ tool: 'Kani', version: toolVersion(kaniExe), ms: r.ms, scope: `crate ${crate || '.'}`, ok: r.code === 0 || parsed.proofs.length > 0 });
    }
    return out;
}

function crateOf(dir: string, file: string): string | undefined {
    let d = dirname(file);
    while (true) {
        if (existsSync(join(dir, d, 'Cargo.toml'))) return d === '.' ? '' : d;
        if (d === '.' || d === '') return existsSync(join(dir, 'Cargo.toml')) ? '' : undefined;
        d = dirname(d);
    }
}

/** Kani's output: one block per harness, "VERIFICATION:- SUCCESSFUL|FAILED", and the failed checks. */
export function parseKani(output: string, crate: string): { proofs: CodeProof[]; findings: Finding[] } {
    const proofs: CodeProof[] = [];
    const findings: Finding[] = [];
    const blocks = output.split(/Checking harness /).slice(1);
    for (const block of blocks) {
        const harness = block.split(/\.\.\.|\n/)[0].trim();
        const fn = harness.replace(/^kani::internal_autoharness_|^autoharness_/, '').replace(/::.*$/, '') || harness;
        const ok = /VERIFICATION:-\s*SUCCESSFUL/.test(block);
        proofs.push({ tool: 'kani', subject: fn, property: 'panics, overflow, memory safety', status: ok ? 'proved' : /VERIFICATION:-\s*FAILED/.test(block) ? 'refuted' : 'unknown' });
        if (!ok) {
            for (const m of block.matchAll(/Failed Checks:\s*([^\n]+)\n\s*File: "([^"]+)", line (\d+)/g)) {
                findings.push({ rule: 'kani:check-failed', category: 'memory', severity: 'error', subject: fn, message: `${m[1].trim()} in ${fn} (found by Kani for some input).`, fix: 'Guard the operation (checked arithmetic, bounds check, Option handling) or document the precondition with a contract.', loc: loc(join(crate, m[2]).replace(/^\//, ''), Number(m[3])), source: 'kani' });
            }
        }
    }
    return { proofs, findings };
}
