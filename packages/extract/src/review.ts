/**
 * Pull-request review: the findings on the lines a change touches (diff-time reporting, which gets
 * findings fixed far more often than batch reports), posted as a GitHub review. Each comment has the
 * finding, its fix, the counterexample and whether it was confirmed on the code; a verified code
 * change becomes a GitHub suggestion the author applies with one click.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractionResult } from './index.js';
import { formatLocation } from './ir.js';
import type { Finding } from './models.js';
import { findingKey } from './incremental.js';

/** New-file line numbers added or changed, per file (from `git diff --unified=0`). */
export type ChangedLines = Map<string, Set<number>>;

export function parseUnifiedDiff(diff: string): ChangedLines {
    const changed: ChangedLines = new Map();
    let file: string | undefined;
    for (const line of diff.split('\n')) {
        const target = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
        if (target) {
            file = target[1] === '/dev/null' ? undefined : target[1].trim();
            if (file && !changed.has(file)) changed.set(file, new Set());
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && file) {
            const start = Number(hunk[1]);
            const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
            for (let i = 0; i < count; i++) changed.get(file)!.add(start + i);
        }
    }
    return changed;
}

/** Lines changed between `base` and the working tree (committed and not). */
export function changedLines(root: string, base: string): ChangedLines {
    const r = spawnSync('git', ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--relative', base, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git diff ${base} failed: ${r.stderr.trim()}`);
    const changed = parseUnifiedDiff(r.stdout);
    // New files not yet known to git count as changed everywhere.
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    for (const f of untracked) {
        try {
            const n = readFileSync(join(root, f), 'utf8').split('\n').length;
            changed.set(f, new Set(Array.from({ length: n }, (_, i) => i + 1)));
        } catch {
            // unreadable
        }
    }
    return changed;
}

/** Findings on changed lines (`lines`), or in changed files (`files`). */
export function onChanged(findings: Finding[], changed: ChangedLines, scope: 'lines' | 'files' = 'lines'): Finding[] {
    return findings.filter(f => {
        if (!f.loc) return false;
        const lines = changed.get(f.loc.file);
        if (!lines) return false;
        return scope === 'files' || lines.has(f.loc.line) || (f.related ?? []).some(r => r.file === f.loc!.file && lines.has(r.line));
    });
}

export interface ReviewComment {
    path: string;
    line: number;
    start_line?: number;
    side: 'RIGHT';
    start_side?: 'RIGHT';
    body: string;
    /** The finding's identity across pushes (lines move): not sent to GitHub, it is in the body as a marker. */
    key: string;
}

/** Hidden in each comment, so a later run knows which findings it already reported. */
const marker = (key: string) => `<!-- provenflow:${key.replace(/--/g, '- -')} -->`;
const MARKER = /<!-- provenflow:(.+?) -->/;
const SUMMARY = 'summary';
const FIXED = 'fixed';

/** One review comment per finding on a changed line; verified single-file changes become suggestions. */
export function reviewComments(findings: Finding[], changed: ChangedLines, read: (file: string) => string | undefined): ReviewComment[] {
    const comments: ReviewComment[] = [];
    for (const f of findings) {
        if (!f.loc) continue;
        const lines = changed.get(f.loc.file);
        if (!lines?.has(f.loc.line)) continue;
        const suggestion = suggestionFor(f, lines, read);
        const body = [
            `**${f.severity === 'error' ? '⛔' : f.severity === 'warning' ? '⚠️' : 'ℹ️'} ${f.rule}** · ${f.subject}`,
            '',
            f.message,
            '',
            `**Fix:** ${f.fix}`,
            ...(f.confirmation ? ['', `**On the code:** ${f.confirmation.status === 'confirmed' ? '✓ confirmed' : f.confirmation.status === 'refuted' ? '✗ not reproduced' : '? not checked'} (${f.confirmation.by}): ${f.confirmation.detail}`] : []),
            ...(f.counterexample && f.counterexample.length > 1 ? ['', '<details><summary>Counterexample</summary>', '', ...f.counterexample.map((s, i) => `${i}. ${s.event ? `\`${s.event}\` → ` : ''}**${s.state}**${s.loc ? ` (${formatLocation(s.loc)})` : ''}`), '', '</details>'] : []),
            ...(suggestion ? ['', `**Suggested change** (${f.suggestedPatch!.by ?? 'LLM'}, ✓ verified: ${f.suggestedPatch!.note})`, '', '```suggestion', suggestion.text, '```'] : []),
            '',
            marker(findingKey(f))
        ].join('\n');
        const key = findingKey(f);
        comments.push(suggestion && suggestion.start < suggestion.end
            ? { path: f.loc.file, line: suggestion.end, start_line: suggestion.start, side: 'RIGHT', start_side: 'RIGHT', body, key }
            : { path: f.loc.file, line: suggestion ? suggestion.end : f.loc.line, side: 'RIGHT', body, key });
    }
    return comments;
}

/** A verified edit on changed lines, as whole replacement lines. */
function suggestionFor(f: Finding, lines: Set<number>, read: (file: string) => string | undefined): { start: number; end: number; text: string } | undefined {
    const patch = f.suggestedPatch;
    if (!patch?.verified || patch.edits?.length !== 1 || patch.edits[0].file !== f.loc!.file) return undefined;
    const edit = patch.edits[0];
    const text = read(edit.file);
    if (!text || !edit.search) return undefined;
    const at = text.indexOf(edit.search);
    if (at < 0 || text.indexOf(edit.search, at + 1) >= 0) return undefined;
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    const endIndex = at + edit.search.length;
    const nl = text.indexOf('\n', endIndex);
    const lineEnd = nl < 0 ? text.length : nl;
    const start = text.slice(0, lineStart).split('\n').length;
    const end = start + text.slice(lineStart, lineEnd).split('\n').length - 1;
    for (let l = start; l <= end; l++) if (!lines.has(l)) return undefined; // GitHub only accepts suggestions on the diff
    return { start, end, text: text.slice(lineStart, at) + edit.replace + text.slice(endIndex, lineEnd) };
}

export function reviewSummary(result: ExtractionResult, relevant: Finding[], comments: number, base?: string): string {
    const count = (s: Finding['severity']) => relevant.filter(f => f.severity === s).length;
    const byCategory = new Map<string, number>();
    for (const f of relevant) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
    const verified = relevant.filter(f => f.suggestedPatch?.verified).length;
    const confirmed = relevant.filter(f => f.confirmation?.status === 'confirmed').length;
    return [
        `### ProvenFlow review${base ? ` (changes since \`${base.slice(0, 12)}\`)` : ''}`,
        '',
        relevant.length === 0
            ? '✓ No finding on the changed lines.'
            : `**${count('error')} errors, ${count('warning')} warnings, ${count('info')} notes** on the changed lines (${[...byCategory].map(([c, n]) => `${n} ${c}`).join(', ')}); ${comments} inline comment(s), ${verified} with a verified change, ${confirmed} confirmed on the code.`,
        '',
        `Checked: ${result.files} files, ${result.models.length} models, ${result.verdicts.length} properties (${result.checkedWith === 'nuxmv' ? 'nuXmv' : 'explicit-state'}); tools: ${result.tools.map(t => t.tool).join(', ') || 'ProvenFlow only'}; ${result.proofs.filter(p => p.status === 'proved').length} code proof(s).`,
        ...(result.notes.filter(n => /not installed/.test(n)).length ? ['', `<sub>${result.notes.filter(n => /not installed/.test(n)).join(' · ')}</sub>`] : [])
    ].join('\n');
}

export interface GithubTarget {
    token: string;
    repository: string;
    pull: number;
    commit: string;
    apiUrl?: string;
}

/** The pull request of a GitHub Actions run (GITHUB_EVENT_PATH), if any. */
export function githubTargetFromEnv(env: NodeJS.ProcessEnv = process.env): GithubTarget | undefined {
    const token = env['GITHUB_TOKEN'];
    const repository = env['GITHUB_REPOSITORY'];
    if (!token || !repository || !env['GITHUB_EVENT_PATH']) return undefined;
    try {
        const event = JSON.parse(readFileSync(env['GITHUB_EVENT_PATH'], 'utf8')) as { pull_request?: { number: number; head?: { sha?: string } } };
        if (!event.pull_request) return undefined;
        return { token, repository, pull: event.pull_request.number, commit: event.pull_request.head?.sha ?? env['GITHUB_SHA'] ?? '', apiUrl: env['GITHUB_API_URL'] };
    } catch {
        return undefined;
    }
}

/** Everything a review posts; written to a file for pull requests from forks, posted by a trusted workflow. */
export interface ReviewPayload {
    repository: string;
    pull: number;
    commit: string;
    summary: string;
    comments: ReviewComment[];
    /** Findings on the changed lines now (including those without an inline comment). */
    keys: string[];
}

export interface PublishResult {
    posted: number;
    alreadyReported: number;
    fixed: number;
    url?: string;
    summaryUrl?: string;
}

interface GithubComment {
    id: number;
    body?: string;
    in_reply_to_id?: number;
    html_url?: string;
}

/**
 * Posts a review so that pushes do not repeat it: inline comments only for findings not reported
 * before on this pull request; a reply "no longer reported" under earlier comments whose finding
 * is gone; and one summary comment, edited on each run. Comments GitHub cannot attach to the diff
 * are folded into the summary.
 */
export async function publishReview(target: GithubTarget, payload: ReviewPayload, fetchImpl: typeof fetch = fetch): Promise<PublishResult> {
    const api = target.apiUrl ?? 'https://api.github.com';
    const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetchImpl(`${api}${path}`, {
            method,
            headers: { authorization: `Bearer ${target.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return res;
    };
    const all = async <T>(path: string): Promise<T[]> => {
        const out: T[] = [];
        for (let page = 1; page <= 20; page++) {
            const res = await call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
            if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} reading ${path}: ${(await res.text()).slice(0, 200)}`);
            const items = (await res.json()) as T[];
            out.push(...items);
            if (items.length < 100) break;
        }
        return out;
    };
    const repo = `/repos/${payload.repository}`;
    const inline = await all<GithubComment>(`${repo}/pulls/${payload.pull}/comments`);
    const reported = new Map<string, GithubComment>();
    const closed = new Set<number>();
    for (const c of inline) {
        const key = MARKER.exec(c.body ?? '')?.[1];
        if (!key) continue;
        if (key === FIXED && c.in_reply_to_id) closed.add(c.in_reply_to_id);
        else if (!c.in_reply_to_id && !reported.has(key)) reported.set(key, c);
    }
    const current = new Set(payload.keys);
    const fresh = payload.comments.filter(c => !reported.has(c.key.replace(/--/g, '- -')) && !reported.has(c.key));
    const gone = [...reported].filter(([key, c]) => !current.has(key) && !current.has(key.replace(/- -/g, '--')) && !closed.has(c.id));
    const short = payload.commit.slice(0, 7);
    for (const [, c] of gone) await call('POST', `${repo}/pulls/${payload.pull}/comments/${c.id}/replies`, { body: `✓ No longer reported at ${short}.\n\n${marker(FIXED)}` });

    let posted = 0;
    let folded = '';
    let url: string | undefined;
    if (fresh.length > 0) {
        const comments = fresh.map(({ key: _key, ...c }) => c);
        const body = `ProvenFlow: ${fresh.length} new finding(s) at ${short}.`;
        let res = await call('POST', `${repo}/pulls/${payload.pull}/reviews`, { commit_id: payload.commit, event: 'COMMENT', body, comments });
        if (res.status === 422) {
            folded = `\n\n<details><summary>${fresh.length} finding(s) on lines GitHub could not attach a comment to</summary>\n\n${fresh.map(c => `**${c.path}:${c.line}**\n\n${c.body}`).join('\n\n---\n\n')}\n\n</details>`;
            res = { ok: true } as Response;
        } else if (!res.ok) throw new Error(`GitHub refused the review: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        else {
            posted = fresh.length;
            url = ((await res.json()) as { html_url?: string }).html_url;
        }
    }

    const status = `\n\n<sub>At ${short}: ${fresh.length} new, ${payload.comments.length - fresh.length} already reported, ${gone.length} no longer reported since the last review.</sub>`;
    const summary = `${payload.summary}${folded}${status}\n\n${marker(SUMMARY)}`;
    const issueComments = await all<GithubComment>(`${repo}/issues/${payload.pull}/comments`);
    const previous = issueComments.find(c => MARKER.exec(c.body ?? '')?.[1] === SUMMARY);
    const res = previous ? await call('PATCH', `${repo}/issues/comments/${previous.id}`, { body: summary }) : await call('POST', `${repo}/issues/${payload.pull}/comments`, { body: summary });
    if (!res.ok) throw new Error(`GitHub refused the summary comment: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const summaryUrl = ((await res.json()) as { html_url?: string }).html_url;
    return { posted, alreadyReported: payload.comments.length - fresh.length, fixed: gone.length, url, summaryUrl };
}

/** Checks a review file against the pull request before posting it (it may come from a fork's run). */
export async function checkPayload(target: GithubTarget, payload: ReviewPayload, fetchImpl: typeof fetch = fetch): Promise<void> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(payload.repository) || payload.repository !== target.repository) throw new Error(`The review is for ${payload.repository}, not ${target.repository}.`);
    if (!Number.isInteger(payload.pull) || payload.pull <= 0) throw new Error('The review has no pull request number.');
    const res = await fetchImpl(`${target.apiUrl ?? 'https://api.github.com'}/repos/${payload.repository}/pulls/${payload.pull}`, { headers: { authorization: `Bearer ${target.token}`, accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} reading pull request ${payload.pull}.`);
    const pr = (await res.json()) as { head?: { sha?: string } };
    if (pr.head?.sha !== payload.commit) throw new Error(`The review was made for ${payload.commit.slice(0, 7)}, but the pull request is now at ${pr.head?.sha?.slice(0, 7)}: not posted (a newer run will review it).`);
    if (payload.comments.length > 200 || payload.comments.some(c => typeof c.path !== 'string' || typeof c.body !== 'string' || c.body.length > 60_000)) throw new Error('The review file is not a ProvenFlow review.');
}

/** GitHub Actions annotations (the Files tab of the pull request, and the run's summary). */
export function annotations(findings: Finding[]): string[] {
    const esc = (v: string) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const prop = (v: string) => esc(v).replace(/:/g, '%3A').replace(/,/g, '%2C');
    return findings
        .filter(f => f.loc)
        .map(f => `::${f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'notice'} file=${prop(f.loc!.file)},line=${f.loc!.line},title=${prop(`ProvenFlow ${f.rule}`)}::${esc(`${f.message}\nFix: ${f.fix}`)}`);
}

/** Whether a pull request comes from a fork (its token cannot post reviews). */
export function fromFork(env: NodeJS.ProcessEnv = process.env): boolean {
    try {
        const event = JSON.parse(readFileSync(env['GITHUB_EVENT_PATH'] ?? '', 'utf8')) as { pull_request?: { head?: { repo?: { full_name?: string } }; base?: { repo?: { full_name?: string } } } };
        const head = event.pull_request?.head?.repo?.full_name;
        return !!head && head !== event.pull_request?.base?.repo?.full_name;
    } catch {
        return false;
    }
}
