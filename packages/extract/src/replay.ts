/**
 * Replays counterexamples on the real code (TypeScript/JavaScript with tsx, Python with python3):
 * the class is instantiated, the methods of the counterexample are called in order (arguments are
 * permissive stand-ins), and the real field is compared with the state the model predicts. A write
 * after an await is replayed as the interleaving it stands for: the async method is started, another
 * method changes the state while it waits, and the replay checks whether that change is lost.
 *
 * confirmed: the code does it; refuted: the code does not (the model is coarser than the code, e.g.
 * a condition on another variable); unknown: the replay could not run (constructor needs real
 * dependencies, framework-only code...).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Facts } from './ir.js';
import type { Confirmation, ExtractedModel, Finding } from './models.js';
import { findTool, run } from './tools/process.js';

interface Plan {
    file: string;
    className: string;
    field: string;
    /** Methods to call, in order; `start` starts an async method without waiting for it. */
    steps: Array<{ method: string; mode: 'call' | 'start' | 'finish' }>;
    /** What proves the finding: the final value, or running timers. */
    expect: { value?: string; lostValue?: string; timersAtLeast?: number };
}

const TS = /\.(ts|tsx|mts|cts|js|mjs)$/;

export async function confirmFindings(findings: Finding[], models: ExtractedModel[], facts: Facts, root: string, limit = 12): Promise<Finding[]> {
    const out: Finding[] = [];
    let done = 0;
    for (const f of findings) {
        const plan = done < limit ? planFor(f, models, facts) : undefined;
        if (!plan) {
            out.push(f);
            continue;
        }
        done++;
        const confirmation = await replay(plan, root);
        out.push(confirmation ? { ...f, confirmation } : f);
    }
    return out;
}

function planFor(f: Finding, models: ExtractedModel[], facts: Facts): Plan | undefined {
    const model = models.find(m => m.id === f.model);
    if (!model) return undefined;
    const variable = facts.stateVariables.find(v => v.id === model.variableId);
    // State machine findings with a counterexample: the calls of the counterexample.
    if (variable && variable.owner && f.counterexample && f.counterexample.length > 1 && (TS.test(variable.loc.file) || variable.loc.file.endsWith('.py'))) {
        const steps = f.counterexample
            .map(s => s.event?.replace(/ \(callback\)$/, '').replace(/ \[llm\]$/, ''))
            .filter((e): e is string => !!e && e.startsWith(`${variable.owner}.`))
            .map(e => ({ method: e.slice(variable.owner!.length + 1), mode: 'call' as const }));
        if (steps.length === 0 || steps.some(s => /\s|template|constructor/.test(s.method))) return undefined;
        return { file: variable.loc.file, className: variable.owner, field: variable.name.slice(variable.owner.length + 1), steps, expect: { value: f.counterexample[f.counterexample.length - 1].state } };
    }
    // A write after an await: bring the state to what the method checks, start it, let another method write, finish it.
    if (f.rule === 'stale-write-after-await' && variable?.owner && TS.test(variable.loc.file) && f.loc) {
        const write = facts.writes.find(w => w.loc.file === f.loc!.file && w.loc.line === f.loc!.line);
        const method = write?.event.split('.').pop();
        const before = write?.sources?.[0];
        const target = write?.targets?.[0];
        if (!write || !method || !before || !target) return undefined;
        const path = pathTo(model, before, variable.initial[0]);
        const other = facts.writes.find(w => w.variable === variable.id && w.event !== write.event && !w.afterAwait && w.targets?.length && !w.targets.includes(target) && (!w.sources || w.sources.includes(before)));
        const otherMethod = other?.event.split('.').pop();
        if (!path || !otherMethod || /\s/.test(otherMethod)) return undefined;
        return {
            file: variable.loc.file,
            className: variable.owner,
            field: variable.name.slice(variable.owner.length + 1),
            steps: [...path.map(m => ({ method: m, mode: 'call' as const })), { method, mode: 'start' }, { method: otherMethod, mode: 'call' }, { method, mode: 'finish' }],
            expect: { value: target, lostValue: other!.targets![0] }
        };
    }
    // A timer acquired twice: start it twice and count the timers still running.
    if (f.rule === 'resource-leak' && f.counterexample && TS.test(f.loc?.file ?? '') && /interval|timeout/.test(f.subject)) {
        const cls = f.subject.split(' ')[0];
        const steps = f.counterexample.map(s => s.event).filter((e): e is string => !!e && e.startsWith(`${cls}.`) && !/discarded/.test(e)).map(e => ({ method: e.slice(cls.length + 1), mode: 'call' as const }));
        if (steps.length < 2) return undefined;
        return { file: f.loc!.file, className: cls, field: '', steps, expect: { timersAtLeast: 2 } };
    }
    return undefined;
}

/** Methods leading from the initial state to `value` in the model (shortest path, single-owner events). */
function pathTo(model: ExtractedModel, value: string, initial: string | undefined): string[] | undefined {
    const idOf = (v: string) => Object.entries(model.values).find(([, x]) => x === v)?.[0] ?? v;
    const start = initial ? idOf(initial) : model.model.states.find(s => s.initial)?.name;
    const goal = idOf(value);
    if (!start) return undefined;
    const queue: Array<{ state: string; path: string[] }> = [{ state: start, path: [] }];
    const seen = new Set([start]);
    while (queue.length) {
        const { state, path } = queue.shift()!;
        if (state === goal) return path;
        for (const t of model.model.transitions.filter(x => x.source === state && x.target !== state)) {
            const event = model.evidence[`${t.source}->${t.target}`]?.[0]?.event;
            const method = event?.split('.').pop();
            if (!method || /\s/.test(method) || seen.has(t.target)) continue;
            seen.add(t.target);
            queue.push({ state: t.target, path: [...path, method] });
        }
    }
    return undefined;
}

async function replay(plan: Plan, root: string): Promise<Confirmation | undefined> {
    const work = mkdtempSync(join(tmpdir(), 'provenflow-replay-'));
    try {
        if (plan.file.endsWith('.py')) return await replayPython(plan, root, work);
        return await replayTypeScript(plan, root, work);
    } catch (error) {
        return { by: 'replay', status: 'unknown', detail: (error as Error).message.slice(0, 200) };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

async function replayTypeScript(plan: Plan, root: string, work: string): Promise<Confirmation | undefined> {
    const tsx = tsxBinary(root);
    if (!tsx) return { by: 'replay', status: 'unknown', detail: 'tsx is not available to run TypeScript.' };
    const script = `
const any: any = new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => 0 : p === Symbol.iterator ? function* () {} : any),
    apply: () => any,
    construct: () => any
});
const running = new Set<unknown>();
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval, realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
(globalThis as any).setInterval = (..._a: unknown[]) => { const h = realSetInterval(() => undefined, 1e9); running.add(h); return h; };
(globalThis as any).clearInterval = (h: any) => { running.delete(h); realClearInterval(h); };
(globalThis as any).setTimeout = (f: any, ms?: number, ...a: unknown[]) => { if ((ms ?? 0) > 50) { const h = realSetTimeout(() => undefined, 1e9); running.add(h); return h; } return realSetTimeout(f, ms, ...a); };
(globalThis as any).clearTimeout = (h: any) => { running.delete(h); realClearTimeout(h); };
const result: { values: unknown[]; error?: string } = { values: [] };
try {
    const mod: any = await import(${JSON.stringify(resolve(root, plan.file))});
    const C = mod[${JSON.stringify(plan.className)}];
    if (typeof C !== 'function') throw new Error('class ${plan.className} is not exported');
    const o: any = new C(...Array(C.length).fill(any));
    const read = () => { if (!${JSON.stringify(plan.field)}) return undefined; const v = o[${JSON.stringify(plan.field)}]; return typeof v === 'function' ? v.call(o) : v; };
    const pending: Record<string, Promise<unknown>> = {};
    for (const step of ${JSON.stringify(plan.steps)}) {
        if (step.mode === 'finish') { await pending[step.method]; result.values.push(read()); continue; }
        const f = o[step.method];
        if (typeof f !== 'function') throw new Error('no method ' + step.method);
        const r = f.apply(o, Array(f.length).fill(any));
        if (step.mode === 'start') { pending[step.method] = Promise.resolve(r).catch(() => undefined); }
        else if (r && typeof r.then === 'function') await Promise.race([r.catch(() => undefined), new Promise(ok => realSetTimeout(ok, 300))]);
        result.values.push(read());
    }
} catch (e) { result.error = String(e && (e as Error).message || e); }
console.log('__PFLOW__' + JSON.stringify({ ...result, timers: running.size }));
process.exit(0);
`;
    const file = join(work, 'replay.mts');
    writeFileSync(file, script);
    const r = tsx.endsWith('.mjs') ? await run(process.execPath, [tsx, file], { cwd: root, timeoutMs: 60_000 }) : await run(tsx, [file], { cwd: root, timeoutMs: 60_000 });
    return verdict(plan, r.stdout, r.stderr, 'tsx');
}

async function replayPython(plan: Plan, root: string, work: string): Promise<Confirmation | undefined> {
    const python = findTool('python3') ?? 'python3';
    const module = plan.file.replace(/\.py$/, '').split('/');
    const script = `
import importlib.util, json, sys, inspect, enum
from unittest import mock
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(resolve(root, dirname(plan.file)))})
out = {"values": []}
try:
    spec = importlib.util.spec_from_file_location(${JSON.stringify(module[module.length - 1])}, ${JSON.stringify(resolve(root, plan.file))})
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    C = getattr(mod, ${JSON.stringify(plan.className)})
    n = len([p for p in inspect.signature(C).parameters.values() if p.default is p.empty and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)])
    o = C(*[mock.MagicMock() for _ in range(n)])
    def read():
        v = getattr(o, ${JSON.stringify(plan.field)}, None)
        return v.name if isinstance(v, enum.Enum) else v
    for step in ${JSON.stringify(plan.steps.map(s => s.method))}:
        f = getattr(o, step)
        k = len([p for p in inspect.signature(f).parameters.values() if p.default is p.empty and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)])
        r = f(*[mock.MagicMock() for _ in range(k)])
        if inspect.iscoroutine(r):
            import asyncio
            asyncio.run(r)
        out["values"].append(read())
except Exception as e:
    out["error"] = repr(e)
print("__PFLOW__" + json.dumps(out, default=str))
`;
    const file = join(work, 'replay.py');
    writeFileSync(file, script);
    const r = await run(python, [file], { cwd: root, timeoutMs: 60_000, env: { PYTHONDONTWRITEBYTECODE: '1' } });
    return verdict(plan, r.stdout, r.stderr, 'python3');
}

function verdict(plan: Plan, stdout: string, stderr: string, runner: string): Confirmation {
    const line = stdout.split('\n').find(l => l.startsWith('__PFLOW__'));
    if (!line) return { by: 'replay', status: 'unknown', detail: `The replay did not run (${runner}): ${stderr.trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 240) };
    const result = JSON.parse(line.slice('__PFLOW__'.length)) as { values: unknown[]; error?: string; timers?: number };
    const calls = plan.steps.filter(s => s.mode !== 'finish').map(s => `${s.method}()`).join(', ');
    if (result.error) return { by: 'replay', status: 'unknown', detail: `Replaying ${calls} stopped: ${result.error}`.slice(0, 240) };
    if (plan.expect.timersAtLeast !== undefined) {
        return (result.timers ?? 0) >= plan.expect.timersAtLeast
            ? { by: 'replay', status: 'confirmed', detail: `Replayed ${calls} on a real ${plan.className}: ${result.timers} timers are running, the earlier ones can no longer be stopped.` }
            : { by: 'replay', status: 'refuted', detail: `Replayed ${calls} on a real ${plan.className}: only ${result.timers} timer running.` };
    }
    const last = result.values[result.values.length - 1];
    const same = String(last) === plan.expect.value;
    if (plan.expect.lostValue) {
        return same
            ? { by: 'replay', status: 'confirmed', detail: `Replayed on a real ${plan.className}: ${calls}; ${plan.steps.find(s => s.mode === 'start')!.method}() finished last and set ${plan.field} to '${last}', losing '${plan.expect.lostValue}'.` }
            : { by: 'replay', status: 'refuted', detail: `Replayed on a real ${plan.className}: ${calls}; ${plan.field} ends as '${String(last)}', the change made meanwhile is kept.` };
    }
    return same
        ? { by: 'replay', status: 'confirmed', detail: `Replayed ${calls} on a real ${plan.className}: ${plan.field} is '${last}', as the counterexample predicts.` }
        : { by: 'replay', status: 'refuted', detail: `Replayed ${calls} on a real ${plan.className}: ${plan.field} is '${String(last)}', not '${plan.expect.value}' (the model is coarser than the code here).` };
}

function tsxBinary(root: string): string | undefined {
    for (const base of [root, dirname(new URL(import.meta.url).pathname)]) {
        try {
            const require = createRequire(join(base, 'package.json'));
            const pkg = require.resolve('tsx/package.json');
            return join(dirname(pkg), 'dist', 'cli.mjs');
        } catch {
            // not there
        }
    }
    return findTool('tsx');
}
