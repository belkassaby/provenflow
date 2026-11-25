import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { combineVerifiedFixes, commitFiles, extractProject, fixPullRequestBody, openFixPullRequest, pushCommit, readerAt, type Finding } from '../src/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'provenflow-fix-pr-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Jane', GIT_AUTHOR_EMAIL: 'jane@example.org', GIT_COMMITTER_NAME: 'Jane', GIT_COMMITTER_EMAIL: 'jane@example.org', GITHUB_ACTIONS: '' };

const POLLERS = `export class Poller {
    private timer?: ReturnType<typeof setInterval>;

    start(): void {
        this.timer = setInterval(() => undefined, 1000);
    }

    stop(): void {
        clearInterval(this.timer);
    }
}

export class Ticker {
    private handle?: ReturnType<typeof setInterval>;

    begin(): void {
        this.handle = setInterval(() => undefined, 500);
    }

    end(): void {
        clearInterval(this.handle);
    }
}
`;

function fixed(rule: string, file: string, search: string, replace: string, verified = true): Finding {
    return { rule, category: 'lifecycle', severity: 'warning', subject: rule, message: `${rule} found`, fix: 'fix it', loc: { file, line: 1 }, source: 'analysis', suggestedPatch: { diff: '', verified, note: `${rule} fixed`, edits: [{ file, search, replace }] } };
}

describe('verified fixes as one pull request', () => {
    it('applies each fix on top of the others, and leaves out the ones that clash or are not verified', () => {
        const files: Record<string, string> = { 'a.ts': 'one two three\n', 'b.ts': 'four\n' };
        const combined = combineVerifiedFixes(
            [fixed('first', 'a.ts', 'one', 'ONE'), fixed('second', 'a.ts', 'three', 'THREE'), fixed('clash', 'a.ts', 'one', '1'), fixed('unverified', 'b.ts', 'four', '4', false)],
            file => files[file]
        );
        expect(combined.files.get('a.ts')).toBe('ONE two THREE\n');
        expect(combined.applied.map(f => f.rule)).toEqual(['first', 'second']);
        expect(combined.skipped.map(s => s.finding.rule)).toEqual(['clash']);
        expect(fixPullRequestBody(combined, 'pull request #7')).toMatch(/### Fixed \(2\)[\s\S]*### Left out \(1\)[\s\S]*`a.ts:1` clash/);
    });

    it('commits the fixes of an analysis on a branch without touching the working tree, and pushes it', async () => {
        const remote = mkdtempSync(join(scratch, 'remote-'));
        const dir = mkdtempSync(join(scratch, 'work-'));
        const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
        git(remote, 'init', '-q', '--bare');
        git(dir, 'init', '-q');
        writeFileSync(join(dir, 'pollers.ts'), POLLERS);
        git(dir, 'add', '.');
        git(dir, 'commit', '-qm', 'pollers');
        git(dir, 'remote', 'add', 'origin', remote);
        const r = await extractProject(dir, { analyzers: false, confirm: false, config: { history: false, hotspots: false }, quickFixes: 20 });
        const combined = combineVerifiedFixes(r.findings, readerAt(dir, 'HEAD'));
        expect(combined.applied.map(f => f.rule)).toEqual(['resource-leak', 'resource-leak']);
        const commit = commitFiles(dir, combined.files, 'ProvenFlow: 2 verified fixes', 'HEAD', ENV);
        // The working tree and the index are as they were; the commit has both fixes.
        expect(git(dir, 'status', '--porcelain')).toBe('');
        expect(readFileSync(join(dir, 'pollers.ts'), 'utf8')).toBe(POLLERS);
        const after = git(dir, 'show', `${commit}:pollers.ts`);
        expect(after.match(/release the previous one/g)).toHaveLength(2);
        expect(git(dir, 'rev-parse', `${commit}^`)).toBe(git(dir, 'rev-parse', 'HEAD'));
        pushCommit(dir, commit, 'provenflow/fixes-main');
        expect(git(remote, 'rev-parse', 'provenflow/fixes-main')).toBe(commit);
    }, 120_000);

    it('opens the pull request of the branch, or updates the open one', async () => {
        const calls: string[] = [];
        const github = (open: unknown[]) =>
            (async (url: string, init?: RequestInit) => {
                calls.push(`${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`);
                if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(open), { status: 200 });
                return new Response(JSON.stringify({ html_url: 'https://github.com/acme/shop/pull/8' }), { status: 201 });
            }) as typeof fetch;
        const pr = { repository: 'acme/shop', branch: 'provenflow/fixes-pr-7', base: 'feature', title: 'ProvenFlow: 2 verified fixes', body: '...' };
        expect(await openFixPullRequest({ token: 't' }, pr, github([]))).toBe('https://github.com/acme/shop/pull/8');
        expect(calls[1]).toBe('POST /repos/acme/shop/pulls');
        calls.length = 0;
        await openFixPullRequest({ token: 't' }, pr, github([{ number: 8, html_url: 'x' }]));
        expect(calls[0]).toContain('head=acme%3Aprovenflow%2Ffixes-pr-7');
        expect(calls[1]).toBe('PATCH /repos/acme/shop/pulls/8');
    });
});
