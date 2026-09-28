import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractProject, isApplied, lineDiff, verifyProposals, type ExtractionResult } from '../src/index.js';

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

    it('re-runs incrementally after a change is applied: the same findings as a full run, the rest reused', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'provenflow-incremental-'));
        try {
            cpSync(SHOP, dir, { recursive: true });
            const options = { analyzers: false, config: {}, quickFixes: 50 } as const;
            const first = await extractProject(dir, options);
            const leak = first.findings.find(f => f.rule === 'resource-leak' && f.subject.startsWith('Poller'))!;
            const change = leak.suggestedPatch!.files![0];
            writeFileSync(join(dir, change.file), change.after); // Apply
            const again = await extractProject(dir, { ...options, previous: first.previous });
            const full = await extractProject(dir, options);
            expect(again.incremental?.changed).toEqual([change.file]);
            const keys = (r: ExtractionResult) => r.findings.map(f => `${f.rule}|${f.subject}|${f.loc?.file}:${f.loc?.line}`).sort();
            expect(keys(again)).toEqual(keys(full));
            expect(again.findings.some(f => f.rule === 'resource-leak' && f.subject === leak.subject)).toBe(false);
            // Findings on the other files keep the change verified last time and their replay.
            expect(again.incremental!.reused.patches).toBeGreaterThan(0);
            const stale = again.findings.find(f => f.rule === 'stale-write-after-await')!;
            expect(stale.suggestedPatch?.verified).toBe(true);
            expect(stale.confirmation?.status).toBe('confirmed');
            expect(again.incremental!.reused.confirmations).toBeGreaterThan(0);
            // A different option means a full run.
            expect((await extractProject(dir, { ...options, quickFixes: 1, previous: first.previous })).incremental).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);

    it('releases before every place a resource is acquired, so the finding goes away', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'provenflow-two-sites-'));
        try {
            const code = [
                "import { Subscription, interval } from 'rxjs';",
                '',
                'export class Saver {',
                '    private sub?: Subscription;',
                '    private timer?: ReturnType<typeof setTimeout>;',
                '',
                '    saveAll(): void {',
                '        this.sub = interval(10).subscribe();',
                '    }',
                '',
                '    saveLater(): void {',
                '        this.timer = setTimeout(() => {',
                '            this.sub = interval(20).subscribe();',
                '        }, 5);',
                '    }',
                '',
                '    stop(): void {',
                '        clearTimeout(this.timer);',
                '        this.sub?.unsubscribe();',
                '    }',
                '}',
                ''
            ].join('\n');
            writeFileSync(join(dir, 'saver.ts'), code);
            const r = await extractProject(dir, { analyzers: false, confirm: false, config: {}, quickFixes: 20 });
            const leak = r.findings.find(f => f.rule === 'resource-leak' && f.subject.includes('this.sub'))!;
            expect(leak.suggestedPatch?.verified, leak.suggestedPatch?.note).toBe(true);
            const after = leak.suggestedPatch!.files![0].after;
            expect(after.match(/this\.sub\?\.unsubscribe\(\); \/\/ release the previous one/g)).toHaveLength(2);
            writeFileSync(join(dir, 'saver.ts'), after); // Apply
            const again = await extractProject(dir, { analyzers: false, confirm: false, config: {}, quickFixes: 20 });
            expect(again.findings.some(f => f.rule === 'resource-leak' && f.subject.includes('this.sub'))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('tells a change already applied from one that only adds lines found elsewhere in the file', () => {
        const once = 'class P {\n    start() {\n        clearInterval(this.t); // release\n        this.t = setInterval(f);\n    }\n    stop() {\n        clearInterval(this.t);\n    }\n\n    dispose(): void {\n        clearInterval(this.t);\n    }\n}';
        // The same fix proposed again on the fixed class: both of its blocks would be duplicated.
        const twice = once.replace('        clearInterval(this.t); // release\n', '        clearInterval(this.t); // release\n        clearInterval(this.t); // release\n').replace('\n\n    dispose(): void {\n        clearInterval(this.t);\n    }\n}', '\n\n    dispose(): void {\n        clearInterval(this.t);\n    }\n\n    dispose(): void {\n        clearInterval(this.t);\n    }\n}');
        expect(isApplied(once, { file: 'p.ts', search: once, replace: twice })).toBe(true);
        // A new release line whose text already exists in stop(): a real change.
        const original = 'class P {\n    start() {\n        this.t = setInterval(f);\n    }\n    stop() {\n        clearInterval(this.t);\n    }\n}';
        const fixed = original.replace('    start() {\n', '    start() {\n        clearInterval(this.t);\n');
        expect(isApplied(original, { file: 'p.ts', search: original, replace: fixed })).toBe(false);
        // A change that removes a line is never "already applied".
        expect(isApplied(once, { file: 'p.ts', search: once, replace: once.replace('        this.t = setInterval(f);\n', '') })).toBe(false);
    });

    it('does not propose again a change already in the code when the finding remains', async () => {
        const finding = { rule: 'resource-leak', category: 'lifecycle', severity: 'warning', subject: 'Poller', message: 'm', fix: 'Release it.', loc: { file: 'a.ts', line: 2, column: 1 }, source: 'nuxmv' } as const;
        const edit = { file: 'a.ts', search: '    this.timer = setInterval(f);', replace: '    clearInterval(this.timer);\n    this.timer = setInterval(f);' };
        expect(isApplied('start() {\n    this.timer = setInterval(f);\n}', edit)).toBe(false);
        const applied = 'start() {\n    clearInterval(this.timer);\n    this.timer = setInterval(f);\n}';
        expect(isApplied(applied, edit)).toBe(true);
        let reruns = 0;
        const r = await verifyProposals([finding], [{ finding, edits: [edit], explanation: 'e', by: 'quick fix' }], '/nowhere', async () => {
            reruns++;
            return { findings: [finding], models: [], verdicts: [] };
        }, () => applied);
        expect(reruns).toBe(0);
        expect(r.findings[0].suggestedPatch).toBeUndefined();
        expect(r.findings[0].fix).toMatch(/already in the code and the finding is still reported/);
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
