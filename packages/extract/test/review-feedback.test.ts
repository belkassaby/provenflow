import { describe, expect, it } from 'vitest';
import { classifyReply, ignoreEntry, labelRows, labelsFromComments, mergeFeedback, placeFindings, placementMarkdown, rulePrecision, type Finding, type ReviewFeedback, type ReviewLabel } from '../src/index.js';

describe('review feedback', () => {
    it('reads the verdict from the first sentence of a reply', () => {
        expect(classifyReply('Not a leak: `ensureSubscriptions()` returns early while `channelSub` is set.')).toBe('false-positive');
        expect(classifyReply("Not dead: `mode` is set by `setMode(mode: RegionToolMode)`, the contract method.")).toBe('false-positive');
        expect(classifyReply('Reachable: the dialog sets it through the two-way binding.')).toBe('false-positive');
        expect(classifyReply('Not correct. Line 901 assigns the live mode when transcripts are switched off.')).toBe('false-positive');
        expect(classifyReply('Fixed in 14cde44: the reader now handles one feature at a time.')).toBe('fixed');
        expect(classifyReply('Split in 5e10c06: `distances` and `averageLinkageLeaves`.')).toBe('fixed');
        expect(classifyReply('Leaving this one: these are Angular constructor injections.')).toBe('declined');
        expect(classifyReply('Already gone: `detectHoles` was deleted in 5c01fa7.')).toBe('outdated');
        expect(classifyReply('Hmm, let me think about it.')).toBe('unclear');
    });

    it('labels a finding with the first reply that is not ProvenFlow’s own', () => {
        const finding = { id: 1, body: '**⚠️ resource-leak** · A\n\n<!-- provenflow:resource-leak|A subscription this.sub|src/a.ts -->', created_at: '2026-01-01' };
        const labels = labelsFromComments(
            [
                finding,
                { id: 2, in_reply_to_id: 1, body: '✓ No longer reported at abc1234.\n\n<!-- provenflow:fixed -->', created_at: '2026-01-02' },
                { id: 3, in_reply_to_id: 1, body: 'Not a leak: Angular calls ngOnInit once per instance.', created_at: '2026-01-03', html_url: 'https://github.com/o/r/pull/7#discussion_r3' },
                { id: 4, in_reply_to_id: 1, body: 'Fixed anyway.', created_at: '2026-01-04' },
                { id: 5, body: 'A comment of someone else, not on a finding.' }
            ],
            7
        );
        expect(labels).toEqual([{ key: 'resource-leak|A subscription this.sub|src/a.ts', rule: 'resource-leak', verdict: 'false-positive', reply: 'Not a leak: Angular calls ngOnInit once per instance.', pull: 7, url: 'https://github.com/o/r/pull/7#discussion_r3' }]);
    });

    it('keeps the labels already in the file (corrected by hand) and adds the new ones', () => {
        const previous: ReviewFeedback = { repository: 'o/r', commit: 'aaa', labels: [{ key: 'k1', rule: 'r', verdict: 'fixed', reply: 'corrected', pull: 1 }] };
        const next: ReviewFeedback = {
            repository: 'o/r',
            commit: 'bbb',
            labels: [
                { key: 'k1', rule: 'r', verdict: 'unclear', reply: 'corrected', pull: 1 },
                { key: 'k2', rule: 'r', verdict: 'false-positive', reply: 'Not dead', pull: 2 }
            ]
        };
        const merged = mergeFeedback(previous, next);
        expect(merged.commit).toBe('aaa');
        expect(merged.labels.map(l => `${l.key}:${l.verdict}`)).toEqual(['k1:fixed', 'k2:false-positive']);
    });

    it('counts per rule the false positives still reported', () => {
        const still = { rule: 'stuck-state', subject: 'A.mode', loc: { file: 'a.ts', line: 3 } } as Finding;
        const rows = labelRows(
            [
                { key: 'stuck-state|A.mode|a.ts', rule: 'stuck-state', verdict: 'false-positive', reply: '' },
                { key: 'stuck-state|B.mode|b.ts', rule: 'stuck-state', verdict: 'false-positive', reply: '' },
                { key: 'stuck-state|C.mode|c.ts', rule: 'stuck-state', verdict: 'fixed', reply: '' }
            ],
            [still]
        );
        expect(rows).toEqual([{ rule: 'stuck-state', labelled: 3, falsePositive: 2, fixed: 1, declined: 0, stillReported: 1 }]);
        expect(rulePrecision(rows[0], 3)).toBeCloseTo(1 / 3);
        expect(rulePrecision(rows[0])).toBeUndefined();
    });
});

describe('review placement', () => {
    const at = (rule: string, subject: string): Finding => ({ rule, subject, category: 'lifecycle', severity: 'warning', message: 'm', fix: 'f', loc: { file: 'src/a.ts', line: 3 }, source: 'analysis' }) as Finding;
    const label = (rule: string, verdict: ReviewLabel['verdict'], subject = 'X'): ReviewLabel => ({ key: `${rule}|${subject}|src/a.ts`, rule, verdict, reply: '', pull: 3 });

    it('comments inline unless the finding or most of its rule was answered as a false positive', () => {
        const feedback: ReviewFeedback = {
            repository: 'o/r',
            labels: [
                label('stuck-state', 'false-positive', 'A.mode'),
                ...['B', 'C', 'D', 'E', 'F'].map(s => label('resource-leak', 'false-positive', s)),
                label('resource-leak', 'fixed', 'G'),
                ...['H', 'I', 'J', 'K', 'L'].map(s => label('long-function', 'fixed', s))
            ]
        };
        const placed = placeFindings([at('stuck-state', 'A.mode'), at('stuck-state', 'B.mode'), at('resource-leak', 'Z'), at('long-function', 'f')], feedback);
        expect(placed.inline.map(f => f.subject)).toEqual(['B.mode', 'f']);
        expect(placed.summary.map(s => s.reason)).toEqual(['answered as a false positive in #3', 'resource-leak: 17% of its answered findings were real']);
        expect(placementMarkdown(placed.summary)).toContain('2 finding(s) not commented inline');
    });

    it('lets the config place a rule whatever the answers say', () => {
        const feedback: ReviewFeedback = { repository: 'o/r', labels: ['B', 'C', 'D', 'E', 'F'].map(s => label('resource-leak', 'false-positive', s)) };
        const config = { rules: { 'resource-leak': 'inline' as const, 'long-function': 'summary' as const } };
        const placed = placeFindings([at('resource-leak', 'Z'), at('long-function', 'f')], feedback, config);
        expect(placed.inline.map(f => f.rule)).toEqual(['resource-leak']);
        expect(placed.summary[0].reason).toContain('review.rules');
    });

    it('turns a finding key into an ignore entry', () => {
        expect(ignoreEntry('resource-leak|Poller interval this.timer|src/a.ts', 'guarded')).toEqual({ rule: 'resource-leak', subject: 'Poller interval this.timer', file: 'src/a.ts', reason: 'guarded' });
    });
});
