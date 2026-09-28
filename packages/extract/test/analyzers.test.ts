import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ChangeChecker, detectChecks } from '../src/buildcheck.js';
import { extractProject, parseCbmcJson, parseEsbmc, parseKani, sarifToFindings, type Finding } from '../src/index.js';
import { declaredInCode, gradePatternFindings } from '../src/patterns.js';
import { emptyFacts } from '../src/ir.js';
import { annotations, checkPayload, onChanged, parseUnifiedDiff, publishReview, reviewComments, type ReviewPayload } from '../src/review.js';
import { findTool } from '../src/tools/process.js';
import { cleanStaleWorkspaces, materialize } from '../src/tools/workspace.js';
import { lstatSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';

const SHOP = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const SECURITY = fileURLToPath(new URL('./fixtures/security', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'provenflow-analyzers-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('tool output parsers', () => {
    it('reads CBMC failures and their trace', () => {
        const r = parseCbmcJson(JSON.stringify([
            { program: 'CBMC 6.11.0' },
            { result: [
                { description: 'dereference failure: pointer NULL in *p', property: 'first.pointer_dereference.1', status: 'FAILURE', sourceLocation: { file: 'native/buffer.c', line: '6' }, trace: [{ stepType: 'assignment', lhs: 'p', value: { data: '((int *)NULL)' }, sourceLocation: { file: 'native/buffer.c', line: '5' } }] },
                { description: 'array bounds', property: 'first.array_bounds.1', status: 'SUCCESS' }
            ] }
        ]));
        expect(r.status).toBe('refuted');
        expect(r.failures).toEqual([{ description: 'dereference failure: pointer NULL in *p', property: 'first.pointer_dereference.1', file: 'native/buffer.c', line: 6, trace: [{ state: 'p = ((int *)NULL)', file: 'native/buffer.c', line: 5 }] }]);
        expect(parseCbmcJson(JSON.stringify([{ result: [{ description: 'x', property: 'y', status: 'SUCCESS' }] }])).status).toBe('proved');
        expect(parseCbmcJson('not json').status).toBe('unknown');
    });

    it('reads ESBMC verdicts, violated properties and states', () => {
        const failed = parseEsbmc(`Counterexample:\n\nState 1 file native/buffer.c line 11 column 3 function ratio thread 0\n----------------------------------------------------\n  b = 0 (00000000)\n\nViolated property:\n  file native/buffer.c line 12 column 10 function ratio\n  division by zero\n  b != 0\n\nVERIFICATION FAILED\n`);
        expect(failed.status).toBe('refuted');
        expect(failed.failures[0]).toMatchObject({ description: 'division by zero', file: 'native/buffer.c', line: 12, trace: [{ state: 'b = 0 (00000000)', file: 'native/buffer.c', line: 11 }] });
        expect(parseEsbmc('...\nVERIFICATION SUCCESSFUL\n').status).toBe('proved');
        expect(parseEsbmc('ERROR: PARSING ERROR').status).toBe('unknown');
    });

    it('reads Kani harness results', () => {
        const r = parseKani(`Checking harness autoharness_add...\nVERIFICATION:- SUCCESSFUL\n\nChecking harness autoharness_div...\nFailed Checks: attempt to divide by zero\n File: "src/lib.rs", line 7, in div\nVERIFICATION:- FAILED\n`, 'core');
        expect(r.proofs.map(p => [p.subject, p.status])).toEqual([['add', 'proved'], ['div', 'refuted']]);
        expect(r.findings[0]).toMatchObject({ rule: 'kani:check-failed', subject: 'div', loc: { file: 'core/src/lib.rs', line: 7 } });
    });

    it('turns SARIF results (with code flows) into findings', () => {
        const [f] = sarifToFindings({ runs: [{
            tool: { driver: { name: 'CodeQL', rules: [{ id: 'js/sql-injection', shortDescription: { text: 'Database query built from user-controlled sources' }, help: { text: 'Use query parameters.' }, properties: { tags: ['security', 'external/cwe/cwe-089'], 'security-severity': '8.8' } }] } },
            results: [{ ruleId: 'js/sql-injection', level: 'error', message: { text: 'This query depends on a user-provided value.' },
                locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 14 } } }],
                codeFlows: [{ threadFlows: [{ locations: [{ location: { physicalLocation: { artifactLocation: { uri: 'src/api.ts' }, region: { startLine: 3 } } } }, { location: { physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 14 } } } }] }] }] }]
        }] }, '/project', 'codeql');
        expect(f).toMatchObject({ rule: 'codeql:js/sql-injection', category: 'security', severity: 'error', fix: 'Use query parameters.', loc: { file: 'src/db.ts', line: 14 }, source: 'codeql' });
        expect(f.message).toContain('data flows through 2 steps');
        expect(f.related?.[0]).toMatchObject({ file: 'src/api.ts', line: 3 });
    });
});

describe('bounded model checking of C (with a stand-in for CBMC)', () => {
    // Reports a division by zero in ratio() and proves every other function.
    const fake = join(scratch, 'cbmc');
    writeFileSync(fake, `#!/bin/sh
case "$*" in --version*) echo 6.11.0; exit 0;; esac
fn=""; prev=""
for a in "$@"; do [ "$prev" = "--function" ] && fn="$a"; prev="$a"; done
if [ "$fn" = "ratio" ]; then
  echo '[{"result":[{"description":"division by zero in a / b","property":"ratio.division-by-zero.1","status":"FAILURE","sourceLocation":{"file":"native/buffer.c","line":"12"},"trace":[{"stepType":"assignment","lhs":"b","value":{"data":"0"},"sourceLocation":{"file":"native/buffer.c","line":"11"}}]}]}]'
  exit 10
fi
echo '[{"result":[{"description":"ok","property":"p","status":"SUCCESS"}]}]'
`);
    chmodSync(fake, 0o755);

    it('proves the safe functions and reports the failing one with its counterexample', async () => {
        const saved = process.env['CBMC_PATH'];
        process.env['CBMC_PATH'] = fake;
        try {
            const r = await extractProject(SECURITY, { config: { include: ['native/**'], analyzers: { bmc: { tool: 'cbmc' }, semgrep: false, infer: false, kani: false } }, quickFixes: 0 });
            const f = r.findings.find(x => x.rule === 'cbmc:division-by-zero')!;
            expect(f).toMatchObject({ category: 'memory', severity: 'error', subject: 'ratio', loc: { file: 'native/buffer.c', line: 12 }, source: 'cbmc' });
            expect(f.counterexample?.[0].state).toBe('b = 0');
            expect(r.proofs.find(p => p.subject === 'clamp')).toMatchObject({ tool: 'cbmc', status: 'proved', bound: 8 });
            expect(r.proofs.find(p => p.subject === 'ratio')?.status).toBe('refuted');
            expect(r.tools.map(t => t.tool)).toContain('CBMC');
        } finally {
            if (saved === undefined) delete process.env['CBMC_PATH'];
            else process.env['CBMC_PATH'] = saved;
        }
    });
});

describe.skipIf(!findTool('cbmc') && !findTool('esbmc'))('bounded model checking of C with the real CBMC or ESBMC', () => {
    it('refutes the division by zero and proves clamp()', async () => {
        const r = await extractProject(SECURITY, { config: { include: ['native/**'], analyzers: { semgrep: false, infer: false, kani: false } }, quickFixes: 0, confirm: false });
        expect(r.findings.some(f => /^(cbmc|esbmc):division-by-zero$/.test(f.rule) && f.subject === 'ratio')).toBe(true);
        expect(r.proofs.find(p => p.subject === 'clamp')?.status).toBe('proved');
    }, 300_000);
});

describe.skipIf(!findTool('semgrep'))('Semgrep security and dataflow rules (needs semgrep)', () => {
    it('finds command injection, XSS and unsafe YAML, and verifies the autofixes', async () => {
        const r = await extractProject(SECURITY, { config: { analyzers: { infer: false, bmc: false } }, quickFixes: 50 });
        const rules = r.findings.map(f => f.rule);
        expect(rules).toEqual(expect.arrayContaining(['semgrep:js-command-injection', 'semgrep:js-xss-inner-html', 'semgrep:py-unsafe-yaml-load', 'semgrep:py-requests-no-verify']));
        const yaml = r.findings.find(f => f.rule === 'semgrep:py-unsafe-yaml-load')!;
        expect(yaml.suggestedPatch?.verified).toBe(true);
        expect(yaml.suggestedPatch?.checks?.find(c => c.name === 'Python compile')?.ok).toBe(true);
    });
});

describe.skipIf(!findTool('infer'))('Infer heap analysis (needs infer)', () => {
    it('finds the null dereference in Java and the leak in C', async () => {
        const r = await extractProject(SECURITY, { config: { analyzers: { semgrep: false, bmc: false } }, quickFixes: 0 });
        expect(r.findings.some(f => f.source === 'infer' && f.loc?.file === 'java/Repo.java')).toBe(true);
        expect(r.findings.some(f => f.source === 'infer' && f.loc?.file === 'native/buffer.c')).toBe(true);
    });
});

describe('counterexamples replayed on the real code', () => {
    const shop = extractProject(SHOP, { config: {}, quickFixes: 0 });

    it('starts a real Poller twice and counts the running timers', async () => {
        const f = (await shop).findings.find(x => x.rule === 'resource-leak' && x.subject.startsWith('Poller'))!;
        expect(f.confirmation).toMatchObject({ by: 'replay', status: 'confirmed' });
        expect(f.confirmation!.detail).toMatch(/2 timers are running/);
    });

    it('interleaves two calls on a real Order and loses a write', async () => {
        const f = (await shop).findings.find(x => x.rule === 'stale-write-after-await')!;
        expect(f.confirmation).toMatchObject({ by: 'replay', status: 'confirmed' });
        expect(f.confirmation!.detail).toMatch(/losing/);
    });
});

describe('build checks of a proposed change', () => {
    it('rejects a change that does not compile, and ignores checks already failing', async () => {
        const root = mkdtempSync(join(scratch, 'py-'));
        writeFileSync(join(root, 'ok.py'), 'x = 1\n');
        writeFileSync(join(root, 'broken.py'), 'def (:\n');
        const checks = detectChecks(root, ['ok.py', 'broken.py'], {});
        expect(checks.build.map(c => c.name)).toEqual(['Python compile']);
        const checker = new ChangeChecker(root, checks.build);
        expect((await checker.check(new Map([['ok.py', 'x = 2\n']]))).ok).toBe(true);
        const bad = await checker.check(new Map([['ok.py', 'x = (\n']]));
        expect(bad.ok).toBe(false);
        expect(bad.results[0].output).toMatch(/SyntaxError|never closed|invalid syntax/);
        // broken.py already fails: a change to it is not held against the change.
        expect(await checker.check(new Map([['broken.py', 'def f(:\n']]))).toMatchObject({ ok: true, ignored: ['Python compile'] });
    });
});

describe('pattern recognition confidence', () => {
    it('reads @pattern declarations above classes', () => {
        const root = mkdtempSync(join(scratch, 'pat-'));
        writeFileSync(join(root, 'a.ts'), '// provenflow: pattern builder\nexport class QueryBuilder {}\n\n/** @pattern observer */\nclass Bus {}\n// @pattern nonsense\nclass X {}\n');
        const facts = emptyFacts(root);
        const loc = (line: number) => ({ file: 'a.ts', line, column: 1 });
        facts.classes.push({ name: 'QueryBuilder', loc: loc(2) } as never, { name: 'Bus', loc: loc(5) } as never, { name: 'X', loc: loc(7) } as never);
        expect(declaredInCode(facts)).toEqual([{ subject: 'QueryBuilder', pattern: 'builder' }, { subject: 'Bus', pattern: 'observer' }]);
    });

    it('turns findings on heuristically recognised patterns into notes', () => {
        const finding = (subject: string): Finding => ({ rule: 'builder-unvalidated', category: 'pattern', severity: 'warning', subject, message: 'm', fix: 'f', source: 'nuxmv' });
        const graded = gradePatternFindings([finding('Q'), finding('S')], [
            { pattern: 'builder', subject: 'Q', loc: { file: 'a', line: 1, column: 1 }, evidence: '', confidence: 'heuristic' },
            { pattern: 'builder', subject: 'S', loc: { file: 'a', line: 1, column: 1 }, evidence: '', confidence: 'declared' }
        ]);
        expect(graded.map(f => f.severity)).toEqual(['info', 'warning']);
        expect(graded[0].message).toContain('@pattern builder');
    });
});

describe('pull request review', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,0 +4,2 @@\n+x\n+y\n@@ -9 +11 @@\n-z\n+w\ndiff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-q\n`;
    const changed = parseUnifiedDiff(diff);
    const finding = (line: number, extra: Partial<Finding> = {}): Finding => ({ rule: 'r', category: 'security', severity: 'error', subject: 's', message: 'msg', fix: 'fix it', loc: { file: 'src/a.ts', line, column: 1 }, source: 'semgrep', ...extra });

    it('reads the changed lines of a diff', () => {
        expect([...changed.get('src/a.ts')!]).toEqual([4, 5, 11]);
        expect(changed.has('gone.ts')).toBe(false);
    });

    it('keeps the findings on changed lines and turns verified changes into suggestions', () => {
        expect(onChanged([finding(4), finding(7), finding(11)], changed).map(f => f.loc!.line)).toEqual([4, 11]);
        expect(onChanged([finding(7)], changed, 'files')).toHaveLength(1);
        const file = 'l1\nl2\nl3\nconst a = el.innerHTML = v;\ny\n';
        const patched = finding(4, { suggestedPatch: { verified: true, note: 'the finding is gone', by: 'semgrep autofix', edits: [{ file: 'src/a.ts', search: 'innerHTML', replace: 'textContent' }] } as Finding['suggestedPatch'] });
        const [comment] = reviewComments([patched], changed, () => file);
        expect(comment).toMatchObject({ path: 'src/a.ts', line: 4, side: 'RIGHT' });
        expect(comment.body).toContain('```suggestion\nconst a = el.textContent = v;\n```');
    });

    /** A fake GitHub: pull request comments, issue comments, reviews and replies, kept in memory. */
    function fakeGithub(head = 'abc') {
        const inline: Array<{ id: number; body: string; in_reply_to_id?: number; path?: string }> = [];
        const issue: Array<{ id: number; body: string }> = [];
        const calls: string[] = [];
        let next = 1;
        const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
        const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
            const path = url.replace('https://api.github.com', '').replace(/[?&]per_page=100&page=\d+/, '');
            const method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(init.body) : undefined;
            calls.push(`${method} ${path}`);
            if (method === 'GET' && path === '/repos/o/r/pulls/7/comments') return json(inline);
            if (method === 'GET' && path === '/repos/o/r/issues/7/comments') return json(issue);
            if (method === 'GET' && path === '/repos/o/r/pulls/7') return json({ head: { sha: head } });
            if (method === 'POST' && path === '/repos/o/r/pulls/7/reviews') {
                for (const c of body.comments) inline.push({ id: next++, body: c.body, path: c.path });
                return json({ html_url: 'https://github.com/o/r/pull/7#review' });
            }
            const reply = /^\/repos\/o\/r\/pulls\/7\/comments\/(\d+)\/replies$/.exec(path);
            if (method === 'POST' && reply) {
                inline.push({ id: next++, body: body.body, in_reply_to_id: Number(reply[1]) });
                return json({});
            }
            if (method === 'POST' && path === '/repos/o/r/issues/7/comments') {
                issue.push({ id: next++, body: body.body });
                return json({ html_url: 'https://github.com/o/r/pull/7#summary' });
            }
            const edit = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path);
            if (method === 'PATCH' && edit) {
                issue.find(c => c.id === Number(edit[1]))!.body = body.body;
                return json({ html_url: 'https://github.com/o/r/pull/7#summary' });
            }
            return json({ message: 'not found' }, 404);
        }) as unknown as typeof fetch;
        return { inline, issue, calls, fetchImpl };
    }

    it('posts only new findings on later pushes, marks fixed ones, and keeps one summary', async () => {
        const gh = fakeGithub();
        const target = { token: 't', repository: 'o/r', pull: 7, commit: 'abc' };
        const leak = finding(4, { rule: 'resource-leak', subject: 'Poller' });
        const inj = finding(11, { rule: 'semgrep:js-command-injection', subject: 'exec' });
        const payload = (findings: Finding[], commit = 'abc'): ReviewPayload => ({ repository: 'o/r', pull: 7, commit, summary: '### ProvenFlow review', comments: reviewComments(findings, changed, () => undefined), keys: findings.map(f => `${f.rule}|${f.subject}|${f.loc?.file ?? ''}`) });
        // First push: both findings commented, one summary.
        expect(await publishReview(target, payload([leak, inj]), gh.fetchImpl)).toMatchObject({ posted: 2, alreadyReported: 0, fixed: 0 });
        expect(gh.issue).toHaveLength(1);
        // Second push, nothing new: no review, the summary is edited.
        expect(await publishReview({ ...target, commit: 'def' }, payload([leak, inj], 'def'), gh.fetchImpl)).toMatchObject({ posted: 0, alreadyReported: 2, fixed: 0 });
        expect(gh.calls.filter(c => c === 'POST /repos/o/r/pulls/7/reviews')).toHaveLength(1);
        expect(gh.issue).toHaveLength(1);
        // Third push: the leak is fixed: a reply under its comment, once.
        expect(await publishReview(target, payload([inj], 'f00'), gh.fetchImpl)).toMatchObject({ posted: 0, fixed: 1 });
        expect(await publishReview(target, payload([inj], 'f01'), gh.fetchImpl)).toMatchObject({ fixed: 0 });
        expect(gh.inline.filter(c => c.in_reply_to_id).map(c => c.body.split('\n')[0])).toEqual(['✓ No longer reported at f00.']);
        expect(gh.issue[0].body).toContain('0 new, 1 already reported, 0 no longer reported');
    });

    it('checks a review file from a fork against the pull request before posting it', async () => {
        const gh = fakeGithub('abc');
        const target = { token: 't', repository: 'o/r', pull: 7, commit: 'abc' };
        const ok: ReviewPayload = { repository: 'o/r', pull: 7, commit: 'abc', summary: 's', comments: [], keys: [] };
        await expect(checkPayload(target, ok, gh.fetchImpl)).resolves.toBeUndefined();
        await expect(checkPayload(target, { ...ok, commit: 'old' }, gh.fetchImpl)).rejects.toThrow(/made for old/);
        await expect(checkPayload(target, { ...ok, repository: 'x/y' }, gh.fetchImpl)).rejects.toThrow(/not o\/r/);
    });

    it('writes GitHub Actions annotations, escaped', () => {
        expect(annotations([finding(4, { message: 'a, b: 50%\nnext', fix: 'f' })])).toEqual(['::error file=src/a.ts,line=4,title=ProvenFlow r::a, b: 50%25%0AnextFix: f'.replace('nextFix', 'next%0AFix')]);
    });
});

describe('temporary copies of a project', () => {
    it('copies sources, links data, big files and build outputs, and writes the change', () => {
        const root = mkdtempSync(join(scratch, 'ws-'));
        mkdirSync(join(root, 'src'));
        mkdirSync(join(root, 'dist'));
        mkdirSync(join(root, 'data'));
        writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
        writeFileSync(join(root, 'data/slide.tif'), Buffer.alloc(10));
        writeFileSync(join(root, 'data/huge.json'), 'x'.repeat(1_000_001));
        writeFileSync(join(root, 'dist/out.js'), '');
        const ws = materialize(root, new Map([['src/a.ts', 'export const a = 2;\n']]));
        try {
            expect(readFileSync(join(ws.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
            expect(lstatSync(join(ws.dir, 'src/a.ts')).isSymbolicLink()).toBe(false);
            expect(lstatSync(join(ws.dir, 'data/slide.tif')).isSymbolicLink()).toBe(true);
            expect(lstatSync(join(ws.dir, 'data/huge.json')).isSymbolicLink()).toBe(true);
            expect(lstatSync(join(ws.dir, 'dist')).isSymbolicLink()).toBe(true);
            expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
        } finally {
            ws.dispose();
        }
    });

    it('links the dependencies by absolute path, also for a project given by a relative path', () => {
        const root = mkdtempSync(join(scratch, 'rel-'));
        mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
        writeFileSync(join(root, 'a.ts'), '');
        const cwd = process.cwd();
        process.chdir(root);
        try {
            const ws = materialize('.', new Map());
            try {
                expect(readFileSync(join(ws.dir, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1;');
            } finally {
                ws.dispose();
            }
        } finally {
            process.chdir(cwd);
        }
    });

    it('removes the folders left by interrupted analyses, not recent ones', () => {
        const tmp = mkdtempSync(join(scratch, 'tmp-'));
        mkdirSync(join(tmp, 'provenflow-ws-old'));
        mkdirSync(join(tmp, 'provenflow-ws-new'));
        mkdirSync(join(tmp, 'someone-else'));
        const hourAgo = new Date(Date.now() - 3_600_000);
        utimesSync(join(tmp, 'provenflow-ws-old'), hourAgo, hourAgo);
        utimesSync(join(tmp, 'someone-else'), hourAgo, hourAgo);
        expect(cleanStaleWorkspaces(10 * 60_000, tmp)).toBe(1);
        expect(readdirSync(tmp).sort()).toEqual(['provenflow-ws-new', 'someone-else']);
    });
});
