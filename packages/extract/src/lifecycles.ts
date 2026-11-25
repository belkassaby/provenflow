/**
 * Resource lifecycles (typestate): for every class holding a resource that
 * must be given back (timer, listener on a global target, EventSource,
 * observer, child process, temporary directory...), a model whose events are
 * the class's methods. nuXmv checks the resource is never lost: acquired a
 * second time while still held, or still held when the object is disposed.
 * For functions, the check is that the release also runs on errors.
 */
import type { ClassFact, Facts, ResourceKind, ResourceOpFact } from './ir.js';
import { formatLocation } from './ir.js';
import { ModelBuilder, slug, type ExtractedModel, type Finding } from './models.js';

/** Methods that end an object's life. */
const DISPOSE = /^(ngOnDestroy|destroy|dispose|__exit__|__aexit__|__del__|onDestroy|__destruct|deinit|drop|finalize|onCleared|componentWillUnmount|unmount|unsubscribe|detach|~\w+)$|(_destroy|_free|_deinit)$/i;
/** Hooks the framework calls once per instance: what they acquire is not acquired again by them. */
const ONCE = /^(ngOnInit|ngAfterViewInit|ngAfterContentInit)$/;
/** Methods that release but after which the object can be used again, unless the class is Closeable/Disposable. */
const WEAK_DISPOSE = /^(close|stop|shutdown|cleanup|disconnect|teardown|cancel)$|(_close|_cleanup|_shutdown)$/i;
const CLOSEABLE = /^(Closeable|AutoCloseable|IDisposable|IAsyncDisposable|Disposable|io\.Closer|Closer)$/;

/** Resources whose loss matters even when the owner lives forever or never disposes. */
const MUST_RELEASE_ON_ERROR = new Set<ResourceKind>(['temp-dir', 'file', 'lock', 'memory', 'socket']);

const RELEASE_CALL: Record<ResourceKind, string> = {
    interval: 'clearInterval(handle)',
    timeout: 'clearTimeout(handle)',
    listener: 'removeEventListener/off with the same function',
    subscription: 'subscription.unsubscribe()',
    'event-source': 'source.close()',
    observer: 'observer.disconnect()',
    process: 'child.kill()',
    'temp-dir': 'rm(dir, { recursive: true, force: true })',
    file: 'file.close() (or a with/using block)',
    lock: 'lock.release() (or a with block)',
    graph: 'cy.destroy()',
    memory: 'free(p) / delete p (or a smart pointer / RAII owner)',
    socket: 'socket.close()',
    executor: 'executor.shutdown()'
};

export interface LifecycleResult {
    models: ExtractedModel[];
    findings: Finding[];
}

export function buildLifecycles(facts: Facts): LifecycleResult {
    const models: ExtractedModel[] = [];
    const findings: Finding[] = [];
    const classes = new Map(facts.classes.map(c => [c.id, c]));
    const byOwner = new Map<string, ResourceOpFact[]>();
    for (const r of facts.resources) {
        if (r.selfReleasing) continue;
        const list = byOwner.get(r.owner) ?? [];
        list.push(r);
        byOwner.set(r.owner, list);
    }
    const used = new Set<string>();

    for (const [owner, ops] of byOwner) {
        const cls = classes.get(owner);
        const kinds = new Set(ops.map(o => o.kind));
        for (const kind of kinds) {
            const ofKind = ops.filter(o => o.kind === kind);
            // Function-local handles: the release must be guaranteed.
            for (const acquire of ofKind.filter(o => o.op === 'acquire' && !isField(o.handle))) {
                const releases = ofKind.filter(o => o.op === 'release' && o.member === acquire.member && (!acquire.handle || !o.handle || o.handle === acquire.handle || o.handle.includes(acquire.handle)));
                if (releases.length > 0 && !releases.some(r => r.guaranteed) && MUST_RELEASE_ON_ERROR.has(kind)) {
                    findings.push({
                        rule: 'release-not-guaranteed',
                        category: 'lifecycle',
                        severity: 'warning',
                        subject: acquire.ownerKind === 'function' ? acquire.member : `${ownerName(owner)}.${acquire.member}`,
                        message: `The ${kind} acquired at ${formatLocation(acquire.loc)} is released at ${formatLocation(releases[0].loc)} only on the normal path: an exception in between leaks it.`,
                        fix: `Move the release into a finally block (try { ... } finally { ${RELEASE_CALL[kind]} }), or use a with/using block.`,
                        loc: acquire.loc,
                        related: releases.map(r => r.loc),
                        source: 'analysis'
                    });
                }
            }
            if (!cls) continue;
            // Class-held resources: typestate model over the class's methods.
            const groups = groupHandles(ofKind.filter(o => isField(o.handle) || o.op === 'release' || kind === 'listener'));
            for (const [handle, group] of groups) {
                if (!group.some(o => o.op === 'acquire')) continue;
                const result = lifecycleModel(cls, kind, handle, group, used);
                if (result.model) models.push(result.model);
                findings.push(...result.findings);
            }
        }
    }
    return { models, findings };
}

function isField(handle: string | undefined): boolean {
    return !!handle && /^(this|self)\.\w+/.test(handle);
}

function ownerName(owner: string): string {
    return owner.replace(/^.*#/, '');
}

function groupHandles(ops: ResourceOpFact[]): Map<string, ResourceOpFact[]> {
    const groups = new Map<string, ResourceOpFact[]>();
    for (const op of ops.filter(o => o.op === 'acquire')) {
        const key = op.handle ?? '(dropped)';
        groups.set(key, [...(groups.get(key) ?? []), op]);
    }
    for (const op of ops.filter(o => o.op === 'release')) {
        const key = [...groups.keys()].find(k => k === op.handle || (op.handle && k.startsWith(`${op.handle}:`)) || (op.handle && k.includes(op.handle))) ?? (groups.size === 1 ? [...groups.keys()][0] : undefined);
        if (key) groups.get(key)!.push(op);
    }
    return groups;
}

function lifecycleModel(cls: ClassFact, kind: ResourceKind, handle: string, ops: ResourceOpFact[], used: Set<string>): { model?: ExtractedModel; findings: Finding[] } {
    const findings: Finding[] = [];
    const acquires = ops.filter(o => o.op === 'acquire');
    const releases = ops.filter(o => o.op === 'release');
    const subject = `${cls.name} ${kind} ${handle}`;

    findings.push(...unremovableListeners(cls, acquires));

    // Methods doing each operation, directly or through the methods they call.
    const direct = (op: 'acquire' | 'release') => new Set(ops.filter(o => o.op === op).map(o => o.member));
    const closure = closeOverCalls(cls, direct('acquire'));
    const releaseClosure = closeOverCalls(cls, direct('release'));
    const closeable = cls.implements.some(i => CLOSEABLE.test(i.replace(/<.*$/, ''))) || (cls.extends !== undefined && CLOSEABLE.test(cls.extends));
    const isDispose = (name: string) => DISPOSE.test(name) || (closeable && WEAK_DISPOSE.test(name));
    const disposers = cls.methods.map(m => m.name).filter(isDispose);
    if (ops.some(o => o.member === 'ngOnDestroy') && !disposers.includes('ngOnDestroy')) disposers.push('ngOnDestroy');
    const lives = cls.providedInRoot; // one instance for the whole application: never disposed

    let id = slug(`lifecycle-${cls.name}-${kind}-${handle.replace(/^(this|self)\./, '')}`);
    for (let i = 2; used.has(id); i++) id = `${id}_${i}`;
    used.add(id);
    const b = new ModelBuilder(id, 'lifecycle', subject, acquires[0].loc);
    // Events are what other code can call: public methods and hooks. Private helpers act through
    // them; acquiring from the constructor happens once, when the object is created.
    const entry = (m: string) => m !== 'constructor' && cls.methods.find(x => x.name === m)?.visibility !== 'private';
    const atConstruction = closure.has('constructor');
    b.state('idle', !atConstruction);
    b.state('held', atConstruction);
    b.state('leaked');
    if (!lives) b.state('disposed');

    const ctx: LifecycleContext = {
        cls,
        kind,
        b,
        acquires,
        releaseClosure,
        entry,
        isDispose,
        locOf: (member, op) => ops.find(o => o.member === member && o.op === op)?.loc ?? cls.methods.find(m => m.name === member)?.loc
    };
    addAcquisitions(ctx, ops, closure);
    for (const member of [...releaseClosure].filter(entry)) b.transition('held', 'idle', { event: `${cls.name}.${member}`, loc: ctx.locOf(member, 'release') });
    if (!lives) addDisposal(ctx, disposers);
    const lastAcquire = acquires[0];
    b.spec('INVARSPEC', 'never_leaked', '!(state = leaked)', {
        rule: 'resource-leak',
        category: 'lifecycle',
        severity: 'warning',
        message: `${cls.name} can lose the ${kind} held in ${handle} (acquired at ${formatLocation(lastAcquire.loc)}) without releasing it.`,
        fix:
            disposers.length === 0 && !lives
                ? `Release it when ${cls.name} is disposed: add ngOnDestroy (or inject(DestroyRef).onDestroy) / a dispose() method calling ${RELEASE_CALL[kind]}; also release before acquiring again.`
                : `Before acquiring again, release the previous one (${RELEASE_CALL[kind]}) or return early when ${handle} is already set; make sure ${disposers.join('/') || 'dispose'} releases it.`,
        loc: lastAcquire.loc,
        related: releases.map(r => r.loc),
        fallback: 'avoid',
        states: ['leaked']
    });
    return { model: b.build(), findings };
}

interface LifecycleContext {
    cls: ClassFact;
    kind: ResourceKind;
    b: ModelBuilder;
    acquires: ResourceOpFact[];
    releaseClosure: Set<string>;
    entry: (member: string) => boolean;
    isDispose: (member: string) => boolean;
    locOf: (member: string, op: 'acquire' | 'release') => ResourceOpFact['loc'] | undefined;
}

/** An inline listener on window/document cannot be removed. */
function unremovableListeners(cls: ClassFact, acquires: ResourceOpFact[]): Finding[] {
    if (cls.providedInRoot) return [];
    return acquires
        .filter(o => o.kind === 'listener' && o.global && o.anonymous)
        .map(a => ({
            rule: 'unremovable-listener',
            category: 'lifecycle' as const,
            severity: 'warning' as const,
            subject: `${cls.name}.${a.member}`,
            message: `${cls.name} adds an inline listener to a global target (${a.text}); it can never be removed, so it outlives every ${cls.name}.`,
            fix: 'Keep the listener in a field (or use an AbortController signal) and remove it when the object is disposed (ngOnDestroy / DestroyRef.onDestroy).',
            loc: a.loc,
            source: 'analysis' as const
        }));
}

/** Each method other code calls that acquires: from idle it holds; while held, it leaks unless it releases first or is guarded. */
function addAcquisitions(ctx: LifecycleContext, ops: ResourceOpFact[], closure: Set<string>): void {
    const { cls, b } = ctx;
    for (const member of [...closure].filter(ctx.entry)) {
        if (ctx.isDispose(member)) continue;
        const loc = ops.find(o => o.member === member && o.op === 'acquire')?.loc ?? ctx.locOf(member, 'acquire');
        b.transition('idle', 'held', { event: `${cls.name}.${member}`, loc });
        if (ONCE.test(member)) continue;
        const releaseFirst = ctx.releaseClosure.has(member) && releasesBeforeAcquiring(ops, member);
        // Guarded when every acquisition the method reaches (itself or through the helpers it calls) is.
        const reached = ctx.acquires.filter(a => reaches(cls, member, a.member));
        const guarded = reached.length > 0 && reached.every(a => a.guarded);
        b.transition('held', releaseFirst || guarded ? 'held' : 'leaked', { event: `${cls.name}.${member}`, loc });
    }
}

/** The end of the owner's life: its dispose methods, or being dropped when it has none. */
function addDisposal(ctx: LifecycleContext, disposers: string[]): void {
    const { cls, b } = ctx;
    if (disposers.length === 0) {
        b.transition('idle', 'disposed', { event: `${cls.name} discarded` });
        // A pending timeout of an object without a lifecycle fires once and is gone.
        b.transition('held', ctx.kind === 'timeout' ? 'disposed' : 'leaked', { event: `${cls.name} discarded (no dispose method)` });
    }
    for (const d of disposers) {
        const loc = cls.methods.find(m => m.name === d)?.loc;
        b.transition('idle', 'disposed', { event: `${cls.name}.${d}`, loc });
        b.transition('held', ctx.releaseClosure.has(d) ? 'disposed' : 'leaked', { event: `${cls.name}.${d}`, loc: ctx.locOf(d, 'release') ?? loc });
    }
}

/** Whether `from` is `to` or calls it, directly or through other methods of the class. */
function reaches(cls: ClassFact, from: string, to: string): boolean {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
        const m = queue.shift()!;
        if (m === to) return true;
        for (const c of cls.methods.find(x => x.name === m)?.calls ?? []) {
            if (!seen.has(c)) {
                seen.add(c);
                queue.push(c);
            }
        }
    }
    return false;
}

/** Methods that perform the operation directly or by calling (transitively) a method that does. */
function closeOverCalls(cls: ClassFact, members: Set<string>): Set<string> {
    const result = new Set(members);
    let changed = true;
    while (changed) {
        changed = false;
        for (const m of cls.methods) {
            if (!result.has(m.name) && m.calls.some(c => result.has(c))) {
                result.add(m.name);
                changed = true;
            }
        }
    }
    return result;
}

/** The method releases the old resource before acquiring the new one (direct release above the acquisition, or a helper call). */
function releasesBeforeAcquiring(ops: ResourceOpFact[], member: string): boolean {
    const acquire = ops.find(o => o.member === member && o.op === 'acquire');
    const release = ops.find(o => o.member === member && o.op === 'release');
    if (!acquire) return true; // acquires through a helper: assume the helper is written in order
    if (!release) return true; // releases through a helper it calls, typically first
    return release.loc.line < acquire.loc.line;
}
