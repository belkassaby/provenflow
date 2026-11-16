/**
 * What the TypeScript/JavaScript and Python sources of a project import (and which names), and the
 * top-level functions and classes they define, with their extent: enough to see which project's
 * code a file uses, and to compare definitions across projects. Read with regular expressions and
 * the shared tokenizer, not a compiler: it has to be quick on a dozen projects.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { isTestFile, listSourceFiles } from '../scan.js';
import { tokenize, type Token } from '../quality/tokens.js';
import type { ProjectInfo } from './discover.js';

export interface SourceImport {
    /** As written: `@scope/lib`, `./util`, `numpy.linalg`, `.models`. */
    spec: string;
    /** Imported names (`default`, `*` for a namespace or a plain Python `import x`). */
    names: string[];
    line: number;
    relative: boolean;
}

export interface SourceDefinition {
    name: string;
    kind: 'function' | 'class' | 'value' | 'type';
    exported: boolean;
    line: number;
    lines: number;
}

export interface SourceFile {
    file: string;
    language: 'ts' | 'py';
    imports: SourceImport[];
    definitions: SourceDefinition[];
    test: boolean;
}

export interface ProjectSources {
    project: ProjectInfo;
    files: SourceFile[];
    /** Import prefixes that are the project's own (tsconfig `paths`, its own package names). */
    internal: string[];
    /** Python: the modules and packages at the top of the project (or of src/), which `import x` finds first. */
    topLevel: Set<string>;
    truncated: boolean;
    /** The tokens of a file (read again on demand, for comparing definitions). */
    tokens(file: string): Token[] | undefined;
}

const SOURCE = /\.(ts|tsx|mts|cts|py)$/;
const MAX_FILES = 4000;
const MAX_BYTES = 512 * 1024;

export function readSources(project: ProjectInfo): ProjectSources {
    let all: string[] = [];
    try {
        all = listSourceFiles(project.dir).filter(f => SOURCE.test(f) && !f.endsWith('.d.ts'));
    } catch {
        all = [];
    }
    const files: SourceFile[] = [];
    const cache = new Map<string, Token[]>();
    for (const file of all.slice(0, MAX_FILES)) {
        const text = readSmall(join(project.dir, file));
        if (text !== undefined) files.push(parseSource(file, text));
    }
    return {
        project,
        files,
        internal: [...tsPaths(project.dir), ...project.modules.map(m => m.name)],
        topLevel: new Set(files.filter(f => f.language === 'py').map(f => f.file.replace(/^src\//, '').split('/')[0].replace(/\.py$/, ''))),
        truncated: all.length > MAX_FILES,
        tokens(file: string) {
            if (!cache.has(file)) {
                const text = readSmall(join(project.dir, file));
                if (text === undefined) return undefined;
                cache.set(file, tokenize(text, file));
            }
            return cache.get(file);
        }
    };
}

function readSmall(path: string): string | undefined {
    try {
        return statSync(path).size > MAX_BYTES ? undefined : readFileSync(path, 'utf8');
    } catch {
        return undefined;
    }
}

export function parseSource(file: string, text: string): SourceFile {
    const py = file.endsWith('.py');
    return { file, language: py ? 'py' : 'ts', imports: py ? pythonImports(text) : tsImports(text), definitions: py ? pythonDefinitions(text) : tsDefinitions(text, file), test: isTestFile(file) };
}

function lineAt(text: string, index: number): number {
    let line = 1;
    for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) line++;
    return line;
}

/** Names of an import clause: `X`, `{ A, B as C }`, `* as N`, or combinations. */
function clauseNames(clause: string): string[] {
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) names.push(...braces[1].split(',').map(n => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean));
    const rest = clause.replace(/\{[^}]*\}/, '').trim();
    if (/\*\s+as\s+\w+/.test(rest) || rest === '*') names.push('*');
    else if (/^[A-Za-z_$][\w$]*/.test(rest.replace(/^type\s+/, ''))) names.push('default');
    return names;
}

export function tsImports(text: string): SourceImport[] {
    const out: SourceImport[] = [];
    const push = (spec: string, names: string[], index: number) => out.push({ spec, names, line: lineAt(text, index), relative: spec.startsWith('.') });
    for (const m of text.matchAll(/^[ \t]*(import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/gm)) push(m[3], clauseNames(m[2]), m.index ?? 0);
    for (const m of text.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) push(m[1], [], m.index ?? 0);
    for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], ['*'], m.index ?? 0);
    return out;
}

export function pythonImports(text: string): SourceImport[] {
    const out: SourceImport[] = [];
    for (const m of text.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
        const names = m[2].replace(/[()]/g, '').split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        out.push({ spec: m[1], names, line: lineAt(text, m.index ?? 0), relative: m[1].startsWith('.') });
    }
    for (const m of text.matchAll(/^[ \t]*import\s+([\w., \t]+)/gm)) {
        for (const spec of m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) out.push({ spec, names: ['*'], line: lineAt(text, m.index ?? 0), relative: false });
    }
    return out;
}

const TS_DEFINITION = /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

export function tsDefinitions(text: string, file: string): SourceDefinition[] {
    const out: SourceDefinition[] = [];
    let tokens: Token[] | undefined;
    for (const m of text.matchAll(TS_DEFINITION)) {
        const line = lineAt(text, m.index ?? 0);
        const keyword = m[2];
        tokens ??= tokenize(text, file);
        const kind = keyword.startsWith('function') ? 'function' : keyword === 'class' ? 'class' : keyword === 'interface' || keyword === 'type' || keyword === 'enum' ? 'type' : 'value';
        out.push({ name: m[3], kind, exported: !!m[1], line, lines: blockLines(tokens, line, text.slice(m.index ?? 0).split('\n', 1)[0]) });
    }
    return out;
}

/** How many lines a declaration starting at `line` spans: up to the `}` closing its first `{` (one line when it opens none). */
function blockLines(tokens: Token[], line: number, firstLine: string): number {
    if (!firstLine.includes('{') && !/=>\s*$|\($|,$|[=(]\s*$/.test(firstLine.trim()) && /;\s*$/.test(firstLine)) return 1;
    let i = tokens.findIndex(t => t.line >= line && t.text === '{');
    if (i < 0 || tokens[i].line > line + 20) return 1;
    for (let depth = 0; i < tokens.length; i++) {
        if (tokens[i].text === '{') depth++;
        else if (tokens[i].text === '}' && --depth === 0) return tokens[i].line - line + 1;
    }
    return 1;
}

export function pythonDefinitions(text: string): SourceDefinition[] {
    const lines = text.split('\n');
    const out: SourceDefinition[] = [];
    lines.forEach((l, i) => {
        const m = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(l);
        if (!m) return;
        let end = i + 1;
        while (end < lines.length && (/^\s/.test(lines[end]) || lines[end].trim() === '' || /^[)\]]/.test(lines[end]))) end++;
        while (end > i + 1 && lines[end - 1].trim() === '') end--;
        out.push({ name: m[2], kind: m[1] === 'def' ? 'function' : 'class', exported: !m[2].startsWith('_'), line: i + 1, lines: end - i });
    });
    return out;
}

/** tsconfig `paths` keys (`@app/*` → `@app/`): imports that look like packages but are the project's own folders. */
function tsPaths(dir: string): string[] {
    for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
        try {
            const text = readFileSync(join(dir, name), 'utf8').replace(/^\s*\/\/.*$/gm, '');
            const paths = /"paths"\s*:\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
            const keys = [...paths.matchAll(/"([^"]+)"\s*:/g)].map(m => m[1].replace(/\*$/, ''));
            if (keys.length) return keys;
        } catch {
            // No tsconfig.
        }
    }
    return [];
}

/** The package an import names: `@scope/name/sub` → `@scope/name`, `lodash/fp` → `lodash`, `numpy.linalg` → `numpy`. */
export function packageOf(imp: SourceImport, language: 'ts' | 'py'): string {
    if (language === 'py') return imp.spec.split('.')[0];
    const parts = imp.spec.split('/');
    return imp.spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The project file a relative import names, if it is one of `files`. */
export function resolveRelative(from: string, imp: SourceImport, language: 'ts' | 'py', files: Set<string>): string | undefined {
    if (language === 'py') {
        const dots = /^\.+/.exec(imp.spec)?.[0].length ?? 0;
        let base = dirname(from);
        for (let n = 1; n < dots; n++) base = dirname(base);
        const rest = imp.spec.slice(dots).replace(/\./g, '/');
        const stem = posix.normalize(rest ? `${base}/${rest}` : base).replace(/^\.\//, '');
        return [`${stem}.py`, `${stem}/__init__.py`].find(f => files.has(f));
    }
    const stem = posix.normalize(posix.join(posix.dirname(from), imp.spec)).replace(/\.(m|c)?js$/, '');
    return [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}/index.ts`, `${stem}/index.tsx`].find(f => files.has(f));
}
