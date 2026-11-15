/**
 * Text edits shared by the code review in the editor and in @provenflow/extract: whether a proposed
 * search/replace edit is already in a file, so that applying it again would only duplicate lines.
 */

export interface TextEdit {
    search: string;
    replace: string;
}

/**
 * Whether an edit is already in a text, so that applying it would only add the same lines again:
 * - the text already holds the replacement of an edit that inserts next to its anchor; or
 * - the searched text is there, and the edit only inserts blocks of lines, each right next to an
 *   identical copy of itself (a fix proposed again on code where it was already applied).
 */
export function isApplied(text: string | undefined, edit: TextEdit): boolean {
    if (text === undefined || edit.search === '' || edit.replace === edit.search) return false;
    if (edit.replace.includes(edit.search) && text.includes(edit.replace)) return true;
    return text.includes(edit.search) && onlyDuplicates(edit.search.split('\n'), edit.replace.split('\n'));
}

/** Whether `after` is `before` with only inserted blocks of lines, each a copy of the lines just above or below it. */
function onlyDuplicates(before: string[], after: string[]): boolean {
    const a = before.map(l => l.trim());
    const b = after.map(l => l.trim());
    const { head, x, y } = middle(a, b);
    if (y.length === 0 || x.length * y.length > 4_000_000) return false;
    const inserted = insertedLines(x, y);
    return inserted !== undefined && blocksOf(inserted.map(k => head + k)).every(([from, to]) => b.slice(from, to).every(l => l === '') || repeats(b, from, to));
}

/** The parts of two texts between their common first and last lines. */
function middle(a: string[], b: string[]): { head: number; x: string[]; y: string[] } {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { head, x: a.slice(head, a.length - tail), y: b.slice(head, b.length - tail) };
}

/**
 * The lines of `y` inserted into `x`, by their longest common subsequence: every line of `x` must be
 * kept (blank lines aside); undefined when one is removed.
 */
function insertedLines(x: string[], y: string[]): number[] | undefined {
    const lcs = lcsTable(x, y);
    if (lcs[0][0] !== x.filter(l => l !== '').length && lcs[0][0] !== x.length) return undefined;
    const inserted: number[] = [];
    let i = 0;
    for (let j = 0; j < y.length; j++) {
        // Walk the table: a common line, a line of `x` dropped (blank only), or a line of `y` inserted.
        while (i < x.length && x[i] !== y[j] && lcs[i + 1][j] >= lcs[i][j + 1]) {
            if (x[i] !== '') return undefined; // a line of `x` removed
            i++;
        }
        if (i < x.length && x[i] === y[j]) i++;
        else inserted.push(j);
    }
    return inserted;
}

/** lcs[i][j]: the length of the longest common subsequence of x[i..] and y[j..]. */
function lcsTable(x: string[], y: string[]): Uint32Array[] {
    const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    return lcs;
}

/** Consecutive line numbers grouped into [from, to) blocks. */
function blocksOf(lines: number[]): Array<[number, number]> {
    const blocks: Array<[number, number]> = [];
    for (const k of lines) {
        const last = blocks[blocks.length - 1];
        if (last && last[1] === k) last[1] = k + 1;
        else blocks.push([k, k + 1]);
    }
    return blocks;
}

/** Whether the block [from, to) of `b` repeats the lines right above or right below it. */
function repeats(b: string[], from: number, to: number): boolean {
    const same = (at: number) => at >= 0 && at + (to - from) <= b.length && b.slice(from, to).join('\n') === b.slice(at, at + (to - from)).join('\n');
    return same(from - (to - from)) || same(to);
}
