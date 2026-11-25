/**
 * Pull-request review: the findings on the lines a change touches (diff-time reporting, which gets
 * findings fixed far more often than batch reports), posted as a GitHub review. Each comment has the
 * finding, its fix, the counterexample and whether it was confirmed on the code; a verified code
 * change becomes a GitHub suggestion the author applies with one click.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractionResult } from './project.js';
import { formatLocation } from './ir.js';
import type { Finding } from './models.js';
import { findingKey } from './incremental.js';
import { githubApi, marker, MARKER, versionMarker, type GithubApi, type GithubTarget } from './github-api.js';
import { PROVENFLOW_VERSION } from './version.js';
import { labelsFromComments } from './review-feedback.js';
import { disputedMarkdown } from './review-placement.js';

export { githubApi, type GithubApi, type GithubTarget } from './github-api.js';

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
        } else if (file) addHunk(changed.get(file)!, line);
    }
    return changed;
}

/** The new-file lines of a hunk header (`@@ -a,b +start,count @@`). */
function addHunk(lines: Set<number>, header: string): void {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!hunk) return;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
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

const SUMMARY = 'summary';
const FIXED = 'fixed';

/** One review comment per finding on a changed line; verified single-file changes become suggestions. */
export function reviewComments(findings: Finding[], changed: ChangedLines, read: (file: string) => string | undefined): ReviewComment[] {
    return findings.flatMap(f => {
        const lines = f.loc ? changed.get(f.loc.file) : undefined;
        if (!f.loc || !lines?.has(f.loc.line)) return [];
        const suggestion = suggestionFor(f, lines, read);
        const key = findingKey(f);
        const body = commentBody(f, suggestion);
        if (suggestion && suggestion.start < suggestion.end) return [{ path: f.loc.file, line: suggestion.end, start_line: suggestion.start, side: 'RIGHT' as const, start_side: 'RIGHT' as const, body, key }];
        return [{ path: f.loc.file, line: suggestion ? suggestion.end : f.loc.line, side: 'RIGHT' as const, body, key }];
    });
}

const SEVERITY_ICON = { error: '⛔', warning: '⚠️', info: 'ℹ️' } as const;
const CONFIRMATION = { confirmed: '✓ confirmed', refuted: '✗ not reproduced', unknown: '? not checked' } as const;

function commentBody(f: Finding, suggestion: { text: string } | undefined): string {
    const parts = [`**${SEVERITY_ICON[f.severity]} ${f.rule}** · ${f.subject}`, '', f.message, '', `**Fix:** ${f.fix}`];
    if (f.confirmation) parts.push('', `**On the code:** ${CONFIRMATION[f.confirmation.status]} (${f.confirmation.by}): ${f.confirmation.detail}`);
    if (f.counterexample && f.counterexample.length > 1) parts.push('', '<details><summary>Counterexample</summary>', '', ...f.counterexample.map((s, i) => `${i}. ${s.event ? `\`${s.event}\` → ` : ''}**${s.state}**${s.loc ? ` (${formatLocation(s.loc)})` : ''}`), '', '</details>');
    if (suggestion) parts.push('', `**Suggested change** (${f.suggestedPatch!.by ?? 'LLM'}, ✓ verified: ${f.suggestedPatch!.note})`, '', '```suggestion', suggestion.text, '```');
    parts.push('', `${marker(findingKey(f))} ${versionMarker(PROVENFLOW_VERSION)}`);
    return parts.join('\n');
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

/** `extras`: lines about the gate (findings the base or the baseline already had, agent commits, mutation score). */
export function reviewSummary(result: ExtractionResult, relevant: Finding[], comments: number, base?: string, extras: string[] = []): string {
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
        ...(extras.length ? [...extras.map(e => `- ${e}`), ''] : []),
        `Checked: ${result.files} files, ${result.models.length} models, ${result.verdicts.length} properties (${result.checkedWith === 'nuxmv' ? 'nuXmv' : 'explicit-state'}); tools: ${result.tools.map(t => t.tool).join(', ') || 'ProvenFlow only'}; ${result.proofs.filter(p => p.status === 'proved').length} code proof(s).`,
        ...(result.notes.filter(n => /not installed/.test(n)).length ? ['', `<sub>${result.notes.filter(n => /not installed/.test(n)).join(' · ')}</sub>`] : [])
    ].join('\n');
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
    created_at?: string;
}

/**
 * Posts a review so that pushes do not repeat it: inline comments only for findings not reported
 * before on this pull request; a reply "no longer reported" under earlier comments whose finding
 * is gone; and one summary comment, edited on each run. Comments GitHub cannot attach to the diff
 * are folded into the summary.
 */
export async function publishReview(target: GithubTarget, payload: ReviewPayload, fetchImpl: typeof fetch = fetch): Promise<PublishResult> {
    const api = githubApi(target, fetchImpl);
    const repo = `/repos/${payload.repository}`;
    const inline = await api.all<GithubComment>(`${repo}/pulls/${payload.pull}/comments`);
    const { reported, closed } = earlierComments(inline);
    const current = new Set(payload.keys);
    const fresh = payload.comments.filter(c => !reported.has(c.key.replace(/--/g, '- -')) && !reported.has(c.key));
    const gone = [...reported].filter(([key, c]) => !current.has(key) && !current.has(key.replace(/- -/g, '--')) && !closed.has(c.id));
    const short = payload.commit.slice(0, 7);
    for (const [, c] of gone) await api.call('POST', `${repo}/pulls/${payload.pull}/comments/${c.id}/replies`, { body: `✓ No longer reported at ${short}.\n\n${marker(FIXED)}` });
    const review = await postComments(api, repo, payload, fresh);
    const status = `\n\n<sub>At ${short}: ${fresh.length} new, ${payload.comments.length - fresh.length} already reported, ${gone.length} no longer reported since the last review.</sub>`;
    const disputed = disputedMarkdown(labelsFromComments(inline, payload.pull), current);
    const summary = `${payload.summary}${review.folded}${disputed}${acceptance(reported, closed, new Set(gone.map(([k]) => k)))}${status}\n\n${marker(SUMMARY)}`;
    const summaryUrl = await upsertSummary(api, repo, payload.pull, summary);
    return { posted: review.posted, alreadyReported: payload.comments.length - fresh.length, fixed: gone.length, url: review.url, summaryUrl };
}

/** The findings commented before on this pull request (by their marker), and the comments already answered as fixed. */
function earlierComments(inline: GithubComment[]): { reported: Map<string, GithubComment>; closed: Set<number> } {
    const reported = new Map<string, GithubComment>();
    const closed = new Set<number>();
    for (const c of inline) {
        const key = MARKER.exec(c.body ?? '')?.[1];
        if (key === FIXED && c.in_reply_to_id) closed.add(c.in_reply_to_id);
        else if (key && !c.in_reply_to_id && !reported.has(key)) reported.set(key, c);
    }
    return { reported, closed };
}

/** The new findings as one review; those GitHub cannot attach to the diff (422) are folded into the summary. */
async function postComments(api: GithubApi, repo: string, payload: ReviewPayload, fresh: ReviewComment[]): Promise<{ posted: number; folded: string; url?: string }> {
    if (fresh.length === 0) return { posted: 0, folded: '' };
    const comments = fresh.map(({ key: _key, ...c }) => c);
    const res = await api.call('POST', `${repo}/pulls/${payload.pull}/reviews`, { commit_id: payload.commit, event: 'COMMENT', body: `ProvenFlow: ${fresh.length} new finding(s) at ${payload.commit.slice(0, 7)}.`, comments });
    if (res.status === 422) return { posted: 0, folded: `\n\n<details><summary>${fresh.length} finding(s) on lines GitHub could not attach a comment to</summary>\n\n${fresh.map(c => `**${c.path}:${c.line}**\n\n${c.body}`).join('\n\n---\n\n')}\n\n</details>` };
    if (!res.ok) throw new Error(`GitHub refused the review: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { posted: fresh.length, folded: '', url: ((await res.json()) as { html_url?: string }).html_url };
}

/** The one summary comment of the pull request, edited in place on later runs. */
async function upsertSummary(api: GithubApi, repo: string, pull: number, summary: string): Promise<string | undefined> {
    const previous = (await api.all<GithubComment>(`${repo}/issues/${pull}/comments`)).find(c => MARKER.exec(c.body ?? '')?.[1] === SUMMARY);
    const res = previous ? await api.call('PATCH', `${repo}/issues/comments/${previous.id}`, { body: summary }) : await api.call('POST', `${repo}/issues/${pull}/comments`, { body: summary });
    if (!res.ok) throw new Error(`GitHub refused the summary comment: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { html_url?: string }).html_url;
}

/**
 * Per rule: findings commented on this pull request, and how many were fixed afterwards. Rules whose
 * comments are seldom acted on are noise to tune (a limit, an `ignore`, or the rule turned off).
 */
function acceptance(reported: Map<string, GithubComment>, closed: Set<number>, gone: Set<string>): string {
    const perRule = new Map<string, { commented: number; fixed: number }>();
    for (const [key, c] of reported) {
        const rule = key.split('|')[0];
        const e = perRule.get(rule) ?? { commented: 0, fixed: 0 };
        e.commented++;
        if (closed.has(c.id) || gone.has(key)) e.fixed++;
        perRule.set(rule, e);
    }
    if (perRule.size === 0) return '';
    const rows = [...perRule].sort((a, b) => b[1].commented - a[1].commented).map(([rule, e]) => `| ${rule} | ${e.commented} | ${e.fixed} |`);
    return `\n\n<details><summary>Findings commented on this pull request, and fixed since</summary>\n\n| rule | commented | fixed |\n| --- | ---: | ---: |\n${rows.join('\n')}\n\n</details>`;
}

/**
 * A check run with the findings as annotations, sent 50 at a time (the Checks API's limit per
 * request; later requests append). Its name is stable, so a ruleset can require it.
 */
export async function publishCheckRun(target: GithubTarget, findings: Finding[], conclusion: 'success' | 'failure' | 'neutral', summaryText: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
    const api = target.apiUrl ?? 'https://api.github.com';
    const headers = { authorization: `Bearer ${target.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' };
    const level = (f: Finding) => (f.severity === 'error' ? 'failure' : f.severity === 'warning' ? 'warning' : 'notice');
    const annotationsOf = findings
        .filter(f => f.loc)
        .map(f => ({ path: f.loc!.file, start_line: f.loc!.line, end_line: f.endLine && f.endLine >= f.loc!.line ? f.endLine : f.loc!.line, annotation_level: level(f), title: `${f.rule}: ${f.subject}`.slice(0, 255), message: `${f.message}\nFix: ${f.fix}`.slice(0, 64_000) }));
    const title = `${findings.filter(f => f.severity === 'error').length} errors, ${findings.filter(f => f.severity === 'warning').length} warnings`;
    const output = (batch: typeof annotationsOf) => ({ title, summary: summaryText.slice(0, 65_000), annotations: batch });
    const first = await fetchImpl(`${api}/repos/${target.repository}/check-runs`, { method: 'POST', headers, body: JSON.stringify({ name: 'ProvenFlow', head_sha: target.commit, status: 'completed', conclusion, output: output(annotationsOf.slice(0, 50)) }) });
    if (!first.ok) throw new Error(`GitHub refused the check run: HTTP ${first.status} ${(await first.text()).slice(0, 300)}`);
    const run = (await first.json()) as { id: number; html_url?: string };
    for (let i = 50; i < annotationsOf.length; i += 50) {
        const res = await fetchImpl(`${api}/repos/${target.repository}/check-runs/${run.id}`, { method: 'PATCH', headers, body: JSON.stringify({ output: output(annotationsOf.slice(i, i + 50)) }) });
        if (!res.ok) throw new Error(`GitHub refused annotations ${i + 1}-${i + 50}: HTTP ${res.status}`);
    }
    return run.html_url;
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
