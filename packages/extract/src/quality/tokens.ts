/**
 * A lexer shared by the 15 languages, for the duplication checks: identifiers, keywords, literals and
 * operators with their line, comments dropped. `norm` is the token with identifiers and numbers
 * replaced by placeholders, so that copies differing only in names and numbers (Type-2 clones) match.
 * Strings stay as written: lines that differ only in their text (messages, generated code) are data,
 * not duplicated logic.
 * Import and package lines are skipped: two files importing the same modules are not duplicated code.
 */

export interface Token {
    text: string;
    /** `$id` for identifiers, `$num` for numbers, the text itself for strings, keywords and operators. */
    norm: string;
    kind: 'id' | 'kw' | 'lit' | 'op';
    line: number;
}

const KEYWORDS = new Set(
    (
        'abstract and as assert async await break case catch class const continue def default defer del delete do elif else enum except export extends ' +
        'false final finally fn for foreach from fun func function go goto if impl implements import in instanceof interface is lambda let loop match ' +
        'mod module mut namespace new nil none not null object of or override package pass private protected pub public raise readonly return select ' +
        'self static struct super switch this throw throws trait true try type typeof undefined unless until use val var void when where while with yield ' +
        'None True False elsif end begin rescue ensure then def require require_relative include using virtual sealed internal guard repeat defer ' +
        'chan map range interface fallthrough crate dyn ref move unsafe where Self'
    ).split(' ')
);

const OPERATORS = ['>>>=', '===', '!==', '**=', '...', '>>>', '<<=', '>>=', '?.', '??', '=>', '->', '::', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', ':=', '<-', '|>'];

type Family = 'c' | 'hash' | 'php';

function familyOf(file: string): Family {
    if (/\.(py|rb|r|R|sh|ya?ml|toml)$/.test(file)) return 'hash';
    if (/\.php$/.test(file)) return 'php';
    return 'c';
}

const IMPORT_LINE = /^\s*(import\b|from\s+[\w.]+\s+import\b|export\s+(\*|\{[^}]*\})\s+from\b|#\s*include\b|using\s+[\w.]+\s*;|package\s+[\w.]+|require(_relative)?\b|use\s+[\w:\\]+|library\(|source\(|@file:|namespace\s+[\w\\]+\s*;)/;

/** The state of a scan: position, line, and whether an import statement is being skipped. */
interface Scan {
    readonly text: string;
    readonly family: Family;
    readonly python: boolean;
    readonly rust: boolean;
    i: number;
    line: number;
    lineStart: boolean;
    /** Inside an import statement: its tokens are dropped up to the end of its line, or of its braces. */
    skipping: boolean;
    depth: number;
    out: Token[];
}

type Scanner = (s: Scan) => boolean;

export function tokenize(text: string, file: string): Token[] {
    const s: Scan = { text, family: familyOf(file), python: file.endsWith('.py'), rust: file.endsWith('.rs'), i: 0, line: 1, lineStart: true, skipping: false, depth: 0, out: [] };
    while (s.i < text.length) {
        if (!SCANNERS.some(scan => scan(s))) operator(s);
    }
    return s.out;
}

function push(s: Scan, t: Omit<Token, 'line'>, line = s.line): void {
    if (!s.skipping) s.out.push({ ...t, line });
}

const whitespace: Scanner = s => {
    const c = s.text[s.i];
    if (c === '\n') {
        s.line++;
        s.i++;
        s.lineStart = true;
        if (s.skipping && s.depth <= 0) s.skipping = false;
        return true;
    }
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
    s.i++;
    return true;
};

/** At the first token of a line: an import statement starts skipping. */
const importLine: Scanner = s => {
    if (!s.lineStart) return false;
    s.lineStart = false;
    const end = s.text.indexOf('\n', s.i);
    if (IMPORT_LINE.test(s.text.slice(s.i, end < 0 ? s.text.length : end))) {
        s.skipping = true;
        s.depth = 0;
    }
    return false;
};

const lineComment: Scanner = s => {
    const c = s.text[s.i];
    const slashes = s.family !== 'hash' && c === '/' && s.text[s.i + 1] === '/';
    const hash = (s.family === 'hash' || s.family === 'php') && c === '#' && !(s.family === 'php' && s.text[s.i + 1] === '[');
    if (!slashes && !hash) return false;
    const end = s.text.indexOf('\n', s.i);
    s.i = end < 0 ? s.text.length : end;
    return true;
};

const blockComment: Scanner = s => {
    if (s.family === 'hash' || s.text[s.i] !== '/' || s.text[s.i + 1] !== '*') return false;
    const end = s.text.indexOf('*/', s.i + 2);
    const stop = end < 0 ? s.text.length : end + 2;
    s.line += countNewlines(s.text, s.i, stop);
    s.i = stop;
    return true;
};

const string: Scanner = s => {
    const c = s.text[s.i];
    if (c !== '"' && c !== "'" && c !== '`') return false;
    if (s.rust && c === "'" && !/^'(\\.|[^'\\])'/.test(s.text.slice(s.i, s.i + 5))) return false; // a lifetime ('a), not a character
    const quote = s.python && s.text.startsWith(c.repeat(3), s.i) ? c.repeat(3) : c;
    const stop = Math.min(s.text.length, stringEnd(s.text, s.i + quote.length, quote) + quote.length);
    const literal = s.text.slice(s.i, stop);
    push(s, { text: literal, norm: literal, kind: 'lit' });
    s.line += countNewlines(s.text, s.i, stop);
    s.i = stop;
    return true;
};

/** Where a string opened with `quote` ends: its closing quote, or the end of the line for an unclosed one-line string. */
function stringEnd(text: string, from: number, quote: string): number {
    const multiline = quote.length === 3 || quote === '`';
    let k = from;
    while (k < text.length && !text.startsWith(quote, k) && (multiline || text[k] !== '\n')) k += text[k] === '\\' ? 2 : 1;
    return k;
}

const number: Scanner = s => {
    const c = s.text[s.i];
    if (!/[0-9]/.test(c) && !(c === '.' && /[0-9]/.test(s.text[s.i + 1] ?? ''))) return false;
    const k = scanWhile(s.text, s.i + 1, /[\w.]/);
    push(s, { text: s.text.slice(s.i, k), norm: '$num', kind: 'lit' });
    s.i = k;
    return true;
};

const word: Scanner = s => {
    if (!/[A-Za-z_$@]/.test(s.text[s.i])) return false;
    const k = scanWhile(s.text, s.i + 1, /[\w$]/);
    const text = s.text.slice(s.i, k);
    const keyword = KEYWORDS.has(text);
    push(s, { text, norm: keyword ? text : '$id', kind: keyword ? 'kw' : 'id' });
    s.i = k;
    return true;
};

const SCANNERS: Scanner[] = [whitespace, importLine, lineComment, blockComment, string, number, word];

function operator(s: Scan): void {
    const op = OPERATORS.find(o => s.text.startsWith(o, s.i)) ?? s.text[s.i];
    if (s.skipping) s.depth += OPENING.has(op) ? 1 : CLOSING.has(op) ? -1 : 0;
    push(s, { text: op, norm: op, kind: 'op' });
    s.i += op.length;
}

const OPENING = new Set(['{', '(', '[']);
const CLOSING = new Set(['}', ')', ']']);

function scanWhile(text: string, from: number, re: RegExp): number {
    let k = from;
    while (k < text.length && re.test(text[k])) k++;
    return k;
}

function countNewlines(text: string, from: number, to: number): number {
    let n = 0;
    for (let k = from; k < to; k++) if (text[k] === '\n') n++;
    return n;
}

/** Whether a file says it was generated (its first lines). */
export function isGenerated(text: string): boolean {
    const head = text.slice(0, 600);
    return /@generated|\bgenerated by\b|do not edit|this file was generated|auto-?generated/i.test(head);
}

/** Lines that hold code (a token), for the size measures. */
export function codeLines(tokens: Token[]): number {
    const lines = new Set<number>();
    for (const t of tokens) lines.add(t.line);
    return lines.size;
}
