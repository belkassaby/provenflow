import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisProcess } from '../src/analysis-process';
import { extractArguments, findCli, startsAnalysis, spawnPlan, trendsArguments } from '../src/cli';
import { countsText, offeredFixes, parseReport, problemsByFile, type ReportFinding } from '../src/report';

const leak: ReportFinding = {
    rule: 'resource-leak',
    severity: 'error',
    subject: 'Poller interval',
    message: 'The interval started in start() is never cleared.',
    fix: 'Clear it in stop().',
    loc: { file: 'src/poller.ts', line: 12 },
    endLine: 14,
    spec: 'G (started -> F stopped)',
    counterexample: [{ state: 'idle' }, { state: 'running', event: 'Poller.start', loc: { file: 'src/poller.ts', line: 12 } }, { state: 'running', event: 'Poller.start' }],
    confirmation: { by: 'replay', status: 'confirmed', detail: '2 timers are running.' },
    suggestedPatch: { verified: true, note: 'clears the interval', files: [{ file: 'src/poller.ts', after: 'fixed' }] }
};
const naming: ReportFinding = { rule: 'naming-convention', severity: 'warning', subject: 'do_it', message: 'Not camelCase.', fix: 'Rename it doIt.', loc: { file: 'src/a.ts', line: 1 }, suggestedPatch: { verified: false, note: 'rename', files: [{ file: 'src/a.ts', after: 'x' }] } };
const layer: ReportFinding = { rule: 'layer-cycle', severity: 'warning', subject: 'app -> server', message: 'A cycle.', fix: 'Break it.' };

describe('the report as problems in the editor', () => {
    const report = parseReport(JSON.stringify({ findings: [leak, naming, layer], summary: { error: 1, warning: 2, info: 0 } }))!;

    it('puts each finding with a place on its file, with 0-based lines, the fix, the property and the replay', () => {
        const byFile = problemsByFile(report);
        expect([...byFile.keys()]).toEqual(['src/poller.ts', 'src/a.ts']);
        const [p] = byFile.get('src/poller.ts')!;
        expect(p).toMatchObject({ line: 11, endLine: 13, severity: 'error', code: 'resource-leak' });
        expect(p.message).toBe('The interval started in start() is never cleared.\nFix: Clear it in stop().\nProperty: G (started -> F stopped)\nOn the code (replay): confirmed. 2 timers are running.');
    });

    it('links the counterexample steps that have a place in the code', () => {
        const [p] = problemsByFile(report).get('src/poller.ts')!;
        expect(p.related).toEqual([{ file: 'src/poller.ts', line: 12, message: 'Step 1: Poller.start → running' }]);
    });

    it('offers verified fixes, and unverified ones only when asked for', () => {
        const all = [...problemsByFile(report).values()].flat();
        expect(offeredFixes(all, { unverified: false }).map(f => f.title)).toEqual(['ProvenFlow: apply verified fix']);
        expect(offeredFixes(all, { unverified: true }).map(f => f.title)).toEqual(['ProvenFlow: apply verified fix', 'ProvenFlow: apply unverified fix (review it)']);
    });

    it('counts the findings, and refuses what is not a report', () => {
        expect(countsText(report.summary)).toBe('ProvenFlow $(error) 1 $(warning) 2');
        expect(parseReport(JSON.stringify({ findings: [naming] }))!.summary).toEqual({ error: 0, warning: 1, info: 0 });
        expect(parseReport('{"nope": 1}')).toBeUndefined();
        expect(parseReport('not json')).toBeUndefined();
    });
});

describe('running pflow', () => {
    it('asks for the report only, never failing on findings, quick by default', () => {
        expect(extractArguments('/w', '/w/.provenflow/vscode', { full: false, fixes: true })).toEqual(['extract', '/w', '-o', '/w/.provenflow/vscode', '--quiet', '--fail-on', 'none', '--no-history', '--no-analyzers', '--no-confirm', '--fix']);
        expect(extractArguments('/w', '/o', { full: true, fixes: false })).toEqual(['extract', '/w', '-o', '/o', '--quiet', '--fail-on', 'none', '--no-history']);
        expect(trendsArguments('/w')).toEqual(['trends', '/w', '--json']);
        expect(trendsArguments('/w', 12)).toEqual(['trends', '/w', '--json', '--backfill', '12', '--quiet']);
    });

    it('finds pflow: the configured path, then the workspace, then the PATH', () => {
        const there = (paths: string[]) => ({ exists: (p: string) => paths.includes(p) });
        const env = { path: ['/usr/bin', '/opt/bin'].join(':'), platform: 'darwin' as const };
        expect(findCli('/w', '', env, there(['/w/node_modules/.bin/pflow', '/opt/bin/pflow']))).toBe('/w/node_modules/.bin/pflow');
        expect(findCli('/w', '', env, there(['/opt/bin/pflow']))).toBe('/opt/bin/pflow');
        expect(findCli('/w', 'tools/cli.js', env, there(['/w/tools/cli.js', '/opt/bin/pflow']))).toBe('/w/tools/cli.js');
        expect(findCli('/w', '/nowhere/pflow', env, there(['/opt/bin/pflow']))).toBeUndefined();
        expect(findCli('/w', '', env, there([]))).toBeUndefined();
        // A package of a monorepo: the pflow installed at its root.
        expect(findCli('/repo/packages/app', '', env, there(['/repo/node_modules/.bin/pflow', '/opt/bin/pflow']))).toBe('/repo/node_modules/.bin/pflow');
    });

    it('runs a .js with node, and analyses on save except in its own outputs, git and dependencies', () => {
        expect(spawnPlan('/p/cli.js', ['extract'], 'linux')).toEqual({ command: 'node', args: ['/p/cli.js', 'extract'], shell: false });
        expect(spawnPlan('C:\\p\\pflow.cmd', ['extract'], 'win32').shell).toBe(true);
        expect(startsAnalysis('src/a.ts')).toBe(true);
        expect(['.provenflow/vscode/report.json', '.git/HEAD', 'node_modules/x/index.js', '../other/a.ts', ''].map(startsAnalysis)).toEqual([false, false, false, false, false]);
    });
});

describe('one run at a time', () => {
    let dir: string | undefined;
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

    it('stops the run still going when a new one starts', async () => {
        dir = mkdtempSync(join(tmpdir(), 'provenflow-vscode-'));
        const script = join(dir, 'fake-pflow.js');
        writeFileSync(script, "if (process.argv[2] === 'slow') setTimeout(() => {}, 60000); else { process.stderr.write('note: done'); process.exit(0); }");
        const runner = new AnalysisProcess();
        const slow = runner.start(script, ['slow'], dir);
        expect(runner.running).toBe(true);
        const quick = await runner.start(script, ['quick'], dir);
        expect(await slow).toMatchObject({ stopped: true });
        expect(quick).toMatchObject({ code: 0, stopped: false, stderr: 'note: done' });
        expect(runner.running).toBe(false);
    });
});
