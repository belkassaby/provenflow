/**
 * Whether a proposed edit is already in a text, so that applying it would only duplicate lines.
 * The same rule as isApplied in @provenflow/extract (the browser applies edits itself when it
 * writes to a folder opened with write access).
 */
export function isApplied(text: string | undefined, edit: { search: string; replace: string }): boolean {
    if (text === undefined || edit.search === '' || edit.replace === edit.search) return false;
    if (edit.replace.includes(edit.search) && text.includes(edit.replace)) return true;
    return text.includes(edit.search) && onlyDuplicates(edit.search.split('\n'), edit.replace.split('\n'));
}

/** Whether `after` is `before` with only inserted blocks of lines, each a copy of the lines just above or below it. */
function onlyDuplicates(before: string[], after: string[]): boolean {
    const a = before.map(l => l.trim());
    const b = after.map(l => l.trim());
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const x = a.slice(head, a.length - tail);
    const y = b.slice(head, b.length - tail);
    if (y.length === 0 || x.length * y.length > 4_000_000) return false;
    // Longest common subsequence of the middle parts: every line of `before` must be kept.
    const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    if (lcs[0][0] !== x.filter(l => l !== '').length && lcs[0][0] !== x.length) return false;
    const inserted: number[] = [];
    for (let i = 0, j = 0; j < y.length; ) {
        if (i < x.length && x[i] === y[j]) {
            i++;
            j++;
        } else if (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1]) {
            if (x[i] !== '') return false; // a line of `before` removed
            i++;
        } else inserted.push(head + j++);
    }
    // Group the inserted lines into blocks; each must repeat the lines right above or below it.
    const blocks: Array<[number, number]> = [];
    for (const k of inserted) {
        const last = blocks[blocks.length - 1];
        if (last && last[1] === k) last[1] = k + 1;
        else blocks.push([k, k + 1]);
    }
    const same = (from: number, to: number, at: number) => at >= 0 && at + (to - from) <= b.length && b.slice(from, to).join('\n') === b.slice(at, at + (to - from)).join('\n');
    return blocks.every(([from, to]) => b.slice(from, to).every(l => l === '') || same(from, to, from - (to - from)) || same(from, to, to));
}
