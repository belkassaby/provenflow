import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLES, generatePython, generateSmv, matchResults, parseDiagram } from '@provenflow/language';
import { runNurv } from '../src/nurv-runner.js';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { nuxmvInfo, runNuxmv, type RunnerConfig } from '../src/nuxmv-runner.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-nuxmv.mjs', import.meta.url));

function startServer(runner: RunnerConfig): Promise<{ url: string; server: Server }> {
    return new Promise(resolve => {
        const server = createApp({ runner }).listen(0, '127.0.0.1', () => {
            resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server });
        });
    });
}

describe('REST API (fake nuXmv)', () => {
    let url: string;
    let server: Server;
    beforeAll(async () => ({ url, server } = await startServer({ executable: FAKE, timeoutMs: 10_000, maxOutputBytes: 1_000_000 })));
    afterAll(() => server.close());

    const post = (body: unknown) =>
        fetch(`${url}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('reports the nuXmv version', async () => {
        const body = await (await fetch(`${url}/api/health`)).json();
        expect(body.nuxmv).toMatchObject({ available: true, version: 'nuXmv 9.9.9' });
    });

    it('runs a model and returns parsed results and traces', async () => {
        const res = await post({ model: 'MODULE main', engine: 'bdd' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.results).toHaveLength(1);
        expect(body.results[0].verdict).toBe('false');
        expect(body.results[0].trace.steps.map((s: { values: { state: string } }) => s.values.state)).toEqual(['s0', 's1']);
        expect(body.results[0].trace.loopStart).toBe(1);
    });

    it('generates the model from a diagram', async () => {
        const res = await post({ diagram: EXAMPLES[0].source, engine: 'bmc', bound: 7 });
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.model).toContain('MODULE main');
        expect(body.command).toContain('-bmc -bmc_length 7');
    });

    it('rejects invalid requests', async () => {
        expect((await post({})).status).toBe(400);
        expect((await post({ model: 'x', engine: 'magic' })).status).toBe(400);
        const res = await post({ diagram: 'state s0\ns0 -> nowhere;' });
        expect(res.status).toBe(422);
        expect((await res.json()).details[0].message).toMatch(/nowhere/);
    });

    it('surfaces nuXmv errors', async () => {
        const body = await (await post({ model: 'syntax-error' })).json();
        expect(body.exitCode).toBe(1);
        expect(body.errors[0]).toMatch(/syntax error/);
    });

    it('relays live state updates to subscribers over SSE', async () => {
        const send = (channel: string, body: unknown) =>
            fetch(`${url}/api/live/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        await send('test-1', { state: 's0', step: 0 });

        const controller = new AbortController();
        const stream = await fetch(`${url}/api/live/test-1/stream`, { signal: controller.signal });
        expect(stream.headers.get('content-type')).toContain('text/event-stream');
        const reader = stream.body!.getReader();
        const received: string[] = [];
        const statuses: string[] = [];
        const read = (async () => {
            const decoder = new TextDecoder();
            let buffer = '';
            while (received.length < 2) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value);
                // Unnamed messages are state updates; 'status' events report the machines listening.
                for (const block of buffer.split('\n\n')) {
                    const data = /^data: (.*)$/m.exec(block)?.[1];
                    if (!data) continue;
                    if (/^event: status$/m.test(block)) statuses.includes(data) || statuses.push(data);
                    else if (!received.includes(data)) received.push(data);
                }
            }
        })();
        await new Promise(r => setTimeout(r, 50));
        expect((await (await send('test-1', { state: 's1', step: 1, event: 'GO' })).json()).listeners).toBe(1);
        await read;
        controller.abort();
        // The last update is replayed to a new subscriber, then new ones follow.
        expect(received.map(r => JSON.parse(r).state)).toEqual(['s0', 's1']);
        expect(JSON.parse(received[1]).event).toBe('GO');
        expect(JSON.parse(received[0]).replayed).toBe(true); // sent before we subscribed
        expect(JSON.parse(received[1]).replayed).toBeUndefined();
        expect(statuses.map(x => JSON.parse(x).machines)).toEqual([0]); // no machine listens for commands
    });

    it('validates live channels and updates', async () => {
        const post = (path: string, body: unknown) =>
            fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect((await post('/api/live/bad%20name', { state: 's0' })).status).toBe(400);
        expect((await post('/api/live/ok', { nostate: true })).status).toBe(400);
    });

    const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);
    it.skipIf(!python)('two-way live link: the editor drives a running Python machine', async () => {
        const { model } = await parseDiagram(EXAMPLES.find(e => e.id === 'agent-tool-approval')!.source);
        const py = await generatePython(model);
        const dir = mkdtempSync(join(tmpdir(), 'pflow-live-'));
        writeFileSync(join(dir, `${py.moduleName}.py`), py.code);
        const proc = spawn(python!, ['-c', `
import time, ${py.moduleName} as m
fsm = m.${py.className}(on_invalid="return")
fsm.link_editor("${url}", channel="twoway", commands=True)
time.sleep(8)
`], { cwd: dir });
        try {
            const controller = new AbortController();
            const stream = await fetch(`${url}/api/live/twoway/stream`, { signal: controller.signal });
            const reader = stream.body!.getReader();
            const updates: Array<{ state: string; rejected?: unknown }> = [];
            const decoder = new TextDecoder();
            let buffer = '';
            void (async () => {
                for (;;) {
                    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
                    if (done) return;
                    buffer += decoder.decode(value);
                    updates.splice(0, updates.length, ...[...buffer.matchAll(/^data: (.*)$/gm)].map(m => JSON.parse(m[1])).filter(u => 'state' in u));
                }
            })();
            const waitFor = async (pred: () => boolean) => {
                for (let i = 0; i < 100 && !pred(); i++) await new Promise(r => setTimeout(r, 100));
                return pred();
            };
            expect(await waitFor(() => updates.some(u => u.state === 'writing'))).toBe(true);
            const command = async (event: string) => {
                // The machine may still be connecting its command stream: retry until it listens.
                for (let i = 0; i < 40; i++) {
                    const res = await fetch(`${url}/api/live/twoway/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }) });
                    if ((await res.json()).listeners > 0) return;
                    await new Promise(r => setTimeout(r, 100));
                }
                throw new Error('no listener');
            };
            await command('TOOL_CALL');
            expect(await waitFor(() => updates.some(u => u.state === 'approval_required'))).toBe(true);
            await command('ANSWER'); // not allowed in approval_required: rejected by the machine
            expect(await waitFor(() => updates.some(u => u.rejected))).toBe(true);
            controller.abort();
        } finally {
            proc.kill();
        }
    }, 20_000);

    it('reports a missing executable', async () => {
        const info = await nuxmvInfo({ executable: '/nonexistent/nuXmv', timeoutMs: 1000, maxOutputBytes: 1000 });
        expect(info.available).toBe(false);
    });
});

// Runs only when a real nuXmv is available, e.g. NUXMV_PATH=/opt/nuXmv/bin/nuXmv npm test
const real = process.env['NUXMV_PATH'];
describe.skipIf(!real)('real nuXmv', () => {
    const runner: RunnerConfig = { executable: real ?? '', timeoutMs: 60_000, maxOutputBytes: 5_000_000 };

    it.each(EXAMPLES.map(e => [e.id, e.source]))('verifies example %s with every engine', async (_id, source) => {
        const { model } = await parseDiagram(source);
        const text = generateSmv(model).text;
        for (const engine of ['bdd', 'bmc', 'ic3'] as const) {
            const result = await runNuxmv(text, { engine, bound: 10 }, runner);
            expect(result.errors, `${engine}: ${result.stdout}`).toEqual([]);
            expect(result.warnings.filter(w => /exhaustive/.test(w))).toEqual([]);
            const matched = matchResults(model.specs, result.results);
            if (engine === 'bdd') expect(matched.every(r => r !== undefined)).toBe(true);
        }
    });

    it.each(EXAMPLES.map(e => [e.id, e]))('gives the documented verdicts for %s', async (_id, example) => {
        const { model } = await parseDiagram(example.source);
        const result = await runNuxmv(generateSmv(model).text, { engine: 'bdd' }, runner);
        const verdicts = matchResults(model.specs, result.results).map(r => r?.verdict);
        expect(verdicts).toEqual(example.expected);
    });

    it('finds the mutual exclusion liveness counterexample', async () => {
        const { model } = await parseDiagram(EXAMPLES.find(e => e.id === 'mutex')!.source);
        const result = await runNuxmv(generateSmv(model).text, { engine: 'bdd' }, runner);
        const matched = matchResults(model.specs, result.results);
        expect(matched.map(r => r?.verdict)).toEqual(['true', 'false', 'true', 'true']);
        const trace = matched[1]!.trace!;
        expect(trace.loopStart).toBeDefined();
        expect(trace.steps[0].values['state']).toBe('s0');
    });

    it('needs fairness for the microwave property', async () => {
        const { model } = await parseDiagram(EXAMPLES.find(e => e.id === 'microwave')!.source);
        const unfair = { ...model, fairness: [] };
        const fair = matchResults(model.specs, (await runNuxmv(generateSmv(model).text, {}, runner)).results);
        const withoutFairness = matchResults(model.specs, (await runNuxmv(generateSmv(unfair).text, {}, runner)).results);
        expect(fair[0]?.verdict).toBe('true');
        expect(withoutFairness[0]?.verdict).toBe('false');
    });
});

// Runs only when NuRV is available, e.g. NURV_PATH=/opt/NuRV/NuRV npm test
const nurv = process.env['NURV_PATH'];
const py = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);
const cc = spawnSync('cc', ['--version']).status === 0;
describe.skipIf(!nurv || !py || !cc)('NuRV monitors', () => {
    it('generates full-LTL monitors that decide under the model assumptions', async () => {
        const source = EXAMPLES.find(e => e.id === 'agent-chat')!.source + '\nLTLSPEC NAME closes := F turn = closed;\nLTLSPEC NAME replies := G (turn = assistant -> F turn = user);\n';
        const { model } = await parseDiagram(source);
        const result = await runNurv(model, nurv!);
        expect(result.monitors.map(m => m.name)).toEqual(['closes', 'replies']);
        const dir = mkdtempSync(join(tmpdir(), 'pflow-nurv-'));
        for (const [name, content] of Object.entries(result.files)) writeFileSync(join(dir, name), content);
        for (const cmd of result.build) {
            const [bin, ...args] = cmd.split(' ');
            expect(spawnSync(bin, args, { cwd: dir }).status).toBe(0);
        }
        const gen = await generatePython(model);
        writeFileSync(join(dir, `${gen.moduleName}.py`), gen.code);
        const out = spawnSync(py!, ['-c', `
import ${gen.moduleName} as m, nurv_closes, nurv_replies
fsm = m.${gen.className}(strict=False)
closes, replies = fsm.add_nurv_monitor(nurv_closes), fsm.add_nurv_monitor(nurv_replies)
print(closes["verdict"], replies["verdict"])
for e in ["USER_MESSAGE", "TOOL_CALL", "APPROVE", "TOOL_RESPONSE", "REPLY"]:
    fsm.send(e)
print(closes["verdict"], replies["verdict"], fsm.state.value)
`], { cwd: dir, encoding: 'utf8' });
        // 'closed' is unreachable: false right away. Replies are not guaranteed by the model
        // (the assistant may keep calling tools), so that monitor stays undecided.
        expect(out.stdout.trim().split('\n')).toEqual(['false unknown', 'false unknown idle']);
    }, 120_000);
});

describe('POST /api/extract (code base models)', () => {
    const SHOP = fileURLToPath(new URL('../../extract/test/fixtures/shop', import.meta.url));
    const runner: RunnerConfig = { executable: '/nonexistent/nuXmv', timeoutMs: 10_000, maxOutputBytes: 1_000_000 };
    const servers: Server[] = [];
    afterAll(() => servers.forEach(s => s.close()));
    const start = (allowLocalPaths: boolean) =>
        new Promise<string>(resolve => {
            const server = createApp({ runner, allowLocalPaths }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
            servers.push(server);
        });
    const extract = (url: string, body: unknown) => fetch(`${url}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('analyses a folder of the server by path, with the models as .pflow text', async () => {
        const url = await start(true);
        expect((await (await fetch(`${url}/api/health`)).json()).extract).toMatchObject({ paths: true, apply: true });
        const res = await extract(url, { analyzers: false, path: SHOP, quickFixes: 0 });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.checkedWith).toBe('explicit');
        expect(body.findings.some((f: { rule: string }) => f.rule === 'resource-leak')).toBe(true);
        const order = body.models.find((m: { subject: string }) => m.subject === 'Order.status');
        expect(order.pflow).toContain('diagram Order_status');
        expect(body.markdown).toContain('# ProvenFlow code model report');
    });

    it('analyses uploaded files, with the config sent along', async () => {
        const url = await start(false);
        const files = {
            'src/poller.ts': 'export class Poller {\n    private timer?: ReturnType<typeof setInterval>;\n    start(): void {\n        this.timer = setInterval(() => undefined, 1000);\n    }\n    stop(): void {\n        clearInterval(this.timer);\n    }\n}\n'
        };
        const body = await (await extract(url, { analyzers: false, files, config: { ignore: [] }, quickFixes: 0 })).json();
        expect(body.root).toBe('(uploaded folder)');
        expect(body.findings.map((f: { rule: string }) => f.rule)).toContain('resource-leak');
    });

    it('streams the progress, then the report, when asked for NDJSON', async () => {
        const url = await start(true);
        const res = await fetch(`${url}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ analyzers: false, path: SHOP, quickFixes: 3 }) });
        expect(res.headers.get('content-type')).toContain('application/x-ndjson');
        const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
        const progress = lines.filter(l => l.progress).map(l => l.progress);
        expect(progress.map(p => p.phase)).toEqual(expect.arrayContaining(['parse', 'models', 'verify', 'fixes', 'done']));
        expect(progress.map(p => p.percent)).toEqual([...progress.map(p => p.percent)].sort((a, b) => a - b));
        expect(progress.at(-1)).toMatchObject({ phase: 'done', percent: 100 });
        expect(progress.find(p => p.phase === 'verify').message).toMatch(/^Checking model 1\/\d+/);
        expect(lines.at(-1).result.findings.length).toBeGreaterThan(0);
    });

    it('goes on when the connection drops, and is followed again by its id (with heartbeats)', async () => {
        const server = createApp({ runner, allowLocalPaths: true, heartbeatMs: 50 }).listen(0, '127.0.0.1');
        servers.push(server);
        await new Promise(ok => server.once('listening', ok));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const abort = new AbortController();
        const res = await fetch(`${base}/api/extract`, { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ analyzers: false, path: SHOP, quickFixes: 2 }) });
        const reader = res.body!.getReader();
        const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('\n')[0]) as { run: string };
        expect(first.run).toMatch(/^[0-9a-f-]{36}$/);
        abort.abort(); // the browser loses the connection
        const again = await fetch(`${base}/api/extract/runs/${first.run}`, { headers: { accept: 'application/x-ndjson' } });
        const lines = (await again.text()).trim().split('\n').map(l => JSON.parse(l));
        expect(lines[0]).toEqual({ run: first.run });
        expect(lines.at(-1).result.findings.length).toBeGreaterThan(0);
        expect((await fetch(`${base}/api/extract/runs/unknown`)).status).toBe(404);
    });

    it('re-runs a folder incrementally when asked, and fully otherwise', async () => {
        const url = await start(true);
        const body = { analyzers: false, path: SHOP, quickFixes: 0 };
        expect((await (await extract(url, body)).json()).incremental).toBeUndefined();
        const again = await (await extract(url, { ...body, incremental: true })).json();
        expect(again.incremental).toMatchObject({ changed: [] });
        expect(again).not.toHaveProperty('previous');
    });

    it('refuses paths when not allowed, and unsafe uploads', async () => {
        const url = await start(false);
        expect((await extract(url, { path: SHOP })).status).toBe(403);
        expect((await extract(url, { files: { '../escape.ts': 'x' } })).status).toBe(400);
        expect((await extract(url, {})).status).toBe(400);
    });
});

describe('one change for one finding: LLM fix, and Verify this version', () => {
    const SHOP = fileURLToPath(new URL('../../extract/test/fixtures/shop', import.meta.url));
    const runner: RunnerConfig = { executable: '/nonexistent/nuXmv', timeoutMs: 10_000, maxOutputBytes: 1_000_000 };
    let server: Server;
    let fake: Server;
    let url: string;
    let copy: string;
    const prompts: string[] = [];
    beforeAll(async () => {
        copy = mkdtempSync(join(tmpdir(), 'provenflow-single-'));
        cpSync(SHOP, copy, { recursive: true });
        const { createServer } = await import('node:http');
        // An OpenAI-compatible LLM that implements the suggested fix of the Poller leak.
        fake = createServer((req, res) => {
            let body = '';
            req.on('data', c => (body += c));
            req.on('end', () => {
                prompts.push(JSON.parse(body).messages[1].content);
                const edit = { file: 'src/ui/widgets.ts', search: "        this.timer = setInterval(() => console.log('tick'), 1000);", replace: "        clearInterval(this.timer);\n        this.timer = setInterval(() => console.log('tick'), 1000);" };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: [edit], explanation: 'Clears the previous timer before starting a new one.' }) } }] }));
            });
        });
        await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', () => resolve()));
        const { LlmSettingsStore } = await import('../src/llm-settings.js');
        const llmSettings = new LlmSettingsStore({ OPENAI_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` }, join(copy, 'no-settings.json'));
        await new Promise<void>(resolve => {
            server = createApp({ runner, allowLocalPaths: true, llmSettings }).listen(0, '127.0.0.1', () => {
                url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                resolve();
            });
        });
    });
    afterAll(() => {
        server.close();
        fake.close();
        rmSync(copy, { recursive: true, force: true });
    });
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('verifies the reviewed version: the fix, a version that does not fix it, and an unchanged one', async () => {
        const report = await (await post('/api/extract', { analyzers: false, path: copy, quickFixes: 20 })).json();
        const stale = report.findings.find((f: { rule: string }) => f.rule === 'stale-write-after-await');
        const [file] = stale.suggestedPatch.files as Array<{ file: string; before: string; after: string }>;
        const good = await (await post('/api/verify-change', { path: copy, finding: stale, changed: [{ file: file.file, after: file.after }] })).json();
        expect(good.finding.suggestedPatch).toMatchObject({ verified: true, by: 'your version' });
        expect(good.finding.suggestedPatch.files[0]).toMatchObject({ before: file.before, after: file.after });
        const commentOnly = await (await post('/api/verify-change', { path: copy, finding: stale, changed: [{ file: file.file, after: `// reviewed\n${file.before}` }] })).json();
        expect(commentOnly.finding.suggestedPatch.verified).toBe(false);
        expect(commentOnly.finding.suggestedPatch.note).toMatch(/still reported/);
        const same = await (await post('/api/verify-change', { path: copy, finding: stale, changed: [{ file: file.file, after: file.before }] })).json();
        expect(same.error).toMatch(/same as the files on disk/);
        expect(readFileSync(join(copy, file.file), 'utf8')).toBe(file.before); // nothing written
    });

    it("writes an LLM fix from the finding's suggested fix, shown before/after and verified", async () => {
        const report = await (await post('/api/extract', { analyzers: false, path: copy, quickFixes: 0 })).json();
        const leak = report.findings.find((f: { rule: string; subject: string }) => f.rule === 'resource-leak' && f.subject.startsWith('Poller'));
        const res = await (await post('/api/fix', { path: copy, finding: leak, llm: 'openai:test-model' })).json();
        expect(prompts.at(-1)).toContain(`Suggested fix: ${leak.fix}`);
        expect(prompts.at(-1)).toContain('(whole file, with line numbers for reference)');
        const patch = res.finding.suggestedPatch;
        expect(patch.by).toBe('openai:test-model');
        expect(patch.files[0].after).toContain('        clearInterval(this.timer);\n        this.timer = setInterval');
        expect(patch.diff).toContain('+        clearInterval(this.timer);');
        expect(typeof patch.verified).toBe('boolean');
        expect((await post('/api/fix', { path: copy, finding: leak })).status).toBe(400);
    });

    it('fixes without an LLM: the automatic fix on request, or a draft with the suggested fix', async () => {
        const report = await (await post('/api/extract', { analyzers: false, path: copy, quickFixes: 0 })).json();
        const stale = report.findings.find((f: { rule: string }) => f.rule === 'stale-write-after-await');
        expect(stale.suggestedPatch).toBeUndefined(); // no quick fixes were asked for
        const quick = await (await post('/api/fix', { path: copy, finding: stale, how: 'analysis' })).json();
        expect(quick.finding.suggestedPatch).toMatchObject({ verified: true, by: 'quick fix' });
        // A finding no automatic fix handles: the suggested fix as a comment where to change.
        const other = { ...stale, rule: 'some-rule', fix: 'Check the status again after the await.' };
        const draft = await (await post('/api/fix', { path: copy, finding: other, how: 'analysis' })).json();
        expect(draft.finding.suggestedPatch).toMatchObject({ verified: false, by: 'draft' });
        const [file] = draft.finding.suggestedPatch.files;
        expect(file.after.split('\n')[stale.loc.line - 1].trim()).toBe('// TODO(pflow some-rule): Check the status again after the await.');
        expect(readFileSync(join(copy, file.file), 'utf8')).toBe(file.before); // nothing written
    });

    it('streams what the LLM does (the stage, the answer, the tokens) and logs its usage', async () => {
        const report = await (await post('/api/extract', { analyzers: false, path: copy, quickFixes: 0 })).json();
        const leak = report.findings.find((f: { rule: string; subject: string }) => f.rule === 'resource-leak' && f.subject.startsWith('Poller'));
        const logs: string[] = [];
        const original = console.log;
        console.log = (line: string) => logs.push(line);
        try {
            const res = await fetch(`${url}/api/fix`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ path: copy, finding: leak, llm: 'openai:test-model' }) });
            const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
            const events = lines.filter(l => l.event).map(l => l.event.type);
            expect(events).toEqual(expect.arrayContaining(['stage', 'text']));
            expect(lines.at(-1).result.finding.suggestedPatch.llm.ms).toBeGreaterThanOrEqual(0);
        } finally {
            console.log = original;
        }
        expect(logs.some(l => /^\[llm\] openai:test-model fix resource-leak on Poller/.test(l))).toBe(true);
    });
});

describe('code changes: proposed, verified, applied', () => {
    const SHOP = fileURLToPath(new URL('../../extract/test/fixtures/shop', import.meta.url));
    const runner: RunnerConfig = { executable: '/nonexistent/nuXmv', timeoutMs: 10_000, maxOutputBytes: 1_000_000 };
    let server: Server;
    let url: string;
    let copy: string;
    beforeAll(async () => {
        copy = mkdtempSync(join(tmpdir(), 'provenflow-apply-'));
        cpSync(SHOP, copy, { recursive: true });
        await new Promise<void>(resolve => {
            server = createApp({ runner, allowLocalPaths: true }).listen(0, '127.0.0.1', () => {
                url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                resolve();
            });
        });
    });
    afterAll(() => {
        server.close();
        rmSync(copy, { recursive: true, force: true });
    });
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('proposes verified quick fixes with the whole files, and applies a reviewed one', async () => {
        const report = await (await post('/api/extract', { analyzers: false, path: copy })).json();
        expect(report.applicable).toBe(true);
        const stale = report.findings.find((f: { rule: string }) => f.rule === 'stale-write-after-await');
        expect(stale.suggestedPatch.verified).toBe(true);
        const file = stale.suggestedPatch.files[0];
        expect(file.file).toBe('src/core/order.ts');
        expect(file.after).toContain("if (this.status !== 'submitted') return;");

        const applied = await post('/api/apply', { root: report.root, file: file.file, before: file.before, after: file.after });
        expect(applied.status).toBe(200);
        expect(readFileSync(join(copy, 'src/core/order.ts'), 'utf8')).toBe(file.after);
        // The file changed since the analysis: a second apply of the old version is refused.
        expect((await post('/api/apply', { root: report.root, file: file.file, before: file.before, after: file.after })).status).toBe(409);

        const again = await (await post('/api/extract', { analyzers: false, path: copy, quickFixes: 0 })).json();
        expect(again.findings.some((f: { rule: string }) => f.rule === 'stale-write-after-await')).toBe(false);
    });

    it('applies several changes in one go, skipping one whose text another change already replaced', async () => {
        const report = await (await post('/api/extract', { analyzers: false, path: copy })).json();
        const change = report.findings.find((f: { rule: string; loc?: { file: string } }) => f.rule === 'unhandled-state' && f.loc?.file === 'src/core/order.ts');
        const leak = report.findings.find((f: { rule: string }) => f.rule === 'resource-leak');
        const res = await (await post('/api/apply-edits', {
            root: report.root,
            changes: [
                { id: 'cases', edits: change.suggestedPatch.edits },
                { id: 'leak', edits: leak.suggestedPatch.edits },
                { id: 'cases-again', edits: change.suggestedPatch.edits }
            ]
        })).json();
        expect(res.results.map((r: { id: string; status: string }) => `${r.id}:${r.status}`)).toEqual(['cases:applied', 'leak:applied', 'cases-again:conflict']);
        expect(readFileSync(join(copy, 'src/core/order.ts'), 'utf8')).toContain("case 'refunded':");
        expect(readFileSync(join(copy, 'src/ui/widgets.ts'), 'utf8')).toContain('dispose(): void');
        // The same fix proposed on the changed code only repeats lines already there: not applied twice.
        const widgets = readFileSync(join(copy, 'src/ui/widgets.ts'), 'utf8');
        const [edit] = leak.suggestedPatch.edits as Array<{ file: string; search: string; replace: string }>;
        const again = { file: edit.file, search: edit.replace, replace: edit.replace.replace('        clearInterval(this.timer); // release', '        clearInterval(this.timer); // release the previous one before acquiring again\n        clearInterval(this.timer); // release') };
        const twice = await (await post('/api/apply-edits', { root: report.root, changes: [{ id: 'leak', edits: [again] }] })).json();
        expect(twice.results[0]).toMatchObject({ status: 'conflict', message: expect.stringContaining('already in') });
        expect(readFileSync(join(copy, 'src/ui/widgets.ts'), 'utf8')).toBe(widgets);
    });

    it('refuses to write outside an analysed folder', async () => {
        expect((await post('/api/apply', { root: tmpdir(), file: 'x.ts', before: '', after: 'x' })).status).toBe(403);
        const report = await (await post('/api/extract', { analyzers: false, path: copy, quickFixes: 0 })).json();
        expect((await post('/api/apply', { root: report.root, file: '../escape.ts', before: '', after: 'x' })).status).toBe(400);
    });

    it('rejects an unknown LLM provider', async () => {
        expect((await post('/api/extract', { analyzers: false, path: copy, llm: 'nope:x' })).status).toBe(400);
    });
});

describe('LLM settings (Help → LLM settings)', () => {
    const runner: RunnerConfig = { executable: '/nonexistent/nuXmv', timeoutMs: 10_000, maxOutputBytes: 1_000_000 };
    let server: Server;
    let fake: Server;
    const workspaces: Array<string | undefined> = [];
    let url: string;
    let fakeUrl: string;
    let file: string;
    beforeAll(async () => {
        file = join(mkdtempSync(join(tmpdir(), 'provenflow-settings-')), 'llm.json');
        // A stand-in for the Anthropic API: answers OK when the key is right.
        const { createServer } = await import('node:http');
        fake = createServer((req, res) => {
            workspaces.push(req.headers['anthropic-workspace-id'] as string | undefined);
            const ok = req.headers['x-api-key'] === 'sk-ant-test-1234567890';
            res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
            res.end(JSON.stringify(ok ? { content: [{ type: 'text', text: 'OK' }] } : { error: 'bad key' }));
        });
        await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', () => resolve()));
        fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
        const { LlmSettingsStore } = await import('../src/llm-settings.js');
        await new Promise<void>(resolve => {
            server = createApp({ runner, allowLocalPaths: true, llmSettings: new LlmSettingsStore({}, file) }).listen(0, '127.0.0.1', () => {
                url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                resolve();
            });
        });
    });
    afterAll(() => {
        server.close();
        fake.close();
    });
    const call = (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

    it('keeps keys on the server, masked for the browser, and in a private file when remembered', async () => {
        const saved = await (await call('PUT', '/api/llm-settings', { anthropic: { apiKey: 'sk-ant-test-1234567890', model: 'claude-sonnet-5', baseUrl: fakeUrl }, preferred: 'anthropic', remember: true })).json();
        expect(saved.anthropic.key).toBe('sk-a…7890');
        expect(JSON.stringify(saved)).not.toContain('sk-ant-test-1234567890');
        expect(saved.configured.anthropic).toBe(true);
        expect(JSON.parse(readFileSync(file, 'utf8')).anthropic.apiKey).toBe('sk-ant-test-1234567890');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const health = await (await fetch(`${url}/api/health`)).json();
        expect(health.extract.llm.anthropic).toBe(true);
    });

    it('tests a provider with the saved key and model', async () => {
        const result = await (await call('POST', '/api/llm-settings/test', { provider: 'anthropic' })).json();
        expect(result).toMatchObject({ ok: true, spec: 'anthropic:claude-sonnet-5', answer: 'OK' });
    });

    it('sends the workspace ID for keys not scoped to a workspace, and clears it', async () => {
        const saved = await (await call('PUT', '/api/llm-settings', { anthropic: { workspaceId: 'wrkspc_01abc' } })).json();
        expect(saved.anthropic.workspaceId).toBe('wrkspc_01abc');
        await call('POST', '/api/llm-settings/test', { provider: 'anthropic' });
        expect(workspaces.at(-1)).toBe('wrkspc_01abc');
        expect((await call('PUT', '/api/llm-settings', { anthropic: { workspaceId: 'bad id!' } })).status).toBe(400);
        expect((await (await call('PUT', '/api/llm-settings', { anthropic: { workspaceId: '' } })).json()).anthropic.workspaceId).toBeUndefined();
    });

    it('takes a key out of pasted text, and refuses text that holds no key', async () => {
        const { apiKey } = await import('../src/llm-settings.js');
        expect(apiKey('anthropic', '"sk-ant-api03-abcdefghijklmnopqrstuvwx"')).toBe('sk-ant-api03-abcdefghijklmnopqrstuvwx');
        expect(apiKey('anthropic', '{ "ANTHROPIC_API_KEY": "sk-ant-api03-abcdefghijklmnopqrstuvwx" }')).toBe('sk-ant-api03-abcdefghijklmnopqrstuvwx');
        expect(() => apiKey('anthropic', 'anthropic: {"model": "claude-sonnet-5", "key": "cX"}')).toThrow(/starts with sk-ant-/);
        expect(apiKey('openai', 'local-server-key')).toBe('local-server-key');
        expect(() => apiKey('openai', '{"a": 1}')).toThrow(/Paste the key alone/);
        const res = await call('PUT', '/api/llm-settings', { anthropic: { apiKey: '{"type":"error"}' } });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/Claude Console/);
    });

    it('rejects bad input and forgets the file when not remembered', async () => {
        expect((await call('PUT', '/api/llm-settings', { openai: { baseUrl: 'not a url' } })).status).toBe(400);
        await call('PUT', '/api/llm-settings', { remember: false });
        expect(existsSync(file)).toBe(false);
        const cleared = await (await call('PUT', '/api/llm-settings', { anthropic: { clearKey: true } })).json();
        expect(cleared.anthropic.key).toBeUndefined();
    });
});
