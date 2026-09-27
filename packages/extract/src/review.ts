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
}

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
            ...(suggestion ? ['', `**Suggested change** (${f.suggestedPatch!.by ?? 'LLM'}, ✓ verified: ${f.suggestedPatch!.note})`, '', '```suggestion', suggestion.text, '```'] : [])
        ].join('\n');
        comments.push(suggestion && suggestion.start < suggestion.end
            ? { path: f.loc.file, line: suggestion.end, start_line: suggestion.start, side: 'RIGHT', start_side: 'RIGHT', body }
            : { path: f.loc.file, line: suggestion ? suggestion.end : f.loc.line, side: 'RIGHT', body });
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

/** Posts the review; comments GitHub rejects (lines outside the diff) are folded into the summary. */
export async function postGithubReview(target: GithubTarget, body: string, comments: ReviewComment[], fetchImpl: typeof fetch = fetch): Promise<{ posted: number; url?: string }> {
    const api = target.apiUrl ?? 'https://api.github.com';
    const post = (payload: unknown) =>
        fetchImpl(`${api}/repos/${target.repository}/pulls/${target.pull}/reviews`, {
            method: 'POST',
            headers: { authorization: `Bearer ${target.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
            body: JSON.stringify(payload)
        });
    let res = await post({ commit_id: target.commit, event: 'COMMENT', body, comments });
    if (res.status === 422 && comments.length > 0) {
        const folded = `${body}\n\n<details><summary>${comments.length} comment(s) on lines GitHub could not attach</summary>\n\n${comments.map(c => `**${c.path}:${c.line}**\n\n${c.body}`).join('\n\n---\n\n')}\n\n</details>`;
        res = await post({ commit_id: target.commit, event: 'COMMENT', body: folded, comments: [] });
        if (!res.ok) throw new Error(`GitHub refused the review: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        return { posted: 0, url: ((await res.json()) as { html_url?: string }).html_url };
    }
    if (!res.ok) throw new Error(`GitHub refused the review: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { posted: comments.length, url: ((await res.json()) as { html_url?: string }).html_url };
}
