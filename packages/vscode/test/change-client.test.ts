import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeLine, changeOf, fixChoices, fixRequest, llmSpecs, manualChange, postChange, proposedChange, verifyRequest, type LlmSettingsView } from '../src/change-client';
import type { ReportFinding } from '../src/report';

const complex: ReportFinding = { rule: 'cognitive-complexity', severity: 'warning', source: 'quality', subject: 'renderStitched', message: 'Too complex.', fix: 'Split it.', loc: { file: 'src/scene.ts', line: 210 } };
const leak: ReportFinding = { ...complex, rule: 'resource-leak', subject: 'Poller', suggestedPatch: { verified: true, note: 'clears it', files: [{ file: 'src/poller.ts', after: 'fixed' }] } };
const semgrep: ReportFinding = { ...complex, rule: 'js.eval', source: 'semgrep' };
const settings: LlmSettingsView = { anthropic: { model: 'claude-sonnet-5' }, openai: { model: 'gpt-4.1' }, ollama: { model: 'qwen2.5-coder' }, preferred: 'openai', configured: { anthropic: true, openai: true, ollama: true } };

describe('the ways to fix a finding', () => {
    it('lists the LLMs set up on the server, the preferred one first', () => {
        expect(llmSpecs(settings).map(l => l.spec)).toEqual(['openai:gpt-4.1', 'anthropic:claude-sonnet-5', 'ollama:qwen2.5-coder']);
        expect(llmSpecs({ ...settings, preferred: undefined, configured: { ollama: true } }).map(l => l.spec)).toEqual(['ollama:qwen2.5-coder']);
        expect(llmSpecs(undefined)).toEqual([]);
    });

    it('offers the proposed fix first, then without and with an LLM, then by hand', () => {
        expect(fixChoices(leak, settings).map(c => c.how.kind)).toEqual(['proposed', 'analysis', 'llm', 'llm', 'llm', 'manual']);
        expect(fixChoices(leak, settings)[0].label).toBe('Review the verified fix');
    });

    it('offers to set up an LLM when only the local one is available', () => {
        const kinds = fixChoices(complex, { ...settings, configured: { ollama: true } }).map(c => c.how.kind);
        expect(kinds).toEqual(['analysis', 'llm', 'manual', 'llm-settings']);
        expect(fixChoices(complex, undefined).map(c => c.how.kind)).toEqual(['analysis', 'manual', 'llm-settings']);
    });

    it('asks the server for the analysis or the LLM fix, with the analysers only for their own findings', () => {
        expect(fixRequest('/w', complex, { kind: 'analysis' })).toEqual({ path: '/w', finding: complex, analyzers: false, how: 'analysis' });
        expect(fixRequest('/w', semgrep, { kind: 'llm', spec: 'anthropic:m' })).toEqual({ path: '/w', finding: semgrep, analyzers: true, llm: 'anthropic:m' });
        expect(verifyRequest('/w', complex, [{ file: 'a.ts', after: 'x' }])).toEqual({ path: '/w', finding: complex, analyzers: false, changed: [{ file: 'a.ts', after: 'x' }] });
    });
});

describe('the changes to review', () => {
    const read = (file: string) => (file === 'src/scene.ts' ? 'now' : file === 'src/poller.ts' ? 'leaky' : undefined);

    it('takes a proposed fix with the files as they are when the report does not keep them', () => {
        expect(proposedChange(leak, read)).toEqual({ finding: leak, title: 'verified fix', verified: true, note: 'clears it', files: [{ file: 'src/poller.ts', before: 'leaky', after: 'fixed' }] });
        expect(proposedChange(complex, read)).toBeUndefined();
    });

    it('starts a fix by hand from the file as it is', () => {
        expect(manualChange(complex, read)?.files).toEqual([{ file: 'src/scene.ts', before: 'now', after: 'now' }]);
        expect(manualChange({ ...complex, loc: undefined }, read)).toBeUndefined();
    });

    it('reads the change of a result, or why there is none', () => {
        const patched = { ...complex, suggestedPatch: { verified: false, note: 'draft', files: [{ file: 'src/scene.ts', before: 'now', after: '// TODO\nnow' }] } };
        expect(changeOf({ finding: patched }, 'fix by the analysis')).toMatchObject({ verified: false, note: 'draft', files: [{ before: 'now' }] });
        expect(changeOf({ finding: complex, error: 'anthropic:m proposed no edit for this finding.' }, 't')).toEqual({ error: 'anthropic:m proposed no edit for this finding.' });
    });

    it('reads the lines of the server answer', () => {
        expect(changeLine('{"event":{"type":"stage","text":"Verifying…"}}')).toEqual({ stage: 'Verifying…' });
        expect(changeLine('{"event":{"type":"thinking","text":"hmm"}}')).toBeUndefined();
        expect(changeLine('{"result":{"error":"none"}}')).toEqual({ result: { error: 'none' } });
        expect(changeLine('{"error":"busy"}')).toEqual({ error: 'busy' });
        expect(changeLine('not json')).toBeUndefined();
    });
});

describe('posting a change to the editor server', () => {
    let server: Server;
    let url: string;
    const asked: unknown[] = [];

    beforeAll(async () => {
        server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => (body += String(chunk)));
            req.on('end', () => {
                asked.push({ path: req.url, accept: req.headers.accept, body: JSON.parse(body) });
                if (req.url === '/api/verify-change') return void res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Provide \'changed\'."}');
                res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                res.write('{"event":{"type":"stage","text":"Analysing…"}}\n{"event":{"type":"st');
                setTimeout(() => res.end('age","text":"Verifying…"}}\n{"result":{"finding":{"rule":"r"}}}\n'), 20);
            });
        });
        await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });

    afterAll(() => new Promise<void>(done => server.close(() => done())));

    it('streams the stages, split anywhere, then resolves with the result', async () => {
        const stages: string[] = [];
        const result = await postChange(url, 'api/fix', { finding: complex }, s => stages.push(s));
        expect(stages).toEqual(['Analysing…', 'Verifying…']);
        expect(result).toEqual({ finding: { rule: 'r' } });
        expect(asked[0]).toMatchObject({ path: '/api/fix', accept: 'application/x-ndjson', body: { finding: { rule: 'cognitive-complexity' } } });
    });

    it('rejects with the server reason', async () => {
        await expect(postChange(url, 'api/verify-change', {}, () => undefined)).rejects.toThrow("Provide 'changed'.");
    });
});
