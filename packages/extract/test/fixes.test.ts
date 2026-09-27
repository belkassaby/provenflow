import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractProject, lineDiff, type ExtractionResult } from '../src/index.js';

const SHOP = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const POLYGLOT = fileURLToPath(new URL('./fixtures/polyglot', import.meta.url));

const cache = new Map<string, Promise<ExtractionResult>>();
const run = (root: string) => {
    if (!cache.has(root)) cache.set(root, extractProject(root, { analyzers: false, config: {}, quickFixes: 50 }));
    return cache.get(root)!;
};

describe('quick fixes, verified by re-running every check', () => {
    it('re-checks the state after an await (TypeScript)', async () => {
        const f = (await run(SHOP)).findings.find(x => x.rule === 'stale-write-after-await')!;
        expect(f.suggestedPatch?.verified).toBe(true);
        expect(f.suggestedPatch?.by).toBe('quick fix');
        const file = f.suggestedPatch!.files![0];
        expect(file.after.split('\n').find(l => l.includes('return;') && l.includes('submitted'))?.trim()).toMatch(/^if \(this\.status !== 'submitted'\) return;/);
        expect(file.after.replace(/^.*the state may have changed while awaiting\n/m, '')).toBe(file.before);
    });

    it('releases a timer before acquiring it again, and adds dispose()', async () => {
        const f = (await run(SHOP)).findings.find(x => x.rule === 'resource-leak' && x.subject.startsWith('Poller'))!;
        expect(f.suggestedPatch?.verified).toBe(true);
        const after = f.suggestedPatch!.files![0].after;
        expect(after).toMatch(/clearInterval\(this\.timer\); \/\/ release the previous one[^\n]*\n\s+this\.timer = setInterval/);
        expect(after).toMatch(/dispose\(\): void \{\n\s+clearInterval\(this\.timer\);/);
    });

    it('lists missing switch cases explicitly, keeping the behaviour (TypeScript, Python)', async () => {
        const r = await run(SHOP);
        const ts = r.findings.find(x => x.rule === 'unhandled-state' && x.loc?.file === 'src/core/order.ts')!;
        expect(ts.suggestedPatch?.verified).toBe(true);
        expect(ts.suggestedPatch!.files![0].after).toMatch(/case 'shipped':\n\s+case 'cancelled':\n\s+case 'refunded':\n\s+break;/);
        const py = r.findings.find(x => x.rule === 'unhandled-state' && x.loc?.file === 'jobs/jobs.py')!;
        expect(py.suggestedPatch?.verified).toBe(true);
        expect(py.suggestedPatch!.files![0].after).toMatch(/case JobState\.FAILED \| JobState\.RETRYING:\n\s+pass/);
    });

    it.each([
        ['c/job.c', /case FAILED:\n\s+case RETRYING:\n\s+break;/],
        ['cpp/job.cpp', /case State::Failed:\n\s+case State::Retrying:\n\s+break;/],
        ['csharp/Job.cs', /case State\.Failed:\n\s+case State\.Retrying:\n\s+break;/],
        ['go/job.go', /case Failed, Retrying:/],
        ['groovy/Job.groovy', /case State\.FAILED:\n\s+case State\.RETRYING:/],
        ['java/src/main/java/app/Job.java', /case FAILED:\n\s+case RETRYING:/]
    ])('lists missing switch cases in %s, spelled like the others', async (file, expected) => {
        const f = (await run(POLYGLOT)).findings.find(x => x.rule === 'unhandled-state' && x.loc?.file === file)!;
        expect(f.suggestedPatch?.verified, file).toBe(true);
        expect(f.suggestedPatch!.files![0].after).toMatch(expected);
    });

    it.each([
        ['c/job.c', 'RETRYING'],
        ['cpp/job.cpp', 'Retrying'],
        ['csharp/Job.cs', 'Retrying'],
        ['go/job.go', 'Retrying'],
        ['groovy/Job.groovy', 'RETRYING'],
        ['java/src/main/java/app/Job.java', 'RETRYING'],
        ['kotlin/Job.kt', 'RETRYING'],
        ['php/Job.php', 'Retrying'],
        ['rust/src/lib.rs', 'Retrying'],
        ['scala/Job.scala', 'Retrying'],
        ['swift/Job.swift', 'retrying']
    ])('removes a value nothing uses from its declaration in %s, and the model loses the false property', async (file, value) => {
        const r = await run(POLYGLOT);
        const f = r.findings.find(x => x.rule === 'unreachable-state' && x.loc?.file === file)!;
        expect(f.suggestedPatch?.verified, file).toBe(true);
        const change = f.suggestedPatch!.files![0];
        expect(change.file).toBe(file);
        expect(change.before).toMatch(new RegExp(`\\b${value}\\b`));
        expect(change.after).not.toMatch(new RegExp(`\\b${value}\\b`));
        const model = f.suggestedPatch!.models!.find(m => m.id === f.model)!;
        expect(model.falseBefore).toContain(`reach_${value}`);
        expect(model.falseAfter).toEqual([]);
        expect(model.before).toContain(`state ${value}`);
        expect(model.after).not.toContain(`state ${value}`);
    });

    it('leaves a value alone when code still tests it (dead branch to remove by hand)', async () => {
        const order = (await run(SHOP)).findings.find(x => x.rule === 'unreachable-state' && x.subject === 'Order.status')!;
        expect(order.suggestedPatch).toBeUndefined();
        const ruby = (await run(POLYGLOT)).findings.find(x => x.rule === 'unreachable-state' && x.loc?.file === 'ruby/job.rb')!;
        expect(ruby.suggestedPatch).toBeUndefined();
    });

    it('declares a state the machine cannot leave as final in provenflow.config.json', async () => {
        const f = (await run(SHOP)).findings.find(x => x.rule === 'cannot-settle' && x.subject.includes('Lamp'))!;
        expect(f.suggestedPatch?.verified).toBe(true);
        const config = f.suggestedPatch!.files![0];
        expect(config.file).toBe('provenflow.config.json');
        expect(config.before).toBe('');
        expect(JSON.parse(config.after).machines.Lamp.terminal).toEqual(expect.arrayContaining(['off', 'broken']));
        expect(f.suggestedPatch!.models![0].falseAfter).toEqual([]);
    });

    it('proposes nothing unless asked', async () => {
        const r = await extractProject(SHOP, { analyzers: false, config: {} });
        expect(r.findings.some(f => f.suggestedPatch)).toBe(false);
    });

    it('writes a unified diff of the change', () => {
        const diff = lineDiff('a.ts', 'one\ntwo\nthree\n', 'one\ntwo and a half\nthree\n');
        expect(diff).toContain('-two\n+two and a half');
        expect(diff).toMatch(/^--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ -1,/);
    });
});
