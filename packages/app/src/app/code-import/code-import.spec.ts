import { TestBed } from '@angular/core/testing';
import { CodeImport } from './code-import';

/** A file as the browser gives it for a picked folder. */
function file(path: string, text = 'x'): File {
    const f = new File([text], path.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: path });
    return f;
}

describe('CodeImport', () => {
    it('uploads the sources of a picked folder, relative to it, without dependencies or build output', async () => {
        const service = TestBed.inject(CodeImport);
        let sent: { files: Record<string, string> } | undefined;
        const original = globalThis.fetch;
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            sent = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ root: '', files: 1, findings: [], models: [], verdicts: [], patterns: [], paradigm: [], architecture: { edges: [] }, notes: [], summary: { error: 0, warning: 0, info: 0 }, checkedWith: 'explicit', markdown: '' }), { status: 200 });
        }) as typeof fetch;
        try {
            const files = [
                file('shop/src/order.ts', 'export class Order {}'),
                file('shop/src/order.html'),
                file('shop/jobs/jobs.py'),
                file('shop/package.json', '{}'),
                file('shop/provenflow.config.json', '{}'),
                file('shop/node_modules/lib/index.ts'),
                file('shop/dist/main.js'),
                file('shop/src/types.d.ts'),
                file('shop/README.md'),
                file('shop/core/Job.java'),
                file('shop/core/target/Job.class'),
                file('shop/lib/job.rs'),
                file('shop/R/job.R')
            ];
            await service.analyseFolder(files as unknown as FileList);
            expect(Object.keys(sent!.files).sort()).toEqual(['R/job.R', 'core/Job.java', 'jobs/jobs.py', 'lib/job.rs', 'package.json', 'provenflow.config.json', 'src/order.html', 'src/order.ts']);
            expect(sent!.files['src/order.ts']).toBe('export class Order {}');
            expect(service.report()?.root).toBe('shop');
        } finally {
            globalThis.fetch = original;
        }
    });

    it('remembers the folder paths analysed, the last first, and reuses the last run of a known folder', async () => {
        localStorage.removeItem('provenflow.code-paths');
        const service = TestBed.inject(CodeImport);
        const sent: Array<{ path: string; incremental: boolean }> = [];
        const original = globalThis.fetch;
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ root: '', files: 1, findings: [], models: [], verdicts: [], patterns: [], paradigm: [], architecture: { edges: [] }, notes: [], summary: { error: 0, warning: 0, info: 0 }, checkedWith: 'explicit', markdown: '' }), { status: 200 });
        }) as typeof fetch;
        try {
            await service.analysePath('/work/a ');
            await service.analysePath('/work/b');
            await service.analysePath('/work/a');
            expect(service.recentPaths()).toEqual(['/work/a', '/work/b']);
            expect(JSON.parse(localStorage.getItem('provenflow.code-paths')!)).toEqual(['/work/a', '/work/b']);
            expect(sent.map(b => [b.path, b.incremental])).toEqual([['/work/a', false], ['/work/b', false], ['/work/a', true]]);
            service.reuseLastRun.set(false);
            await service.analysePath('/work/b');
            expect(sent.at(-1)!.incremental).toBe(false);
        } finally {
            globalThis.fetch = original;
            localStorage.removeItem('provenflow.code-paths');
        }
    });

    it('reports a folder without sources', async () => {
        const service = TestBed.inject(CodeImport);
        await service.analyseFolder([file('docs/readme.md')] as unknown as FileList);
        expect(service.error()).toContain('No source files');
    });
});
