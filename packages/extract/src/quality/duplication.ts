/**
 * Duplicated code, in two forms:
 *
 * - **Clones** (`duplicated-code`): the same token sequence in two places, with identifiers and
 *   numbers normalised (Type-1 and Type-2 clones), found by Rabin-Karp hashing of token windows
 *   and grown to maximal matches, as PMD CPD and jscpd do. Default size: 100 tokens over 10 lines
 *   (SonarQube's thresholds).
 * - **Similar functions** (`similar-function`): two functions whose bags of tokens overlap by 80% or
 *   more (SourcererCC's Type-3 measure). This is how a function re-implementing an existing helper
 *   shows, which agents do more than people (Huang et al., MSR 2026).
 */
import { DEFAULT_DUPLICATION, type DuplicationConfig, type LayerConfig } from '../config.js';
import type { FunctionFact, Location } from '../ir.js';
import type { Finding } from '../models.js';
import { matchesAny } from '../scan.js';
import { tokenize, type Token } from './tokens.js';

export interface SourceTokens {
    file: string;
    tokens: Token[];
}

export interface Fragment {
    file: string;
    startLine: number;
    endLine: number;
}

export interface Clone {
    /** The first occurrence (by file and line). */
    original: Fragment;
    copy: Fragment;
    tokens: number;
    lines: number;
}

export interface DuplicationResult {
    clones: Clone[];
    similar: Array<{ a: FunctionFact; b: FunctionFact; similarity: number }>;
    /** Lines inside a clone, per file (both sides counted). */
    duplicatedLines: Map<string, Set<number>>;
    findings: Finding[];
}

const BASE = 1_000_003;

export function findClones(sources: SourceTokens[], minTokens: number, minLines: number): Clone[] {
    const ids = toIds(sources);
    const found = new Map<string, Clone>();
    for (const list of windowIndex(ids, minTokens).values()) {
        for (const [a, b] of pairsOf(list)) {
            const clone = grow(sources, ids, a, b, minTokens, minLines);
            if (!clone) continue;
            const key = `${clone.copy.file}:${clone.copy.startLine}:${clone.copy.endLine}`;
            const known = found.get(key);
            // A block copied several times is reported once per copy, against its first occurrence.
            if (!known || before(clone.original, known.original)) found.set(key, clone);
        }
    }
    return largest([...found.values()]).sort((x, y) => x.copy.file.localeCompare(y.copy.file) || x.copy.startLine - y.copy.startLine);
}

/** Each normalised token as a number. */
function toIds(sources: SourceTokens[]): number[][] {
    const vocabulary = new Map<string, number>();
    const idOf = (norm: string) => {
        let id = vocabulary.get(norm);
        if (id === undefined) vocabulary.set(norm, (id = vocabulary.size + 1));
        return id;
    };
    return sources.map(s => s.tokens.map(t => idOf(t.norm)));
}

/** Windows of K tokens by their Rabin-Karp hash: [file, start] of each. */
function windowIndex(ids: number[][], K: number): Map<number, Array<[number, number]>> {
    let power = 1;
    for (let k = 1; k < K; k++) power = Math.imul(power, BASE) >>> 0;
    const buckets = new Map<number, Array<[number, number]>>();
    ids.forEach((seq, f) => {
        if (seq.length < K) return;
        let h = 0;
        for (let k = 0; k < K; k++) h = (Math.imul(h, BASE) + seq[k]) >>> 0;
        for (let i = 0; i + K <= seq.length; i++) {
            if (i > 0) h = (Math.imul((h - Math.imul(seq[i - 1], power)) >>> 0, BASE) + seq[i + K - 1]) >>> 0;
            const list = buckets.get(h);
            if (list) list.push([f, i]);
            else buckets.set(h, [[f, i]]);
        }
    });
    return buckets;
}

/** The pairs of windows to compare in a bucket; a highly repeated window (boilerplate) only against the first. */
function pairsOf(list: Array<[number, number]>): Array<[[number, number], [number, number]]> {
    if (list.length < 2) return [];
    if (list.length > 12) return list.slice(1).map(y => [list[0], y]);
    const pairs: Array<[[number, number], [number, number]]> = [];
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) pairs.push([list[x], list[y]]);
    return pairs;
}

/** The maximal match starting at two windows, if it is a clone (left-maximal, long enough, not a repeated pattern). */
function grow(sources: SourceTokens[], ids: number[][], [fa, ia]: [number, number], [fb, ib]: [number, number], minTokens: number, minLines: number): Clone | undefined {
    const a = ids[fa];
    const b = ids[fb];
    // Left-maximal only: a match that extends to the left is found from its own start.
    if (ia > 0 && ib > 0 && a[ia - 1] === b[ib - 1]) return undefined;
    let length = 0;
    while (ia + length < a.length && ib + length < b.length && a[ia + length] === b[ib + length]) length++;
    if (fa === fb && ib < ia + length) length = ib - ia; // a repeated pattern overlapping itself
    if (length < minTokens || periodic(a, ia, length)) return undefined;
    const fragment = (f: number, i: number): Fragment => ({ file: sources[f].file, startLine: sources[f].tokens[i].line, endLine: sources[f].tokens[i + length - 1].line });
    const first = fragment(fa, ia);
    const second = fragment(fb, ib);
    const lines = Math.min(first.endLine - first.startLine, second.endLine - second.startLine) + 1;
    if (lines < minLines) return undefined;
    const [original, copy] = order(first, second);
    return { original, copy, tokens: length, lines };
}

/**
 * A block repeated several times in a row matches itself at several offsets: keep the largest match,
 * and drop copies that mostly overlap one already kept.
 */
function largest(clones: Clone[]): Clone[] {
    const kept: Clone[] = [];
    for (const c of [...clones].sort((x, y) => y.tokens - x.tokens)) {
        if (!kept.some(k => overlap(k.copy, c.copy) > 0.5 || (overlap(k.copy, c.original) > 0.5 && overlap(k.original, c.copy) > 0.5))) kept.push(c);
    }
    return kept;
}

function overlap(a: Fragment, b: Fragment): number {
    if (a.file !== b.file) return 0;
    return Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1) / Math.min(a.endLine - a.startLine + 1, b.endLine - b.startLine + 1);
}

/** A run that only repeats a short pattern (a table of values, a list of similar calls). */
function periodic(seq: number[], start: number, length: number): boolean {
    for (let p = 1; p <= 12; p++) {
        let k = start;
        while (k + p < start + length && seq[k] === seq[k + p]) k++;
        if (k + p >= start + length) return true;
    }
    return false;
}

function before(a: Fragment, b: Fragment): boolean {
    return a.file < b.file || (a.file === b.file && a.startLine < b.startLine);
}

function order(a: Fragment, b: Fragment): [Fragment, Fragment] {
    return before(a, b) ? [a, b] : [b, a];
}

/** Token bags of functions: identifiers, keywords and literals (operators and punctuation left out). */
export function functionBags(functions: FunctionFact[], tokensOf: (file: string) => Token[] | undefined): Map<FunctionFact, { bag: Map<string, number>; size: number }> {
    const out = new Map<FunctionFact, { bag: Map<string, number>; size: number }>();
    for (const fn of functions) {
        const tokens = tokensOf(fn.loc.file);
        if (!tokens) continue;
        const end = fn.loc.line + fn.lines - 1;
        const bag = new Map<string, number>();
        let size = 0;
        for (const t of tokens) {
            if (t.line < fn.loc.line || t.line > end || t.kind === 'op') continue;
            bag.set(t.text, (bag.get(t.text) ?? 0) + 1);
            size++;
        }
        out.set(fn, { bag, size });
    }
    return out;
}

export function similarFunctions(functions: FunctionFact[], tokensOf: (file: string) => Token[] | undefined, threshold: number, minTokens: number): Array<{ a: FunctionFact; b: FunctionFact; similarity: number }> {
    const bags = [...functionBags(functions, tokensOf).entries()].filter(([, b]) => b.size >= minTokens).sort((x, y) => x[1].size - y[1].size);
    const out: Array<{ a: FunctionFact; b: FunctionFact; similarity: number }> = [];
    for (let i = 0; i < bags.length; i++) {
        // Sorted by size: once a function is too large to reach the threshold, the next ones are too.
        for (let j = i + 1; j < bags.length && bags[i][1].size >= threshold * bags[j][1].size; j++) {
            const [fa, a] = bags[i];
            const [fb, b] = bags[j];
            if (contains(fa, fb) || contains(fb, fa)) continue;
            const similarity = shared(a.bag, b.bag) / Math.max(a.size, b.size);
            if (similarity >= threshold) out.push(before(fragmentOf(fa), fragmentOf(fb)) ? { a: fa, b: fb, similarity } : { a: fb, b: fa, similarity });
        }
    }
    return out;
}

/** Tokens two bags have in common (with their counts). */
function shared(a: Map<string, number>, b: Map<string, number>): number {
    let common = 0;
    for (const [t, n] of a) common += Math.min(n, b.get(t) ?? 0);
    return common;
}

function fragmentOf(f: FunctionFact): Fragment {
    return { file: f.loc.file, startLine: f.loc.line, endLine: f.loc.line + f.lines - 1 };
}

function contains(outer: FunctionFact, inner: FunctionFact): boolean {
    return outer.loc.file === inner.loc.file && outer.loc.line <= inner.loc.line && outer.loc.line + outer.lines >= inner.loc.line + inner.lines;
}

/** The innermost function around a line, for naming a fragment. */
export function enclosing(functions: FunctionFact[], file: string, line: number): FunctionFact | undefined {
    let best: FunctionFact | undefined;
    for (const f of functions) {
        if (f.loc.file !== file || f.loc.line > line || f.loc.line + f.lines - 1 < line) continue;
        if (!best || f.lines < best.lines) best = f;
    }
    return best;
}

export function functionLabel(f: FunctionFact): string {
    return f.id.includes('#') ? f.id.slice(f.id.indexOf('#') + 1) : f.name;
}

export function analyseDuplication(sources: SourceTokens[], functions: FunctionFact[], layers: LayerConfig[] | undefined, settings: DuplicationConfig = {}): DuplicationResult {
    const s = { ...DEFAULT_DUPLICATION, ...settings };
    const clones = findClones(sources, s.minTokens, s.minLines);
    const byFile = new Map(sources.map(x => [x.file, x.tokens]));
    const duplicatedLines = new Map<string, Set<number>>();
    for (const fr of clones.flatMap(c => [c.original, c.copy])) {
        const set = duplicatedLines.get(fr.file) ?? new Set<number>();
        for (let l = fr.startLine; l <= fr.endLine; l++) set.add(l);
        duplicatedLines.set(fr.file, set);
    }
    // A pair already reported as a clone is not reported again as similar.
    const inClone = (f: FunctionFact) => !!duplicatedLines.get(f.loc.file)?.has(f.loc.line) && !!duplicatedLines.get(f.loc.file)?.has(f.loc.line + f.lines - 1);
    const candidates = functions.filter(f => byFile.has(f.loc.file));
    const similar = similarFunctions(candidates, file => byFile.get(file), s.similarity, s.minFunctionTokens).filter(p => !(inClone(p.a) && inClone(p.b)));
    const reuse = reuseAdvice(layers);
    const findings = [...clones.map(c => cloneFinding(c, functions, reuse, s.minLines)), ...similar.map(p => similarFinding(p, reuse, s.similarity))];
    return { clones, similar, duplicatedLines, findings };
}

type Reuse = (from: string, to: string, name: string) => string;

/** How to reuse code of another file: import it, unless the layer rules forbid it (then: move it to a shared layer). */
function reuseAdvice(layers: LayerConfig[] | undefined): Reuse {
    const layerOf = (file: string) => layers?.find(l => matchesAny(file, l.paths));
    return (from, to, name) => {
        if (from === to) return `Keep one ${name} in ${to} and call it from both places.`;
        const a = layerOf(from);
        const b = layerOf(to);
        if (a && b && a.name !== b.name && !(a.mayImport ?? []).includes(b.name)) return `${from} is in layer ${a.name}, which may not import ${b.name}: move the shared code to a layer both may import, and use it from both places.`;
        return `Import it from ${to} instead of keeping a copy in ${from} (or move the shared code to a module both use).`;
    };
}

function cloneFinding(c: Clone, functions: FunctionFact[], reuse: Reuse, minLines: number): Finding {
    const inCopy = enclosing(functions, c.copy.file, c.copy.startLine);
    const inOriginal = enclosing(functions, c.original.file, c.original.startLine);
    const where = (fr: Fragment, fn: FunctionFact | undefined) => `${fr.file}:${fr.startLine}-${fr.endLine}${fn ? ` (${functionLabel(fn)})` : ''}`;
    return {
        rule: 'duplicated-code',
        category: 'duplication',
        severity: 'warning',
        subject: `${inCopy ? functionLabel(inCopy) : c.copy.file} = ${inOriginal ? functionLabel(inOriginal) : c.original.file}`,
        message: `${c.lines} lines (${c.tokens} tokens) at ${where(c.copy, inCopy)} repeat ${where(c.original, inOriginal)}${c.copy.file === c.original.file ? '' : ` in ${c.original.file}`}, apart from names and values. A fix made in one copy will be missing from the other.`,
        fix: `Extract the repeated lines into one function (parameterised by what differs) and call it from both places. ${reuse(c.copy.file, c.original.file, 'function')}`,
        loc: { file: c.copy.file, line: c.copy.startLine },
        endLine: c.copy.endLine,
        related: [{ file: c.original.file, line: c.original.startLine }],
        source: 'analysis',
        measure: { name: 'duplicated lines', value: c.lines, limit: minLines }
    };
}

function similarFinding(p: { a: FunctionFact; b: FunctionFact; similarity: number }, reuse: Reuse, threshold: number): Finding {
    const percent = Math.round(p.similarity * 100);
    return {
        rule: 'similar-function',
        category: 'duplication',
        severity: 'warning',
        subject: `${functionLabel(p.b)} ~ ${functionLabel(p.a)}`,
        message: `${functionLabel(p.b)} (${p.b.loc.file}:${p.b.loc.line}) shares ${percent}% of its tokens with ${functionLabel(p.a)} (${p.a.loc.file}:${p.a.loc.line}): it probably re-implements it.`,
        fix: `Reuse ${functionLabel(p.a)} (generalise it with a parameter if the two differ), or extract what they share into one function. ${reuse(p.b.loc.file, p.a.loc.file, 'version')}`,
        loc: p.b.loc,
        endLine: p.b.loc.line + p.b.lines - 1,
        related: [p.a.loc as Location],
        source: 'analysis',
        measure: { name: 'similarity %', value: percent, limit: Math.round(threshold * 100) }
    };
}

/**
 * Functions of the project similar to a snippet (for an agent about to write a helper): those holding
 * a copy of it with other names (normalised tokens, as clones are found), and those sharing
 * `threshold` of its tokens; best first.
 */
export function similarToSnippet(functions: FunctionFact[], read: (file: string) => string | undefined, code: string, fileName: string, threshold = 0.5, limit = 5): Array<{ fn: FunctionFact; similarity: number }> {
    const snippet = tokenize(code, fileName);
    if (snippet.length === 0) return [];
    const sources = [...new Set(functions.map(f => f.loc.file))].flatMap(file => {
        const text = read(file);
        return text === undefined ? [] : [{ file, tokens: tokenize(text, file) }];
    });
    const best = new Map<FunctionFact, number>();
    for (const { fn, similarity } of [...copiesOf(snippet, sources, functions), ...sharingTokens(snippet, sources, functions, threshold)]) {
        if (fn && similarity > (best.get(fn) ?? 0)) best.set(fn, similarity);
    }
    return [...best]
        .filter(([, similarity]) => similarity >= threshold)
        .map(([fn, similarity]) => ({ fn, similarity }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

const SNIPPET = '\0snippet';

/** Functions holding a copy of most of the snippet with other names: the share of the snippet the copy covers. */
function copiesOf(snippet: Token[], sources: SourceTokens[], functions: FunctionFact[]): Array<{ fn?: FunctionFact; similarity: number }> {
    const minTokens = Math.max(30, Math.floor(snippet.length * 0.6));
    return findClones([{ file: SNIPPET, tokens: snippet }, ...sources], minTokens, 3).flatMap(c => {
        const other = c.original.file === SNIPPET ? c.copy : c.copy.file === SNIPPET ? c.original : undefined;
        return other ? [{ fn: enclosing(functions, other.file, other.startLine), similarity: Math.min(1, c.tokens / snippet.length) }] : [];
    });
}

/** Functions sharing tokens with the snippet (Type-3), of a comparable size. */
function sharingTokens(snippet: Token[], sources: SourceTokens[], functions: FunctionFact[], threshold: number): Array<{ fn: FunctionFact; similarity: number }> {
    const bag = new Map<string, number>();
    for (const t of snippet) if (t.kind !== 'op') bag.set(t.text, (bag.get(t.text) ?? 0) + 1);
    const size = [...bag.values()].reduce((a, b) => a + b, 0);
    const byFile = new Map(sources.map(x => [x.file, x.tokens]));
    return [...functionBags(functions, f => byFile.get(f))].filter(([, b]) => b.size >= size * threshold && size >= b.size * threshold).map(([fn, b]) => ({ fn, similarity: shared(bag, b.bag) / Math.max(size, b.size) }));
}
