import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveMcp } from '../src/mcp.js';

const QUALITY = fileURLToPath(new URL('../../extract/test/fixtures/quality', import.meta.url));
const CLI = fileURLToPath(new URL('../out/cli.js', import.meta.url));
const built = existsSync(CLI);
const CONFIG = { layers: [{ name: 'core', paths: ['src/core/**'], mayImport: [] }, { name: 'ui', paths: ['src/ui/**'], mayImport: ['core'] }] };

/** A git repository with the quality fixture committed. */
function repository(): string {
    const dir = mkdtempSync(join(tmpdir(), 'provenflow-agents-'));
    cpSync(QUALITY, dir, { recursive: true });
    writeFileSync(join(dir, 'provenflow.config.json'), JSON.stringify(CONFIG));
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    return dir;
}

function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Jane', GIT_AUTHOR_EMAIL: 'jane@example.org', GIT_COMMITTER_NAME: 'Jane', GIT_COMMITTER_EMAIL: 'jane@example.org' } });
}

const COPY = `export function couponTotal(rows: { price: number; quantity: number; category: string }[], rate: number): number {
    let acc = 0;
    for (const row of rows) {
        const value = row.price * row.quantity;
        const duty = value * rate;
        if (row.category === 'food') {
            acc += value;
        } else if (row.category === 'books') {
            acc += value + duty / 2;
        } else if (row.category === 'toys') {
            acc += value + duty * 2;
        } else if (row.category === 'music') {
            acc += value + duty * 3;
        } else {
            acc += value + duty;
        }
    }
    return acc;
}
`;

describe('MCP server', () => {
    let dir: string;
    beforeAll(() => (dir = repository()));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function session(requests: unknown[]): Promise<Array<{ id: number; result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }> }; error?: unknown }>> {
        const input = new PassThrough();
        const output = new PassThrough();
        const chunks: string[] = [];
        output.on('data', c => chunks.push(String(c)));
        const done = serveMcp(input, output);
        for (const r of requests) input.write(`${JSON.stringify(r)}\n`);
        input.end();
        await done;
        return chunks.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
    }

    it('lists its tools and answers with the project conventions, existing code and the review of a change', async () => {
        const replies = await session([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_conventions', arguments: { path: dir } } },
            { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find_existing_code', arguments: { path: dir, code: COPY, language: 'ts' } } },
            { jsonrpc: '2.0', id: 6, method: 'nope' }
        ]);
        // The agent wrote the copy anyway: the review of its change says so.
        writeFileSync(join(dir, 'src/ui/coupons.ts'), COPY);
        replies.splice(4, 0, ...(await session([{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'review_changes', arguments: { path: dir } } }])));
        expect(replies.map(r => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(replies[1].result!.tools!.map(t => t.name)).toEqual(['project_conventions', 'find_existing_code', 'review_changes', 'propose_fix']);
        expect(replies[2].result!.content![0].text).toMatch(/ui \(src\/ui\/\*\*\): may import core/);
        expect(replies[3].result!.content![0].text).toMatch(/totalPrice|cartTotal/);
        expect(replies[4].result!.content![0].text).toMatch(/duplicated-code/);
        expect(replies[5].error).toBeTruthy();
    });
});

describe.skipIf(!built)('pflow commands (built CLI)', () => {
    let dir: string;
    beforeAll(() => (dir = repository()));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const pflow = (args: string[], input?: string) => spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8', input });

    it('baseline: only findings beyond it fail; --update only shrinks it', () => {
        expect(pflow(['extract', '.', '--no-analyzers', '--no-confirm', '--no-baseline', '-q', '-o', join(dir, '.out')]).status).toBe(5);
        expect(pflow(['baseline', '.', '--no-analyzers', '-q']).status).toBe(0);
        const baseline = JSON.parse(readFileSync(join(dir, 'provenflow-baseline.json'), 'utf8')) as { entries: unknown[] };
        expect(baseline.entries.length).toBeGreaterThan(3);
        expect(pflow(['extract', '.', '--no-analyzers', '--no-confirm', '-q', '-o', join(dir, '.out')]).status).toBe(0);
        writeFileSync(join(dir, 'src/ui/coupons.ts'), COPY);
        const after = pflow(['extract', '.', '--no-analyzers', '--no-confirm', '--fail-on', 'warning', '-o', join(dir, '.out')]);
        expect(after.status).toBe(5);
        expect(after.stdout).toMatch(/New findings:[\s\S]*src\/ui\/coupons.ts/);
        rmSync(join(dir, 'src/ui/coupons.ts'));
    });

    it('hook post-edit: exit 2 with the findings of the file just written', () => {
        writeFileSync(join(dir, 'src/ui/coupons.ts'), COPY);
        const r = pflow(['hook', 'post-edit'], JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, 'src/ui/coupons.ts') } }));
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/duplicated-code/);
        expect(pflow(['hook', 'stop'], JSON.stringify({ cwd: dir, stop_hook_active: true })).status).toBe(0);
        rmSync(join(dir, 'src/ui/coupons.ts'));
        expect(pflow(['hook', 'stop'], JSON.stringify({ cwd: dir })).status).toBe(0);
    });

    it('compare: the quality of two versions side by side', () => {
        writeFileSync(join(dir, 'src/ui/coupons.ts'), COPY);
        const r = pflow(['compare', '.', '--base', 'HEAD', '-q']);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/\| clones \(copied blocks\) \| 1 \| 2 \| \+1 \(\+100%\) ✗ \|/);
        rmSync(join(dir, 'src/ui/coupons.ts'));
    });

    it('init: a config proposed from the code and the language standards', () => {
        const out = join(dir, 'proposed.json');
        const r = pflow(['init', '.', '-o', out]);
        expect(r.status).toBe(0);
        const config = JSON.parse(readFileSync(out, 'utf8'));
        expect(config.languages.typescript.limits.functionLines).toBe(50);
        expect(config.languages.python.naming.function).toBe('snake_case');
        expect(config.baseline).toBe('provenflow-baseline.json');
    });
});
