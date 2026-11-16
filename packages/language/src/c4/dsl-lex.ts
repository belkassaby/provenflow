/**
 * The lexer of the Structurizr DSL: the text as statements (one per line, `\` continues a line),
 * each a list of words and quoted strings, with the `{` that opens a block and the `}` that closes
 * one as statements of their own. Comments (`#` or `//` starting a line, `/* *\/`) are dropped, and
 * `!const` / `!constant` values are substituted into `${NAME}`.
 */

export interface C4Token {
    text: string;
    /** Written in quotes: never a keyword or `{`. */
    quoted: boolean;
    line: number;
}

export interface C4Statement {
    line: number;
    words: C4Token[];
    /** The statement ends with `{`: a block follows. */
    open: boolean;
    /** A `}` alone. */
    close: boolean;
}

export interface C4Diagnostic {
    line: number;
    severity: 'error' | 'warning';
    message: string;
}

/** A position in a list of statements. */
export interface StatementCursor {
    stmts: C4Statement[];
    i: number;
}

interface Cursor {
    text: string;
    i: number;
    line: number;
}

export function lexDsl(text: string, diagnostics: C4Diagnostic[]): C4Statement[] {
    const c: Cursor = { text: text.replace(/\r\n?/g, '\n'), i: 0, line: 1 };
    const out: C4Statement[] = [];
    let current: C4Token[] = [];
    let startLine = 1;
    const flush = (open = false) => {
        if (current.length || open) out.push({ line: startLine, words: current, open, close: false });
        current = [];
    };
    while (c.i < c.text.length) {
        const ch = c.text[c.i];
        if (current.length === 0) startLine = c.line;
        if (ch === '\n') {
            flush();
            c.line++;
            c.i++;
        } else if (/\s/.test(ch)) c.i++;
        else if (ch === '\\' && /^\\[ \t]*\n/.test(c.text.slice(c.i, c.i + 64))) skipContinuation(c);
        else if (startsComment(c, current)) skipComment(c);
        else if (ch === '{') {
            c.i++;
            flush(true);
        } else if (ch === '}') {
            flush();
            out.push({ line: c.line, words: [], open: false, close: true });
            c.i++;
        } else current.push(ch === '"' ? readString(c, diagnostics) : readWord(c));
    }
    flush();
    return substituteConstants(out, diagnostics);
}

function skipContinuation(c: Cursor): void {
    c.i = c.text.indexOf('\n', c.i) + 1;
    c.line++;
}

/** A comment starts here: `/*` anywhere, `#` or `//` only first on a line (before the statement's words). */
function startsComment(c: Cursor, words: C4Token[]): boolean {
    if (c.text.startsWith('/*', c.i)) return true;
    return words.length === 0 && lineStartsHere(c) && (c.text[c.i] === '#' || c.text.startsWith('//', c.i));
}

/** Nothing but blanks before this point on its line (a `#` later on a line is a colour, not a comment). */
function lineStartsHere(c: Cursor): boolean {
    for (let j = c.i - 1; j >= 0 && c.text[j] !== '\n'; j--) if (!/\s/.test(c.text[j])) return false;
    return true;
}

function skipComment(c: Cursor): void {
    if (c.text.startsWith('/*', c.i)) {
        const end = c.text.indexOf('*/', c.i + 2);
        const stop = end < 0 ? c.text.length : end + 2;
        for (let j = c.i; j < stop; j++) if (c.text[j] === '\n') c.line++;
        c.i = stop;
        return;
    }
    const end = c.text.indexOf('\n', c.i);
    c.i = end < 0 ? c.text.length : end;
}

function readString(c: Cursor, diagnostics: C4Diagnostic[]): C4Token {
    const line = c.line;
    if (c.text.startsWith('"""', c.i)) {
        const end = c.text.indexOf('"""', c.i + 3);
        const stop = end < 0 ? c.text.length : end;
        const body = c.text.slice(c.i + 3, stop);
        c.line += body.split('\n').length - 1;
        c.i = stop + 3;
        return { text: body.replace(/^\n/, '').replace(/\n\s*$/, ''), quoted: true, line };
    }
    let text = '';
    let j = c.i + 1;
    for (; j < c.text.length && c.text[j] !== '"' && c.text[j] !== '\n'; j++) {
        if (c.text[j] === '\\' && (c.text[j + 1] === '"' || c.text[j + 1] === '\\')) j++;
        text += c.text[j];
    }
    if (c.text[j] !== '"') diagnostics.push({ line, severity: 'error', message: 'Unterminated string: a closing " is missing on this line.' });
    c.i = c.text[j] === '"' ? j + 1 : j;
    return { text, quoted: true, line };
}

function readWord(c: Cursor): C4Token {
    const start = c.i;
    while (c.i < c.text.length && !/[\s{}"]/.test(c.text[c.i])) c.i++;
    return { text: c.text.slice(start, c.i), quoted: false, line: c.line };
}

function substituteConstants(statements: C4Statement[], diagnostics: C4Diagnostic[]): C4Statement[] {
    const constants = new Map<string, string>();
    const out: C4Statement[] = [];
    for (const s of statements) {
        const words = s.words.map(w => (w.text.includes('${') ? { ...w, text: w.text.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (all, name: string) => constants.get(name) ?? all) } : w));
        const head = words[0]?.text.toLowerCase();
        if (!words[0]?.quoted && (head === '!const' || head === '!constant' || head === '!var')) {
            if (words.length >= 3) constants.set(words[1].text, words[2].text);
            else diagnostics.push({ line: s.line, severity: 'error', message: `${words[0].text} needs a name and a value.` });
            continue;
        }
        out.push({ ...s, words });
    }
    return out;
}

/** Skips the rest of the block just opened, nested blocks included. */
export function skipBlock(st: StatementCursor): void {
    for (let depth = 1; st.i < st.stmts.length && depth > 0; st.i++) {
        const s = st.stmts[st.i];
        if (s.close) depth--;
        else if (s.open) depth++;
    }
}

/** Runs `handle` on each statement of the block just opened, up to its `}`. */
export function eachInBlock(st: StatementCursor, handle: (s: C4Statement) => void): void {
    while (st.i < st.stmts.length) {
        const s = st.stmts[st.i++];
        if (s.close) return;
        handle(s);
    }
}
