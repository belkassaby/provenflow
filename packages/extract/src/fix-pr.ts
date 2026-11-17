/**
 * Every verified fix of a run as one pull request: the fixes are combined (each applied on top of the
 * others; one that no longer applies is left out and named), committed on a branch without touching the
 * working tree (git plumbing on a separate index), pushed, and proposed as a pull request, or the
 * existing one for that branch is updated.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isApplied } from './fixes.js';
import type { Finding } from './models.js';
import { githubApi, type GithubTarget } from './review.js';

export interface CombinedFixes {
    /** The new text of each changed file (relative to the analysed folder). */
    files: Map<string, string>;
    applied: Finding[];
    skipped: Array<{ finding: Finding; reason: string }>;
}

type Change = Map<string, string> | string;

/** The verified fixes of `findings`, each applied on top of the ones before it. */
export function combineVerifiedFixes(findings: Finding[], read: (file: string) => string | undefined): CombinedFixes {
    const files = new Map<string, string>();
    const current = (file: string) => (files.has(file) ? files.get(file) : read(file));
    const out: CombinedFixes = { files, applied: [], skipped: [] };
    for (const f of findings.filter(x => x.suggestedPatch?.verified)) {
        const change = changeOf(f, current, files);
        if (typeof change === 'string') {
            out.skipped.push({ finding: f, reason: change });
            continue;
        }
        for (const [file, text] of change) files.set(file, text);
        out.applied.push(f);
    }
    return out;
}

/** The files one fix changes, from its edits (on top of earlier fixes), else its whole files (only if no earlier fix touched them). */
function changeOf(f: Finding, current: (file: string) => string | undefined, changed: Map<string, string>): Change {
    const patch = f.suggestedPatch!;
    if (patch.edits?.length) return applyEdits(patch.edits, current);
    const whole = patch.files ?? [];
    if (!whole.length) return 'the fix has no edits';
    const clash = whole.find(p => changed.has(p.file));
    if (clash) return `an earlier fix already changed ${clash.file}`;
    const moved = whole.find(p => current(p.file) !== p.before);
    return moved ? `${moved.file} is not the version the fix was made for` : new Map(whole.map(p => [p.file, p.after]));
}

/** The new texts of the files a list of search/replace edits changes, or why they cannot be applied. */
export function applyEdits(edits: Array<{ file: string; search: string; replace: string }>, current: (file: string) => string | undefined): Change {
    const pending = new Map<string, string>();
    for (const e of edits) {
        const text = pending.get(e.file) ?? current(e.file);
        if (text === undefined && e.search === '') {
            pending.set(e.file, e.replace);
            continue;
        }
        if (isApplied(text, e)) return `it is already in ${e.file}`;
        if (text === undefined || text.split(e.search).length !== 2) return `${e.file} no longer contains the text it replaces (another fix changed it)`;
        pending.set(e.file, text.replace(e.search, () => e.replace));
    }
    return pending.size ? pending : 'nothing to change';
}

const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

/** The text of a file of the analysed folder at a commit (undefined when it does not exist there). */
export function readerAt(root: string, commit: string): (file: string) => string | undefined {
    return file => {
        const r = spawnSync('git', ['show', `${commit}:./${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return r.status === 0 ? r.stdout : undefined;
    };
}

/**
 * A commit on top of `parent` with the files replaced, made on a separate index so the working tree
 * and the index stay as they are. Returns the commit's hash.
 */
export function commitFiles(root: string, files: Map<string, string>, message: string, parent = 'HEAD', env: NodeJS.ProcessEnv = process.env): string {
    const git = (args: string[], options: { input?: string; index?: string } = {}) => {
        const identity = env['GITHUB_ACTIONS'] === 'true' ? { GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email, GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email } : {};
        const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', input: options.input, env: { ...env, ...identity, ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) } });
        if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
        return r.stdout.trim();
    };
    const prefix = git(['rev-parse', '--show-prefix']);
    const work = mkdtempSync(join(tmpdir(), 'provenflow-fix-pr-'));
    const index = join(work, 'index');
    try {
        git(['read-tree', parent], { index });
        for (const [file, text] of files) {
            const path = `${prefix}${file}`;
            const mode = /^(\d+) /.exec(git(['ls-files', '-s', '--', path], { index }))?.[1] ?? '100644';
            const blob = git(['hash-object', '-w', '--stdin'], { input: text });
            git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { index });
        }
        const tree = git(['write-tree'], { index });
        return git(['commit-tree', tree, '-p', parent, '-F', '-'], { input: message });
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

/** Pushes a commit to a branch of `origin` (replacing what the branch had: it only ever holds ProvenFlow's fixes). */
export function pushCommit(root: string, commit: string, branch: string): void {
    const r = spawnSync('git', ['push', '--force', 'origin', `${commit}:refs/heads/${branch}`], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git push failed: ${r.stderr.trim()}`);
}

export interface FixPullRequest {
    repository: string;
    branch: string;
    /** The branch the fixes are proposed for (the pull request's own branch, or the default branch). */
    base: string;
    title: string;
    body: string;
}

/** Opens the pull request of a branch, or updates the open one. Returns its URL. */
export async function openFixPullRequest(target: Pick<GithubTarget, 'token' | 'apiUrl'>, pr: FixPullRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
    const api = githubApi({ ...target, repository: pr.repository, pull: 0, commit: '' }, fetchImpl);
    const repo = `/repos/${pr.repository}`;
    const owner = pr.repository.split('/')[0];
    const open = await api.all<{ number: number; html_url: string }>(`${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.branch}`)}`);
    const res = open.length
        ? await api.call('PATCH', `${repo}/pulls/${open[0].number}`, { title: pr.title, body: pr.body })
        : await api.call('POST', `${repo}/pulls`, { title: pr.title, body: pr.body, head: pr.branch, base: pr.base });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} ${open.length ? 'updating' : 'opening'} the pull request: ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { html_url: string }).html_url;
}

/** The description of the pull request: the fixes it makes and those it leaves out. */
export function fixPullRequestBody(combined: CombinedFixes, about: string): string {
    const line = (f: Finding) => `${f.loc ? `\`${f.loc.file}:${f.loc.line}\`` : `\`${f.subject}\``} ${f.rule}: ${f.message.split('\n')[0]}`;
    return [
        `ProvenFlow's verified fixes for ${about}. Each was checked by running the analysis${combined.applied.some(f => f.suggestedPatch?.checks?.length) ? ', the build and the tests' : ''} again on the changed code: the finding is gone and nothing new appears.`,
        '',
        `### Fixed (${combined.applied.length})`,
        '',
        ...combined.applied.map(f => `- ${line(f)}\n  ${f.suggestedPatch!.note.split('\n')[0]}`),
        '',
        ...(combined.skipped.length ? [`### Left out (${combined.skipped.length})`, '', ...combined.skipped.map(s => `- ${line(s.finding)}: ${s.reason}.`), ''] : [])
    ].join('\n');
}
