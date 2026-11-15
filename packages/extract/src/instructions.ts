/**
 * The instruction files coding agents read (AGENTS.md, CLAUDE.md, REVIEW.md, Copilot instructions,
 * Cursor rules) state conventions in prose, and nothing checks that agents follow them. Here an LLM
 * translates the statements that can be checked into provenflow.config.json entries; an entry is kept
 * only if it validates against the config schema (known layers, patterns, styles, limits), so the
 * statement becomes a deterministic check. Nothing is kept on the LLM's word alone.
 *
 * The files are read from the base revision when one is given, so a pull request cannot change the
 * rules it is checked against (as Claude Code Review does with REVIEW.md).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATTERNS, type NameKind, type NamingStyle, type ProvenflowConfig, type Style } from './config.js';
import type { Language } from './ir.js';
import type { LlmProvider } from './llm-types.js';
import { STANDARDS } from './quality/standards.js';

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'REVIEW.md', 'GEMINI.md', '.github/copilot-instructions.md', 'BUGBOT.md', '.cursor/BUGBOT.md', '.windsurfrules', '.clinerules'];
const INSTRUCTION_DIRS: Array<[string, RegExp]> = [
    ['.github/instructions', /\.instructions\.md$/],
    ['.cursor/rules', /\.(md|mdc)$/],
    ['.claude/rules', /\.md$/]
];

export interface InstructionFile {
    file: string;
    text: string;
}

/** The instruction files of the project, at `base` (a git revision) or in the working tree. */
export function readInstructions(root: string, base?: string): InstructionFile[] {
    const read = (file: string): string | undefined => {
        if (base) {
            const r = spawnSync('git', ['show', `${base}:./${file}`], { cwd: root, encoding: 'utf8' });
            return r.status === 0 ? r.stdout : undefined;
        }
        try {
            return readFileSync(join(root, file), 'utf8');
        } catch {
            return undefined;
        }
    };
    const list = (dir: string): string[] => {
        if (base) {
            const r = spawnSync('git', ['ls-tree', '--name-only', `${base}:./${dir}`], { cwd: root, encoding: 'utf8' });
            return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
        }
        return existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : [];
    };
    const files = [...INSTRUCTION_FILES, ...INSTRUCTION_DIRS.flatMap(([dir, re]) => list(dir).filter(f => re.test(f)).map(f => `${dir}/${f}`))];
    return files.flatMap(file => {
        const text = read(file);
        return text?.trim() ? [{ file, text }] : [];
    });
}

export interface InstructionRule {
    /** The sentence of the instruction file it comes from. */
    statement: string;
    file?: string;
    config: ProvenflowConfig;
}

export interface InstructionResult {
    config: ProvenflowConfig;
    kept: InstructionRule[];
    rejected: Array<{ statement: string; reason: string }>;
}

const SCHEMA = `provenflow.config.json fields you may use (JSON):
- "layers": [{ "name": string, "paths": [glob], "mayImport": [layer names], "style": "functional" | "object-oriented" }]  (what each part of the code may import, and its programming style)
- "patterns": [{ "subject": class name, "pattern": one of ${PATTERNS.join(', ')} }]
- "languages": { <language>: { "naming": { "class"|"function"|"method"|"field"|"constant": "camelCase"|"PascalCase"|"snake_case"|"SCREAMING_SNAKE_CASE"|"MixedCaps" }, "limits": { "functionLines": n, "functionParams": n, "classMethods": n, "classLines": n }, "complexity": { "cognitive": n, "nesting": n } } }
  (languages: ${Object.keys(STANDARDS).join(', ')})
- "machines": { "<Class>.<field>": { "terminal": [state values], "specs": [CTL/LTL over state = 'value'] } }
- "duplication": { "minTokens": n, "minLines": n }
- "dependencies": true`;

const SYSTEM = 'You turn coding rules written in prose into configuration for a static checker. Answer with JSON only. Only translate statements the checker can verify with the fields given; leave out everything else (tone, process, testing advice, anything vague). Quote each statement exactly.';

export async function rulesFromInstructions(files: InstructionFile[], llm: LlmProvider): Promise<InstructionResult> {
    if (files.length === 0) return { config: {}, kept: [], rejected: [] };
    const user = [
        SCHEMA,
        '',
        'Instruction files:',
        ...files.map(f => `--- ${f.file}\n${f.text.slice(0, 20_000)}`),
        '',
        'Answer: {"rules": [{"file": "<file>", "statement": "<exact sentence>", "config": { <only the fields above> }}]}'
    ].join('\n');
    const answer = await llm.complete(SYSTEM, user);
    const parsed = jsonIn(answer) as { rules?: Array<{ file?: string; statement?: string; config?: unknown }> } | undefined;
    const kept: InstructionRule[] = [];
    const rejected: Array<{ statement: string; reason: string }> = [];
    const texts = files.map(f => f.text).join('\n');
    for (const r of parsed?.rules ?? []) {
        const statement = String(r.statement ?? '').trim();
        if (!statement) continue;
        if (!texts.includes(statement.slice(0, 40))) {
            rejected.push({ statement, reason: 'not found in the instruction files (the LLM must quote them)' });
            continue;
        }
        const v = validateFragment(r.config);
        if (v.errors.length || !Object.keys(v.config).length) rejected.push({ statement, reason: v.errors.join('; ') || 'nothing checkable' });
        else kept.push({ statement, file: r.file, config: v.config });
    }
    return { config: mergeConfigs(kept.map(k => k.config)), kept, rejected };
}

function jsonIn(answer: string): unknown {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
    const text = fenced ? fenced[1] : answer.slice(Math.max(0, answer.search(/[[{]/)));
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

const STYLES: Style[] = ['functional', 'object-oriented', 'any'];
const NAMING: NamingStyle[] = ['camelCase', 'PascalCase', 'snake_case', 'SCREAMING_SNAKE_CASE', 'MixedCaps'];
const KINDS: NameKind[] = ['class', 'function', 'method', 'field', 'constant'];
const LIMIT_KEYS = ['functionLines', 'functionParams', 'classMethods', 'classLines', 'inheritanceDepth'];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 100_000;
const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0);

type FieldCheck = (value: unknown, config: ProvenflowConfig) => string | undefined;

/** One check per field a rule may set: it copies a valid value into the config, or says what is wrong. */
const FIELDS: Record<string, FieldCheck> = {
    layers: (value, config) => {
        const ok = Array.isArray(value) && value.every(l => isObject(l) && typeof l.name === 'string' && strings(l.paths) && (l.mayImport === undefined || strings(l.mayImport)) && (l.style === undefined || STYLES.includes(l.style as Style)));
        if (!ok) return 'layers need a name, paths and known styles';
        config.layers = value as ProvenflowConfig['layers'];
        return undefined;
    },
    patterns: (value, config) => {
        const ok = Array.isArray(value) && value.every(p => isObject(p) && typeof p.subject === 'string' && (PATTERNS as readonly unknown[]).includes(p.pattern));
        if (!ok) return `patterns must be one of ${PATTERNS.join(', ')}`;
        config.patterns = value as ProvenflowConfig['patterns'];
        return undefined;
    },
    languages: (value, config) => {
        if (!isObject(value)) return 'languages must be an object';
        const errors: string[] = [];
        const languages: NonNullable<ProvenflowConfig['languages']> = {};
        for (const [lang, settings] of Object.entries(value)) {
            const valid = languageSettings(lang, settings);
            if (typeof valid === 'string') errors.push(valid);
            else languages[lang as Language] = valid;
        }
        if (Object.keys(languages).length) config.languages = languages;
        return errors.length ? errors.join('; ') : undefined;
    },
    machines: (value, config) => {
        const ok = isObject(value) && Object.values(value).every(m => isObject(m) && (m.terminal === undefined || strings(m.terminal)) && (m.specs === undefined || strings(m.specs)));
        if (!ok) return 'machines need terminal and specs as lists of strings';
        config.machines = value as ProvenflowConfig['machines'];
        return undefined;
    },
    duplication: (value, config) => {
        if (!isObject(value) || !Object.values(value).every(isCount)) return 'duplication takes counts';
        config.duplication = value as ProvenflowConfig['duplication'];
        return undefined;
    },
    dependencies: (value, config) => {
        if (typeof value !== 'boolean') return 'dependencies is true or false';
        config.dependencies = value;
        return undefined;
    }
};

/** The valid naming, limits and complexity of one language, or what is wrong. */
function languageSettings(lang: string, settings: unknown): NonNullable<ProvenflowConfig['languages']>[Language] | string {
    if (!(lang in STANDARDS) || !isObject(settings)) return `unknown language ${lang}`;
    const pick = (value: unknown, valid: (k: string, v: unknown) => boolean) => (isObject(value) ? Object.entries(value).filter(([k, v]) => valid(k, v)) : []);
    const naming = pick(settings.naming, (k, v) => KINDS.includes(k as NameKind) && NAMING.includes(v as NamingStyle));
    const limits = pick(settings.limits, (k, v) => LIMIT_KEYS.includes(k) && isCount(v));
    const complexity = pick(settings.complexity, (k, v) => (k === 'cognitive' || k === 'nesting') && isCount(v));
    if (!naming.length && !limits.length && !complexity.length) return `nothing valid for ${lang}`;
    return {
        ...(naming.length ? { naming: Object.fromEntries(naming) } : {}),
        ...(limits.length ? { limits: Object.fromEntries(limits) } : {}),
        ...(complexity.length ? { complexity: Object.fromEntries(complexity) } : {})
    };
}

/** The parts of a config fragment that follow the schema; everything else is an error. */
export function validateFragment(raw: unknown): { config: ProvenflowConfig; errors: string[] } {
    const config: ProvenflowConfig = {};
    if (!isObject(raw)) return { config, errors: ['not an object'] };
    const errors = Object.entries(raw).flatMap(([key, value]) => {
        const check = FIELDS[key];
        const error = check ? check(value, config) : `${key} is not a field the rules may set`;
        return error ? [error] : [];
    });
    return { config, errors };
}

/** Several fragments as one config: lists are concatenated, objects merged (later ones win). */
export function mergeConfigs(fragments: ProvenflowConfig[]): ProvenflowConfig {
    return fragments.reduce<ProvenflowConfig>(
        (out, f) => ({
            ...out,
            ...(f.layers ? { layers: [...(out.layers ?? []).filter(l => !f.layers!.some(n => n.name === l.name)), ...f.layers] } : {}),
            ...(f.patterns ? { patterns: [...(out.patterns ?? []), ...f.patterns] } : {}),
            ...(f.machines ? { machines: { ...out.machines, ...f.machines } } : {}),
            ...(f.languages ? { languages: mergeLanguages(out.languages ?? {}, f.languages) } : {}),
            ...(f.duplication ? { duplication: { ...(out.duplication || {}), ...f.duplication } } : {}),
            ...(f.dependencies !== undefined ? { dependencies: f.dependencies } : {})
        }),
        {}
    );
}

function mergeLanguages(a: NonNullable<ProvenflowConfig['languages']>, b: NonNullable<ProvenflowConfig['languages']>): NonNullable<ProvenflowConfig['languages']> {
    const out = { ...a };
    for (const lang of Object.keys(b) as Language[]) {
        const x = a[lang] ?? {};
        const y = b[lang] ?? {};
        out[lang] = { naming: { ...x.naming, ...y.naming }, limits: { ...x.limits, ...y.limits }, complexity: { ...x.complexity, ...y.complexity } };
    }
    return out;
}
