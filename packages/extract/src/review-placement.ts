/**
 * Where a review puts each finding: an inline comment, or only a line in the summary. A comment on
 * the diff asks the author to act; a finding people already answered as a false positive, or one
 * of a rule whose findings were mostly answered so, should not ask again. The verdicts come from the
 * feedback file (`pflow feedback`) and from the replies on the pull request itself.
 */
import type { IgnoreRule, ReviewConfig } from './config.js';
import { findingKey } from './incremental.js';
import type { Finding } from './models.js';
import { labelRows, rulePrecision, type ReviewFeedback, type ReviewLabel } from './review-feedback.js';
import { PROVENFLOW_VERSION, sameMinor } from './version.js';

export const DEFAULT_MIN_PRECISION = 0.5;
export const DEFAULT_MIN_ANSWERS = 5;

export interface Placement {
    inline: Finding[];
    /** Findings left out of the inline comments, and why. */
    summary: Array<{ finding: Finding; reason: string }>;
}

/**
 * Inline unless the config says summary, the finding was answered as a false positive (by any
 * version), or its rule was mostly, in answers to findings of `version`'s minor version: a release
 * that fixes a rule's false positives starts it again with a clean slate.
 */
export function placeFindings(findings: Finding[], feedback: ReviewFeedback | undefined, config: ReviewConfig = {}, version = PROVENFLOW_VERSION): Placement {
    const disputed = new Map((feedback?.labels ?? []).filter(l => l.verdict === 'false-positive').map(l => [l.key, l]));
    const lowRules = lowPrecisionRules((feedback?.labels ?? []).filter(l => sameMinor(l.version, version)), config);
    const placement: Placement = { inline: [], summary: [] };
    for (const f of findings) {
        const reason = summaryReason(f, disputed.get(findingKey(f)), lowRules.get(f.rule), config);
        if (reason) placement.summary.push({ finding: f, reason });
        else placement.inline.push(f);
    }
    return placement;
}

function summaryReason(f: Finding, disputed: ReviewLabel | undefined, precision: number | undefined, config: ReviewConfig): string | undefined {
    if (config.rules?.[f.rule] === 'inline') return undefined;
    if (config.rules?.[f.rule] === 'summary') return 'review.rules sends this rule to the summary';
    if (disputed) return `answered as a false positive${disputed.pull ? ` in #${disputed.pull}` : ''}${disputed.url ? ` ([reply](${disputed.url}))` : ''}`;
    if (precision !== undefined) return `${f.rule}: ${Math.round(precision * 100)}% of its answered findings in this version were real`;
    return undefined;
}

/** Rules whose answered findings were real less often than `minPrecision`, with their precision. */
function lowPrecisionRules(labels: ReviewLabel[], config: ReviewConfig): Map<string, number> {
    const low = new Map<string, number>();
    const threshold = config.minPrecision ?? DEFAULT_MIN_PRECISION;
    for (const row of labelRows(labels)) {
        const precision = rulePrecision(row, config.minAnswers ?? DEFAULT_MIN_ANSWERS);
        if (precision !== undefined && precision < threshold) low.set(row.rule, precision);
    }
    return low;
}

export function placementMarkdown(summary: Placement['summary']): string {
    if (summary.length === 0) return '';
    const rows = summary.map(({ finding: f, reason }) => `- \`${f.loc ? `${f.loc.file}:${f.loc.line}` : f.subject}\` **${f.rule}** · ${f.subject}: ${reason}.`);
    return `\n\n<details><summary>${summary.length} finding(s) not commented inline</summary>\n\n${rows.join('\n')}\n\n</details>`;
}

/** The `ignore` entry of provenflow.config.json that silences one finding (rule|subject|file). */
export function ignoreEntry(key: string, reason: string): IgnoreRule {
    const [rule, ...rest] = key.split('|');
    const file = rest.length > 1 ? rest.pop() : undefined;
    return { rule, subject: rest.join('|'), ...(file ? { file } : {}), reason };
}

/** Findings answered as false positives on this pull request and still reported, with the `ignore` entries that accept them. */
export function disputedMarkdown(labels: ReviewLabel[], current: Set<string>): string {
    const open = labels.filter(l => l.verdict === 'false-positive' && current.has(l.key));
    if (open.length === 0) return '';
    const entries = open.map(l => ignoreEntry(l.key, firstSentence(l.reply)));
    return [
        '',
        '',
        `<details><summary>${open.length} finding(s) answered as false positives on this pull request</summary>`,
        '',
        'They are not commented on again here. If the answer holds, add these entries to `ignore` in provenflow.config.json (and run `pflow feedback` so that later pull requests learn from them):',
        '',
        '```json',
        JSON.stringify(entries, null, 2),
        '```',
        '',
        '</details>'
    ].join('\n');
}

function firstSentence(text: string): string {
    const first = text.trim().split(/(?<=[.!?])\s/)[0] ?? '';
    return first.length > 240 ? `${first.slice(0, 237)}...` : first;
}
