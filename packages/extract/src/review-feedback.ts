/**
 * What people answered to review comments (`pflow feedback`): every reply to a ProvenFlow comment
 * on a pull request is a verdict on its finding (a false positive, fixed, declined). The verdicts,
 * kept in a file, measure each rule (`pflow bench --labels`) and steer later reviews: a finding
 * answered as a false positive is not commented on again, and a rule answered mostly with false
 * positives goes to the summary instead of inline comments.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findingKey } from './incremental.js';
import type { Finding } from './models.js';
import { commentKey, githubApi, type GithubApi } from './github-api.js';

export type Verdict = 'false-positive' | 'fixed' | 'declined' | 'outdated' | 'unclear';

export interface ReviewLabel {
    /** The finding's identity: rule|subject|file. */
    key: string;
    rule: string;
    verdict: Verdict;
    /** The start of the reply the verdict comes from. */
    reply: string;
    pull?: number;
    url?: string;
}

export interface ReviewFeedback {
    repository: string;
    /** The revision the labels were checked against (`pflow bench` analyses it). */
    commit?: string;
    harvested?: string;
    labels: ReviewLabel[];
}

export const FEEDBACK_FILE = 'provenflow-feedback.json';

// The first sentence of a reply says what it is.
const OUTDATED = /^already gone\b|^`?[\w.]+`? is gone\b/i;
const FIXED = /^(fixed|split|already fixed|correct\b|partly correct\b|accurate\b|done\b)|\b(fixed|split) in [0-9a-f]{7}|^the [\w ,`'-]+ (moved|went) to\b/i;
const DECLINED = /^(leaving|noted|not splitting|won'?t fix|slightly over|(one|two|a few) (lines? )?over|these are angular di|as with the|same reasoning as|fair observation, but not)/i;
const FALSE_POSITIVE =
    /false positive|^not correct\b|^not (a |an )?(leak|dead|stuck|relevant|reachable|a dead branch)|^reachable\b|\bwas reachable\b|^it does settle|counterexample (itself )?can.?t happen|^intended\b|^under di\b|\bis (set|removed|unsubscribed|reassigned)\b|\bdoes get set\b|^each listener is removed|^not a leak|^not dead|^not stuck/i;

/** The verdict a reply gives on the finding it answers. */
export function classifyReply(text: string): Verdict {
    const first = text.trim().split(/(?<=[.:!?])\s/)[0] ?? '';
    if (OUTDATED.test(first)) return 'outdated';
    if (FALSE_POSITIVE.test(first)) return 'false-positive';
    if (FIXED.test(first)) return 'fixed';
    if (DECLINED.test(first)) return 'declined';
    return 'unclear';
}

export interface ReviewThreadComment {
    id: number;
    body?: string;
    in_reply_to_id?: number;
    html_url?: string;
    created_at?: string;
}

/** The labels of one pull request's review comments: the first reply that is not ProvenFlow's own. */
export function labelsFromComments(comments: ReviewThreadComment[], pull?: number): ReviewLabel[] {
    const findings = new Map<number, string>();
    for (const c of comments) {
        const key = commentKey(c.body ?? '');
        if (key && !c.in_reply_to_id && key.includes('|')) findings.set(c.id, key);
    }
    const labels = new Map<number, ReviewLabel>();
    const ordered = [...comments].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id);
    for (const c of ordered) {
        const key = c.in_reply_to_id ? findings.get(c.in_reply_to_id) : undefined;
        if (!key || labels.has(c.in_reply_to_id!) || commentKey(c.body ?? '')) continue;
        const reply = (c.body ?? '').trim();
        labels.set(c.in_reply_to_id!, { key, rule: key.split('|')[0], verdict: classifyReply(reply), reply: reply.slice(0, 400), pull, url: c.html_url });
    }
    return [...labels.values()];
}

/** The labels of the last `limit` pull requests of a repository, and the head of its default branch, from the GitHub API. */
export async function harvestFeedback(repository: string, token: string, options: { limit?: number; apiUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<ReviewFeedback> {
    const api: GithubApi = githubApi({ token, repository, pull: 0, commit: '', apiUrl: options.apiUrl }, options.fetchImpl ?? fetch);
    const repo = `/repos/${repository}`;
    const pulls = (await api.all<{ number: number }>(`${repo}/pulls?state=all&sort=updated&direction=desc`)).slice(0, options.limit ?? 100);
    const labels: ReviewLabel[] = [];
    for (const p of pulls) labels.push(...labelsFromComments(await api.all<ReviewThreadComment>(`${repo}/pulls/${p.number}/comments`), p.number));
    const head = await api.call('GET', `${repo}/commits/HEAD`);
    const commit = head.ok ? ((await head.json()) as { sha?: string }).sha : undefined;
    return { repository, commit, harvested: new Date().toISOString().slice(0, 10), labels: labels.sort((a, b) => (a.pull ?? 0) - (b.pull ?? 0) || a.key.localeCompare(b.key)) };
}

/** The feedback file of a code base, if it has one (config `feedback`, default provenflow-feedback.json). */
export function readFeedback(root: string, file?: string | false): ReviewFeedback | undefined {
    if (file === false) return undefined;
    const path = join(root, file ?? FEEDBACK_FILE);
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as ReviewFeedback;
    } catch (error) {
        throw new Error(`${path}: ${(error as Error).message}`);
    }
}

/**
 * New labels added to a feedback file. Labels already in the file are kept as they are (their
 * verdicts may have been corrected by hand), and so is the revision they were checked against.
 */
export function mergeFeedback(previous: ReviewFeedback | undefined, next: ReviewFeedback): ReviewFeedback {
    const byKey = new Map<string, ReviewLabel>();
    for (const l of [...next.labels, ...(previous?.labels ?? [])]) byKey.set(`${l.pull ?? ''}#${l.key}`, l);
    const labels = [...byKey.values()].sort((a, b) => (a.pull ?? 0) - (b.pull ?? 0) || a.key.localeCompare(b.key));
    return { ...next, commit: previous?.commit ?? next.commit, labels };
}

// ------------------------------------------------------------------------------ measures

export interface LabelRow {
    rule: string;
    labelled: number;
    falsePositive: number;
    fixed: number;
    declined: number;
    /** Findings labelled false positive that the analysis still reports. */
    stillReported: number;
}

/** Per rule: the verdicts, and the false positives the given findings still contain. */
export function labelRows(labels: ReviewLabel[], findings?: Finding[]): LabelRow[] {
    const reported = findings ? new Set(findings.map(findingKey)) : undefined;
    const rows = new Map<string, LabelRow>();
    for (const l of labels) {
        const row = rows.get(l.rule) ?? { rule: l.rule, labelled: 0, falsePositive: 0, fixed: 0, declined: 0, stillReported: 0 };
        row.labelled++;
        if (l.verdict === 'false-positive') {
            row.falsePositive++;
            if (reported?.has(l.key)) row.stillReported++;
        } else if (l.verdict === 'fixed') row.fixed++;
        else if (l.verdict === 'declined') row.declined++;
        rows.set(l.rule, row);
    }
    return [...rows.values()].sort((a, b) => b.labelled - a.labelled || a.rule.localeCompare(b.rule));
}

/** Of the findings people decided on (fixed or false positive), the share that was real; undefined below `min` decisions. */
export function rulePrecision(row: Pick<LabelRow, 'fixed' | 'falsePositive'>, min = 5): number | undefined {
    const decided = row.fixed + row.falsePositive;
    return decided >= min ? row.fixed / decided : undefined;
}

/** The verdicts per rule; with `analysed`, also the false positives the analysis of the labelled revision still reports. */
export function labelsMarkdown(name: string, rows: LabelRow[], analysed?: { revision: string }): string {
    const pct = (r: LabelRow) => {
        const p = rulePrecision(r, 1);
        return p === undefined ? '-' : `${Math.round(p * 100)}%`;
    };
    const fp = rows.reduce((n, r) => n + r.falsePositive, 0);
    const still = rows.reduce((n, r) => n + r.stillReported, 0);
    return [
        `## ${name}: findings people answered`,
        '',
        analysed ? `${fp} finding(s) were answered as false positives; **${still} of them are still reported** at ${analysed.revision}.` : `${fp} finding(s) were answered as false positives.`,
        '',
        '| rule | answered | false positive | fixed | declined | real of decided | false positives still reported |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map(r => `| ${r.rule} | ${r.labelled} | ${r.falsePositive} | ${r.fixed} | ${r.declined} | ${pct(r)} | ${analysed ? r.stillReported : '-'} |`),
        ''
    ].join('\n');
}
