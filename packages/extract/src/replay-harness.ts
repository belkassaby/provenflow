/**
 * The code that drives a class along a counterexample, shared by the replay (run once, during the
 * analysis) and the regression tests written next to the report (run by the project's own tests).
 * Every argument is a permissive stand-in; timers are counted instead of run.
 */

/** TypeScript/JavaScript: stand-ins, counted timers, and calls on an instance. */
export const TS_HARNESS = `const any: any = new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => 0 : p === Symbol.iterator ? function* () {} : any),
    apply: () => any,
    construct: () => any
});
/** Timers started and not stopped. */
const running = new Set<unknown>();
const realTimers = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
function countTimers(): void {
    const g = globalThis as any;
    g.setInterval = () => { const h = realTimers.setInterval(() => undefined, 1e9); running.add(h); return h; };
    g.clearInterval = (h: any) => { running.delete(h); realTimers.clearInterval(h); };
    g.setTimeout = (f: any, ms?: number, ...a: unknown[]) => { if ((ms ?? 0) > 50) { const h = realTimers.setTimeout(() => undefined, 1e9); running.add(h); return h; } return realTimers.setTimeout(f, ms, ...a); };
    g.clearTimeout = (h: any) => { running.delete(h); realTimers.clearTimeout(h); };
}
function restoreTimers(): void {
    for (const h of running) { realTimers.clearInterval(h as any); realTimers.clearTimeout(h as any); }
    running.clear();
    Object.assign(globalThis, realTimers);
}
function create(C: any): any {
    if (typeof C !== 'function') throw new Error('the class is not exported');
    return new C(...Array(C.length).fill(any));
}
function invoke(o: any, method: string): unknown {
    const f = o[method];
    if (typeof f !== 'function') throw new Error('no method ' + method);
    return f.apply(o, Array(f.length).fill(any));
}
/** Calls a method, and waits for it a moment when it is async. */
async function call(o: any, method: string): Promise<void> {
    const r: any = invoke(o, method);
    if (r && typeof r.then === 'function') await Promise.race([r.catch(() => undefined), new Promise(ok => realTimers.setTimeout(ok, 300))]);
}
/** Starts an async method without waiting for it. */
function start(o: any, method: string): Promise<unknown> {
    return Promise.resolve(invoke(o, method)).catch(() => undefined);
}
/** The value of a field (or of a getter method, such as a signal). */
function read(o: any, field: string): unknown {
    if (!field) return undefined;
    const v = o[field];
    return typeof v === 'function' ? v.call(o) : v;
}
`;

/** Python: stand-ins (MagicMock), loading a module from its file, and calls on an instance. */
export const PY_HARNESS = `import asyncio
import enum
import importlib.util
import inspect
import sys
from unittest import mock


def _required(f):
    return len([p for p in inspect.signature(f).parameters.values() if p.default is p.empty and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)])


def load(path, name, *paths):
    for p in paths:
        sys.path.insert(0, str(p))
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create(cls):
    return cls(*[mock.MagicMock() for _ in range(_required(cls))])


def call(o, method):
    f = getattr(o, method)
    r = f(*[mock.MagicMock() for _ in range(_required(f))])
    if inspect.iscoroutine(r):
        asyncio.run(r)


def read(o, field):
    v = getattr(o, field, None)
    return v.name if isinstance(v, enum.Enum) else v
`;
