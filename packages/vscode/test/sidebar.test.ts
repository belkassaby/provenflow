import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { c4Document, editorKindOf, fileDocument, modelDocument } from '../src/editor-documents';
import { editorPageHtml, editorUrlOf, framedEditorUrl } from '../src/editor-page';
import { parseReport, type Report, type ReportFinding } from '../src/report';
import { findingNodes, hotspotNodes, modelNodes } from '../src/sidebar';
import { bars, runsOf, trendNodes, type MeasuredRun } from '../src/trends';

const leak: ReportFinding = {
    rule: 'resource-leak',
    category: 'lifecycle',
    severity: 'warning',
    subject: 'Poller',
    message: 'Poller can lose the interval held in this.timer.\nMore.',
    fix: 'Release it.',
    loc: { file: 'poller.ts', line: 5 },
    model: 'lifecycle-Poller-timer',
    counterexample: [{ state: 'idle' }, { state: 'held', event: 'Poller.start', loc: { file: 'poller.ts', line: 5 } }],
    confirmation: { by: 'replay', status: 'confirmed', detail: '2 timers are running.' },
    suggestedPatch: { verified: true, note: 'clears it', files: [{ file: 'poller.ts', after: 'fixed' }] }
};
const cve: ReportFinding = { rule: 'vulnerable-dependency', category: 'dependencies', severity: 'error', subject: 'lodash', message: 'lodash 4.17.20 has 4 known vulnerabilities.', fix: 'Upgrade.', loc: { file: 'package-lock.json', line: 4 } };
const name: ReportFinding = { rule: 'naming-convention', category: 'naming', severity: 'info', subject: 'do_it', message: 'Not camelCase.', fix: 'doIt.', suggestedPatch: { verified: false, note: 'rename', files: [{ file: 'a.ts', after: 'x' }] } };

const report: Report = parseReport(
    JSON.stringify({
        findings: [name, leak, cve],
        models: [
            { id: 'pattern-Cache', kind: 'pattern', subject: 'Cache' },
            { id: 'lifecycle-Poller-timer', kind: 'lifecycle', subject: 'Poller timer' }
        ],
        verdicts: [
            { model: 'lifecycle-Poller-timer', spec: 'never_leaked', verdict: 'false' },
            { model: 'pattern-Cache', spec: 'hit_after_put', verdict: 'true' }
        ],
        quality: { metrics: { hotspots: [{ name: 'applyAll', file: 'code-import.ts', line: 292, cognitive: 57, changes: 16, score: 912 }] } }
    })
)!;

describe('the ProvenFlow sidebar', () => {
    it('groups the findings by kind, errors first, with the counterexample steps under each', () => {
        const groups = findingNodes(report);
        expect(groups.map(g => [g.label, g.description, g.tone])).toEqual([
            ['Dependencies', '1', 'error'],
            ['Resource lifecycles', '1', 'warning'],
            ['Naming', '1', 'info']
        ]);
        const [finding] = groups[1].children!;
        expect(finding).toMatchObject({ label: 'Poller can lose the interval held in this.timer.', description: 'resource-leak · poller.ts:5 · confirmed on the code', context: 'finding fix model', place: { file: 'poller.ts', line: 5 } });
        expect(finding.children!.map(s => [s.label, s.description])).toEqual([
            ['0. idle', undefined],
            ['1. Poller.start → held', 'poller.ts:5']
        ]);
        expect(groups[2].children![0].context).toBe('finding unverified-fix');
    });

    it('lists the models with false properties first, and the hotspots by score', () => {
        expect(modelNodes(report).map(m => [m.label, m.description, m.model, m.children?.map(c => c.label)])).toEqual([
            ['Poller timer', '1 of 1 properties false', 'lifecycle-Poller-timer', ['never_leaked']],
            ['Cache', '1 properties hold', 'pattern-Cache', undefined]
        ]);
        expect(hotspotNodes(report).map(h => [h.label, h.description, h.place])).toEqual([['applyAll', '57 × 16 commits = 912', { file: 'code-import.ts', line: 292 }]]);
    });

    it('shows each measure of the trends with its change and a bar per run', () => {
        const run = (warnings: number, coverage: number): MeasuredRun => ({ date: '2026-11-17T10:00:00Z', codeLines: 9, findings: { error: 0, warning: warnings, info: 0 }, duplication: { percent: 0 }, complexity: { p90: 0, overLimit: 0 }, coverage, properties: { failed: warnings } });
        const nodes = trendNodes(runsOf(JSON.stringify([{ name: 'demo', entries: [run(1, 50), run(0, 60)] }]))!);
        expect(nodes.find(n => n.label === 'Warnings')).toMatchObject({ description: '0  -1  █▁', icon: 'arrow-down', tone: 'ok' });
        expect(nodes.find(n => n.label === 'Line coverage')).toMatchObject({ description: '60%  +10%  ▁█', tone: 'ok' });
        expect(nodes.find(n => n.label === 'Errors')).toMatchObject({ description: '0  =  ▁▁', tone: undefined });
        expect(bars([1, 5, 3])).toBe('▁█▅');
        expect(trendNodes([])).toEqual([]);
        expect(runsOf('not json')).toBeUndefined();
    });
});

describe('the ProvenFlow editor in a tab', () => {
    const root = mkdtempSync(join(tmpdir(), 'provenflow-vscode-editor-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('reads the address pflow serve prints, and frames the editor with nothing else allowed', () => {
        expect(editorUrlOf('ProvenFlow editor at http://127.0.0.1:53211/\n')).toBe('http://127.0.0.1:53211/');
        expect(editorUrlOf('starting…')).toBeUndefined();
        expect(framedEditorUrl('http://127.0.0.1:53211/')).toBe('http://127.0.0.1:53211/?host=vscode');
        const html = editorPageHtml('http://127.0.0.1:53211/', 'abc');
        expect(html).toContain(`default-src 'none'; frame-src http://127.0.0.1:53211; script-src 'nonce-abc'; style-src 'nonce-abc'`);
        expect(html).toContain('src="http://127.0.0.1:53211/?host=vscode"');
        expect(html).toContain('if (event.origin === origin) vscode.postMessage(event.data);');
    });

    it('opens a model to check when a property of it is false, the C4 map of a folder, and diagrams or C4 files', () => {
        mkdirSync(join(root, '.provenflow', 'vscode', 'models'), { recursive: true });
        writeFileSync(join(root, '.provenflow', 'vscode', 'models', 'lifecycle-Poller-timer.pflow'), 'diagram Poller\n');
        const model = modelDocument(root, 'lifecycle-Poller-timer', report)!;
        expect(model.title).toBe('lifecycle-Poller-timer.pflow');
        expect(model.message).toMatchObject({ provenflow: 'open-file', file: { kind: 'diagram', text: 'diagram Poller\n', check: true } });
        expect(modelDocument(root, 'gone', report)).toBeUndefined();
        expect(c4Document(root).message).toEqual({ provenflow: 'map-c4', path: root });
        expect(fileDocument('/w/docs/c4/workspace.dsl', 'workspace {}')?.message).toMatchObject({ file: { kind: 'c4', name: 'workspace.dsl' } });
        expect(fileDocument('/w/a.ts', '')).toBeUndefined();
        expect(['a.pflow', 'b.NXD', 'w.dsl', 'w.c4.json', 'x.json'].map(editorKindOf)).toEqual(['diagram', 'diagram', 'c4', 'c4', undefined]);
    });
});
