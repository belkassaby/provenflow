/**
 * Practices of The Pragmatic Programmer (Hunt and Thomas, 2nd ed.) and common code smells, found in
 * the text of the code, in every language:
 *
 *  - empty-catch: an error caught and dropped (Topic 24, Dead Programs Tell No Lies);
 *  - commented-out-code: code left behind in comments (Topic 3, Software Entropy);
 *  - train-wreck: a chain reaching through several objects (Topic 28, Decoupling: the Law of Demeter);
 *  - flag-argument: a boolean parameter choosing what a function does (Fowler, FlagArgument);
 *  - magic-number: a number in the logic with no name saying what it is.
 *
 * They are heuristics on tokens and lines, reported as notes, once per place. Each finding names its
 * catalogue entry (`practice`), which explains the practice and the refactoring.
 */
import type { FunctionFact } from '../ir.js';
import type { Finding } from '../models.js';
import { functionLabel } from './duplication.js';
import type { Token } from './tokens.js';

export interface PracticeSource {
    file: string;
    text: string;
    tokens: Token[];
}

export function practiceFindings(sources: PracticeSource[], functions: FunctionFact[]): Finding[] {
    const byFile = new Map<string, FunctionFact[]>();
    for (const f of functions) {
        if (!byFile.has(f.loc.file)) byFile.set(f.loc.file, []);
        byFile.get(f.loc.file)!.push(f);
    }
    const findings: Finding[] = [];
    for (const source of sources) {
        const owner = innermostFunctions(byFile.get(source.file) ?? []);
        // A finding of the file is about the function around it, when there is one.
        const subject = (line: number) => (owner.has(line) ? functionLabel(owner.get(line)!) : source.file);
        findings.push(...emptyCatches(source, subject), ...commentedOutCode(source, subject));
        for (const [fn, tokens] of tokensByFunction(source.tokens, owner)) {
            findings.push(...trainWrecks(fn, tokens), ...magicNumbers(fn, tokens), ...flagArguments(fn, source.text));
        }
    }
    return findings;
}

function practiceFinding(f: Omit<Finding, 'category' | 'severity' | 'source'> & { severity?: Finding['severity'] }): Finding {
    return { severity: 'info', ...f, category: 'practice', source: 'analysis' };
}

/** The innermost function around each line. */
function innermostFunctions(functions: FunctionFact[]): Map<number, FunctionFact> {
    const owner = new Map<number, FunctionFact>();
    for (const fn of [...functions].sort((a, b) => b.lines - a.lines)) {
        for (let line = fn.loc.line; line < fn.loc.line + Math.max(1, fn.lines); line++) owner.set(line, fn);
    }
    return owner;
}

/** The tokens of each function, nested functions apart: each line belongs to the innermost function around it. */
function tokensByFunction(tokens: Token[], owner: Map<number, FunctionFact>): Map<FunctionFact, Token[]> {
    const out = new Map<FunctionFact, Token[]>();
    for (const t of tokens) {
        const fn = owner.get(t.line);
        if (!fn) continue;
        if (!out.has(fn)) out.set(fn, []);
        out.get(fn)!.push(t);
    }
    return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

// ------------------------------------------------------------- empty catch

/** A handler that does nothing, per family of languages, and how to let the error go on instead. */
interface EmptyHandler {
    files: RegExp;
    pattern: RegExp;
    keyword: string;
    /** The handler rewritten to rethrow, or undefined when the language has no general way. */
    rethrow: (handler: string) => string | undefined;
}

const EMPTY_HANDLERS: EmptyHandler[] = [
    { files: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, pattern: /\bcatch\s*(?:\([^()]*\))?\s*\{\s*\}/g, keyword: 'catch', rethrow: h => namedRethrow(h, /\(\s*(\w+)/, n => `throw ${n};`, 'error') },
    { files: /\.(java|groovy)$/, pattern: /\bcatch\s*\([^()]*\)\s*\{\s*\}/g, keyword: 'catch', rethrow: h => namedRethrow(h, /\(\s*(?:[\w.<>|\s]+?\s+)?(\w+)\s*\)/, n => `throw ${n};`) },
    { files: /\.kts?$/, pattern: /\bcatch\s*\(\s*\w+\s*:[^()]*\)\s*\{\s*\}/g, keyword: 'catch', rethrow: h => namedRethrow(h, /\(\s*(\w+)/, n => `throw ${n}`) },
    { files: /\.php$/, pattern: /\bcatch\s*\([^()]*\)\s*\{\s*\}/g, keyword: 'catch', rethrow: h => namedRethrow(h, /(\$\w+)\s*\)/, n => `throw ${n};`) },
    { files: /\.(cs|cpp|cc|cxx|hpp|hh|hxx)$/, pattern: /\bcatch\s*(?:\([^()]*\))?\s*\{\s*\}/g, keyword: 'catch', rethrow: h => h.replace(/\{\s*\}$/, '{ throw; }') },
    { files: /\.swift$/, pattern: /\bcatch\s*\{\s*\}/g, keyword: 'catch', rethrow: h => h.replace(/\{\s*\}$/, '{ throw error }') },
    { files: /\.py$/, pattern: /^[ \t]*except\b[^\n#]*:[ \t]*(?:\n[ \t]*)?pass[ \t]*$/gm, keyword: 'except', rethrow: h => h.replace(/pass([ \t]*)$/, 'raise$1') },
    { files: /\.rb$/, pattern: /^[ \t]*rescue\b[^\n#]*\n[ \t]*end\b/gm, keyword: 'rescue', rethrow: h => h.replace(/\n([ \t]*)end$/, '\n$1  raise\n$1end') },
    { files: /\.go$/, pattern: /\bif\s+err\s*!=\s*nil\s*\{\s*\}/g, keyword: 'if', rethrow: () => undefined }
];

/**
 * The handler with its empty block rethrowing the caught error: named by `param`, or `fallback`
 * (added to a `catch {}` that names none); undefined when there is no name to rethrow.
 */
function namedRethrow(handler: string, param: RegExp, statement: (name: string) => string, fallback?: string): string | undefined {
    const name = param.exec(handler)?.[1];
    if (name) return handler.replace(/\{\s*\}$/, `{ ${statement(name)} }`);
    if (!fallback) return undefined;
    return handler.replace(/\bcatch\s*(?:\(\s*\))?\s*\{\s*\}$/, `catch (${fallback}) { ${statement(fallback)} }`);
}

function emptyCatches(source: PracticeSource, subject: (line: number) => string): Finding[] {
    const handler = EMPTY_HANDLERS.find(h => h.files.test(source.file));
    if (!handler) return [];
    // Only where the language keyword is a token: not in strings or comments.
    const keywordLines = new Set(source.tokens.filter(t => t.text === handler.keyword).map(t => t.line));
    const findings: Finding[] = [];
    for (const m of source.text.matchAll(handler.pattern)) {
        const at = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
        const line = lineOf(source.text, at);
        if (!keywordLines.has(line)) continue;
        findings.push(
            practiceFinding({
                rule: 'empty-catch',
                practice: 'dead-programs-tell-no-lies',
                severity: 'warning',
                subject: subject(line),
                message: `An error is caught here and dropped (${m[0].trim().split('\n')[0].trim()}): the program goes on in a state nobody checked, and the failure surfaces later, far from its cause.`,
                fix: 'Handle the error (recover, retry, or return an error value), or let it propagate. If ignoring it is right here, say why in a comment inside the block.',
                loc: { file: source.file, line },
                endLine: lineOf(source.text, at + m[0].trim().length)
            })
        );
    }
    return findings;
}

/** The quick fix for an empty handler: rethrow, so the program stops where the problem is (crash early). */
export function rethrowEdit(f: Finding, text: string): { search: string; replace: string } | undefined {
    const handler = EMPTY_HANDLERS.find(h => h.files.test(f.loc?.file ?? ''));
    if (!handler || !f.loc) return undefined;
    for (const m of text.matchAll(handler.pattern)) {
        const start = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
        if (lineOf(text, start) !== f.loc.line) continue;
        const replaced = handler.rethrow(m[0].trimStart());
        if (!replaced) return undefined;
        return uniqueEdit(text, start, start + m[0].trimStart().length, replaced);
    }
    return undefined;
}

// ------------------------------------------------------- commented-out code

const NOT_CODE = /^\s*(TODO|FIXME|NOTE|XXX|HACK|eslint|@ts-|prettier|noqa|type:|pylint|nosec|NOSONAR|istanbul|c8 |region|endregion|-\*-|SPDX|Copyright|>>>|\$ )|https?:\/\/|\.\.\.|…/i;
const CODE_LIKE = [
    /[;{]\s*$/,
    /^\s*[})\]][\s;,)]*$/,
    /^\s*(if|for|while|switch|return|const|let|var|def|class|import|from|print|elif|else|try|except|throw|raise|await|yield|function|public|private|func|fn)\b.*[(=:{;]/,
    /^\s*[\w$.[\]'"]+\s*(=|\+=|-=|:=)\s*\S/,
    /^\s*[\w$]+(\.[\w$]+)*\([^()]*\)\s*;?\s*$/
];
/** Four words in a row and none of the symbols code needs: a sentence, even one ending with a semicolon. */
const PROSE = /\b[A-Za-z][\w'’-]*(\s+[A-Za-z][\w'’,-]*){3,}/;

function isCodeLike(content: string): boolean {
    if (NOT_CODE.test(content) || !CODE_LIKE.some(p => p.test(content))) return false;
    return !PROSE.test(content) || /[(={]/.test(content);
}

/** Line comments of a language: `#` in Python, Ruby and R, `//` elsewhere (not `///` or `//!` doc comments, nor `#!`). */
const commentSyntax = (file: string) => (/\.(py|rb|r|R)$/.test(file) ? /^\s*#(?![!\[])(.*)$/ : /^\s*\/\/(?![/!])(.*)$/);

/** Lines inside multi-line string literals: what looks like a comment there is text. */
function stringLines(tokens: Token[]): Set<number> {
    const inside = new Set<number>();
    for (const t of tokens) {
        const extra = t.kind === 'lit' ? t.text.split('\n').length - 1 : 0;
        for (let i = 1; i <= extra; i++) inside.add(t.line + i);
    }
    return inside;
}

/** Runs of comment lines that read as code: two or more, or one that ends a statement or opens a block. */
function codeRuns(lines: string[], comment: RegExp, strings: Set<number>): Array<{ start: number; end: number }> {
    const runs: Array<{ start: number; end: number }> = [];
    const contentOf = (i: number) => (strings.has(i + 1) ? undefined : comment.exec(lines[i])?.[1]);
    let start = -1;
    const close = (end: number) => {
        if (start >= 0 && (end > start || /[;{}]\s*$/.test(contentOf(start) ?? ''))) runs.push({ start, end });
        start = -1;
    };
    lines.forEach((_, i) => {
        const content = contentOf(i);
        if (content !== undefined && isCodeLike(content)) {
            if (start < 0) start = i;
        } else if (content === undefined || content.trim() !== '') close(i - 1);
    });
    close(lines.length - 1);
    return runs;
}

function commentedOutCode(source: PracticeSource, subject: (line: number) => string): Finding[] {
    const lines = source.text.split('\n');
    return codeRuns(lines, commentSyntax(source.file), stringLines(source.tokens)).map(run =>
        practiceFinding({
            rule: 'commented-out-code',
            practice: 'commented-out-code',
            subject: subject(run.start + 1),
            message: `${run.end - run.start + 1} line(s) of code are commented out: dead code that readers must still read, and that rots as the code around it changes.`,
            fix: 'Delete it: version control keeps the old code. If it documents an alternative, say so in prose instead.',
            loc: { file: source.file, line: run.start + 1 },
            endLine: run.end + 1
        })
    );
}

/** The quick fix for commented-out code: delete the lines. */
export function deleteLinesEdit(f: Finding, text: string): { search: string; replace: string } | undefined {
    if (!f.loc) return undefined;
    const lines = text.split('\n');
    const first = f.loc.line - 1;
    const last = (f.endLine ?? f.loc.line) - 1;
    if (first < 0 || last >= lines.length) return undefined;
    const start = lines.slice(0, first).join('\n').length + (first > 0 ? 1 : 0);
    const end = start + lines.slice(first, last + 1).join('\n').length + (last + 1 < lines.length ? 1 : 0);
    return uniqueEdit(text, start, end, '');
}

/** A search/replace edit of text[start, end) whose search text occurs once: grown by whole lines around it until unique. */
export function uniqueEdit(text: string, start: number, end: number, replacement: string): { search: string; replace: string } | undefined {
    let from = start;
    let to = end;
    for (let i = 0; i < 20; i++) {
        const search = text.slice(from, to);
        if (search && text.indexOf(search) === text.lastIndexOf(search)) return { search, replace: text.slice(from, start) + replacement + text.slice(end, to) };
        const before = text.lastIndexOf('\n', from - 2);
        const after = text.indexOf('\n', to + 1);
        if (from === 0 && to === text.length) return undefined;
        from = before < 0 ? 0 : before + 1;
        to = after < 0 ? text.length : after;
    }
    return undefined;
}

// ------------------------------------------------------------- train wrecks

const NAVIGATION = new Set(['.', '?.', '->']);
const SELF = new Set(['this', 'self', 'super']);
/** Methods returning the same kind of object (collections, strings, promises, builders): chaining them is not reaching through objects. */
const FLUENT = new Set(
    (
        'map filter reduce flatMap forEach some every find findIndex findLast includes indexOf sort slice splice concat join split trim trimStart trimEnd ' +
        'replace replaceAll toLowerCase toUpperCase toString toFixed padStart padEnd startsWith endsWith match then catch finally pipe subscribe keys values ' +
        'entries length size append push pop shift strip lower upper format items stream collect orElse unwrap expect iter into_iter clone as_str to_string ok ' +
        'map_err and_then unwrap_or build get_or_insert filter_map lstrip rstrip encode decode reverse reversed sorted copy apply call bind next'
    ).split(' ')
);
const FLUENT_PREFIX = /^(with|set|add|and|or|to|as|on)[A-Z_]/;
/** Receivers that are namespaces, not objects: their members are not strangers. */
const NAMESPACES = new Set(['process', 'window', 'document', 'globalThis', 'os', 'sys', 'np', 'pd', 'torch', 'tf', 'std', 'fmt', 'math', 'Math', 'console', 'vscode']);

const isWord = (t: Token | undefined) => !!t && (t.kind === 'id' || t.kind === 'kw');

/** Past the arguments of a call (or an index) starting at `j`. */
function skipGroup(tokens: Token[], j: number): number {
    const open = tokens[j]?.text;
    if (open !== '(' && open !== '[') return j;
    const close = open === '(' ? ')' : ']';
    let depth = 0;
    for (; j < tokens.length; j++) {
        if (tokens[j].text === open) depth++;
        else if (tokens[j].text === close && --depth === 0) return j + 1;
    }
    return j;
}

interface Chain {
    line: number;
    text: string;
    strangers: string[];
}

/** Member chains starting at `i`: the receiver, then each `.name` or `.name(...)`. */
function chainAt(tokens: Token[], i: number): Chain | undefined {
    const receiver = tokens[i];
    if (!isWord(receiver) || NAVIGATION.has(tokens[i - 1]?.text ?? '') || NAMESPACES.has(receiver.text)) return undefined;
    const steps: Array<{ name: string; call: boolean }> = [];
    let j = skipGroup(tokens, i + 1);
    while (NAVIGATION.has(tokens[j]?.text) && isWord(tokens[j + 1])) {
        const next = skipGroup(tokens, j + 2);
        steps.push({ name: tokens[j + 1].text, call: tokens[j + 2]?.text === '(' });
        j = next;
    }
    // Own members are friends (this.x); what is reached through them, before the last message, are strangers.
    const reached = (SELF.has(receiver.text) ? steps.slice(1) : steps).slice(0, -1);
    const strangers = reached.filter(s => !FLUENT.has(s.name) && !FLUENT_PREFIX.test(s.name) && !/^[A-Z]/.test(s.name)).map(s => s.name);
    return { line: receiver.line, text: [receiver.text, ...steps.map(s => `${s.name}${s.call ? '()' : ''}`)].join('.'), strangers };
}

const TRAIN_WRECK_HOPS = 3;

function trainWrecks(fn: FunctionFact, tokens: Token[]): Finding[] {
    const wrecks: Chain[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const chain = chainAt(tokens, i);
        if (chain && chain.strangers.length >= TRAIN_WRECK_HOPS) wrecks.push(chain);
    }
    if (wrecks.length === 0) return [];
    const first = wrecks[0];
    return [
        practiceFinding({
            rule: 'train-wreck',
            practice: 'law-of-demeter',
            subject: functionLabel(fn),
            message: `${functionLabel(fn)} reaches through ${first.strangers.length} objects in \`${first.text}\` (${first.strangers.join(' → ')})${wrecks.length > 1 ? `, and ${wrecks.length - 1} more chain(s) like it` : ''}: it depends on the structure of objects it does not own, so a change in any of them breaks it.`,
            fix: 'Tell, don\'t ask: give the nearest object a method that does the work (or returns exactly the value needed), or pass that value in.',
            loc: { file: fn.loc.file, line: first.line }
        })
    ];
}

// ------------------------------------------------------------ magic numbers

const PLAIN_NUMBERS = new Set(['0', '1', '2', '10', '100', '1000', '0.5', '60', '24', '1024', '200', '201', '204', '301', '302', '304', '400', '401', '403', '404', '409', '422', '500', '503']);

/** A number given a name where it appears: `const LIMIT = 5`, `limit = 5`, `{ limit: 5 }`, a default value, an enum member, a case label, an index. */
function named(tokens: Token[], i: number): boolean {
    let k = i - 1;
    if (tokens[k]?.text === '-' || tokens[k]?.text === '+') k--;
    const before = tokens[k]?.text;
    return before === '=' || before === ':=' || before === '[' || before === 'case' || before === ':';
}

function magicNumbers(fn: FunctionFact, tokens: Token[]): Finding[] {
    const magic = tokens.filter((t, i) => t.norm === '$num' && !PLAIN_NUMBERS.has(t.text.replace(/_/g, '').replace(/^(\d+)\.0+$/, '$1')) && !named(tokens, i));
    if (magic.length === 0) return [];
    const listed = magic.slice(0, 5).map(t => `${t.text} (line ${t.line})`);
    return [
        practiceFinding({
            rule: 'magic-number',
            practice: 'magic-number',
            subject: functionLabel(fn),
            message: `${functionLabel(fn)} uses ${magic.length} unexplained number(s): ${listed.join(', ')}${magic.length > 5 ? '…' : ''}. A reader cannot tell what they mean, and a change to one has to find all its copies.`,
            fix: 'Give each number a named constant (or a configuration value) saying what it is, and use the name.',
            loc: { file: fn.loc.file, line: magic[0].line }
        })
    ];
}

// ----------------------------------------------------------- flag arguments

/** `name: boolean` (TypeScript, Python, Kotlin, Swift, Scala, Rust), `boolean name` (Java, C#, C, C++), `name bool` (Go). */
const FLAG_PARAMS = [/(?:^|,)\s*(?:(?:readonly|private|public|protected|val|var)\s+)?_?\s*(\w+)\??\s*:\s*(?:boolean|bool|Bool|Boolean)\b/g, /\b(?:boolean|bool|Boolean)\s+(\w+)\s*(?:[,=]|$)/g, /(?:^|,)\s*(\w+)\s+bool\b/g];
/** Setters, toggles and predicates take a boolean by nature; constructors configure. */
const FLAG_EXEMPT = /^(?:(?:set|with|enable|disable|toggle|show|hide|use|is|has|should|can|allow)(?=[A-Z_]|$)|constructor$|__init__$|init$)/;

/** The parameter list of the function declared at `line` (its top level only: nested types and callbacks left out). */
function parameterList(text: string, line: number): string | undefined {
    const start = line > 1 ? text.split('\n').slice(0, line - 1).join('\n').length + 1 : 0;
    const head = text.slice(start, start + 1500);
    const open = head.indexOf('(');
    if (open < 0) return undefined;
    let depth = 0;
    let out = '';
    for (let i = open; i < head.length; i++) {
        const ch = head[i];
        const arrow = ch === '>' && (head[i - 1] === '=' || head[i - 1] === '-');
        if ('([{<'.includes(ch)) depth++;
        else if (')]}>'.includes(ch) && !arrow) depth--;
        else if (depth === 1) out += ch;
        if (depth === 0) return out;
    }
    return undefined;
}

function flagArguments(fn: FunctionFact, text: string): Finding[] {
    if (FLAG_EXEMPT.test(fn.name.charAt(0).toLowerCase() + fn.name.slice(1)) || fn.params === 0) return [];
    const params = parameterList(text, fn.loc.line);
    if (!params) return [];
    const flags = [...new Set(FLAG_PARAMS.flatMap(p => [...params.matchAll(p)].map(m => m[1])))].filter(n => !['self', 'this'].includes(n));
    if (flags.length === 0) return [];
    return [
        practiceFinding({
            rule: 'flag-argument',
            practice: 'flag-argument',
            subject: functionLabel(fn),
            message: `${functionLabel(fn)} takes the boolean flag${flags.length > 1 ? 's' : ''} ${flags.map(f => `\`${f}\``).join(', ')}: a call like ${fn.name}(…, true) does not say what true means, and the function does two things.`,
            fix: `Split ${fn.name} into one function per case, named for what each does, or replace the flag with an options object or an enum naming the choice.`,
            loc: fn.loc
        })
    ];
}
