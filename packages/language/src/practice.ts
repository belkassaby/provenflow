/**
 * An entry of the patterns and practices catalogue, shared by the code checker (which owns the
 * entries and the rules that check them) and the editor (which shows and selects them).
 */

/** Design patterns, principles (mostly from The Pragmatic Programmer) and anti-patterns (code smells). */
export type PracticeKind = 'pattern' | 'principle' | 'anti-pattern';

/**
 * One entry, in the narrative form of Fowler's "Writing Software Patterns": the solution first,
 * then the problem, how it works, when to use it and when not to, and an example.
 */
export interface Practice {
    /** Stable id, used in provenflow.config.json `checks` and in findings (`practice`). For design patterns, the pattern name. */
    id: string;
    /** Short noun phrase (Fowler: two or three words). */
    name: string;
    kind: PracticeKind;
    /** The solution, in one sentence. */
    summary: string;
    /** What goes wrong without it: the trigger and the forces. */
    problem: string;
    /** How it works: the refactoring for an anti-pattern. */
    solution: string;
    /** When to apply it (an anti-pattern: when it is reported). */
    use: string;
    /** When not to, or the exceptions. */
    avoid: string;
    /** A small example, before and after; `file` chooses the syntax highlighting. */
    example: { file: string; before: string; after: string };
    /** What ProvenFlow checks for it. */
    checks: string;
    /** The rules of the findings that check it: `rule`, or `category:rule` when the rule name is shared. */
    rules: string[];
    /** Whether ProvenFlow recognises instances of it in the code (design patterns). */
    detects?: boolean;
    /** What the automatic fix does, for the entries that have one. */
    autoFix?: string;
    sources: Array<{ title: string; where: string; url?: string }>;
    /** Ids of related entries. */
    related: string[];
    /** In the default selection. */
    selected: boolean;
}

export const PRACTICE_KIND_TITLES: Record<PracticeKind, string> = { pattern: 'Design patterns', principle: 'Principles', 'anti-pattern': 'Anti-patterns' };
