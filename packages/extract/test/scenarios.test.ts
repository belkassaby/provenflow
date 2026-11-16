import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractProject, writeOutputs } from '../src/index.js';
import { scenarioFor } from '../src/scenarios.js';
import { findTool } from '../src/tools/process.js';

const scratch = mkdtempSync(join(tmpdir(), 'provenflow-scenarios-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const VITEST = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

const POLLER = (start: string) => `export class Poller {
    private timer?: ReturnType<typeof setInterval>;

    start(): void {
        ${start}
    }

    stop(): void {
        clearInterval(this.timer);
    }
}
`;

const DOOR = `from enum import Enum


class DoorState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    JAMMED = "jammed"


class Door:
    def __init__(self):
        self.state = DoorState.CLOSED

    def open(self):
        if self.state == DoorState.CLOSED:
            self.state = DoorState.OPEN

    def force(self):
        self.state = DoorState.JAMMED
`;

function vitest(root: string): { ok: boolean; output: string } {
    const r = spawnSync(process.execPath, [VITEST, 'run', '.provenflow/extract/scenarios', '--root', root], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

describe('counterexamples as regression tests', () => {
    it('writes a test that drives the real code, fails on the bug and passes once it is fixed', async () => {
        const root = mkdtempSync(join(scratch, 'ts-'));
        writeFileSync(join(root, 'poller.ts'), POLLER('this.timer = setInterval(() => undefined, 1000);'));
        const written = writeOutputs(await extractProject(root, { analyzers: false, config: {} }), join(root, '.provenflow', 'extract'));
        expect(written.scenarios.filter(s => !written.skeletons.includes(s))).toEqual(['scenarios/lifecycle_Poller_interval_timer_resource_leak_1.test.ts']);
        const before = vitest(root);
        expect(before.ok).toBe(false);
        expect(before.output).toMatch(/expected 2 to be less than 2/);
        // The fix: release the timer before acquiring it again.
        writeFileSync(join(root, 'poller.ts'), POLLER('clearInterval(this.timer);\n        this.timer = setInterval(() => undefined, 1000);'));
        expect(vitest(root).output).toMatch(/1 passed/);
    }, 240_000);

    it.skipIf(!findTool('python3'))('writes a Python test that reaches the state the property forbids', async () => {
        const root = mkdtempSync(join(scratch, 'py-'));
        writeFileSync(join(root, 'door.py'), DOOR);
        const result = await extractProject(root, { analyzers: false, confirm: false, config: {} });
        const settle = result.findings.find(f => f.rule === 'cannot-settle')!;
        const folder = join(root, 'scenarios');
        const context = { models: result.models, facts: result.facts, root, folder };
        // "Can always get back" is not broken by reaching the state: a skeleton.
        expect(scenarioFor(settle, context).runnable).toBe(false);
        // "Never jammed" is: the test makes the calls and checks the state.
        const scenario = scenarioFor({ ...settle, spec: 'never_jammed := !(state = JAMMED)' }, context);
        expect(scenario.runnable).toBe(true);
        expect(scenario.text).toContain('call(o, "force")');
        rmSync(folder, { recursive: true, force: true });
        mkdirSync(folder);
        writeFileSync(join(folder, 'test_door.py'), scenario.text);
        const run = spawnSync(findTool('python3')!, ['-c', 'import runpy, sys; runpy.run_path(sys.argv[1])["test_counterexample"]()', join(folder, 'test_door.py')], { encoding: 'utf8' });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toMatch(/AssertionError/);
    }, 120_000);
});
