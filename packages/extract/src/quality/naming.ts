/**
 * Naming conventions: each class, free function, method and field name is compared with the style
 * expected for its language and kind of name. The expected style is, in order:
 *   1. the project's config (`naming`);
 *   2. the style the project itself uses for that kind (when at least 80% of 8 or more names agree:
 *      consistency with the code base wins over the style guide, as NATURALIZE learns it);
 *   3. the language's style guide (`STANDARDS`).
 * Findings are notes: names are advice, not a gate.
 */
import type { NameKind, NamingStyle, ProvenflowConfig } from '../config.js';
import type { Facts, Language, Location } from '../ir.js';
import type { Finding } from '../models.js';
import { STANDARDS } from './standards.js';

type Shape = NamingStyle | 'lower' | 'upper' | 'mixed';

/** The shape of a name, once leading/trailing underscores and sigils are removed. */
export function shapeOf(raw: string): Shape | undefined {
    const name = raw.replace(/^[_$@]+|_+$/g, '').replace(/[?!=]$/, '');
    if (!name || !/^[A-Za-z]/.test(name)) return undefined;
    if (/^[a-z][a-z0-9]*$/.test(name)) return 'lower';
    if (/^[A-Z][A-Z0-9]*$/.test(name)) return 'upper';
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake_case';
    if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name)) return 'SCREAMING_SNAKE_CASE';
    if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return 'camelCase';
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase';
    return 'mixed';
}

export function fits(shape: Shape, style: NamingStyle): boolean {
    switch (style) {
        case 'camelCase':
            return shape === 'camelCase' || shape === 'lower';
        case 'snake_case':
            return shape === 'snake_case' || shape === 'lower';
        case 'PascalCase':
            return shape === 'PascalCase' || shape === 'upper';
        case 'SCREAMING_SNAKE_CASE':
            return shape === 'SCREAMING_SNAKE_CASE' || shape === 'upper';
        case 'MixedCaps':
            return shape === 'camelCase' || shape === 'PascalCase' || shape === 'lower' || shape === 'upper';
    }
}

/** A name rewritten in a style (for the suggested fix). */
export function restyle(name: string, style: NamingStyle): string {
    const lead = /^[_$@]*/.exec(name)![0];
    const words = name.slice(lead.length).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean).map(w => w.toLowerCase());
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    switch (style) {
        case 'camelCase':
        case 'MixedCaps':
            return lead + words.map((w, i) => (i === 0 ? w : cap(w))).join('');
        case 'PascalCase':
            return lead + words.map(cap).join('');
        case 'snake_case':
            return lead + words.join('_');
        case 'SCREAMING_SNAKE_CASE':
            return lead + words.join('_').toUpperCase();
    }
}

interface Name {
    name: string;
    kind: NameKind;
    language: Language;
    loc: Location;
}

const SKIP = /^(constructor|__\w+__|__construct|initialize|init|deinit|new|main|toString|equals|hashCode|ngOn\w+)$/;

export function collectNames(facts: Facts, isTest: (file: string) => boolean): Name[] {
    const languageOf = new Map(facts.modules.map(m => [m.file, m.language]));
    const out: Name[] = [];
    const add = (name: string, kind: NameKind, language: Language | undefined, loc: Location) => {
        if (!language || isTest(loc.file) || SKIP.test(name)) return;
        // AST visitor methods (visit_If), and test-style names, follow their framework.
        if (language === 'python' && /^(visit|depart|leave|enter|generic_visit|test)_/.test(name)) return;
        out.push({ name, kind, language, loc });
    };
    for (const c of facts.classes) {
        add(c.name, 'class', c.language, c.loc);
        for (const m of c.methods) add(m.name, 'method', c.language, m.loc);
        for (const f of c.fields) add(f.name, f.static && f.readonly ? 'constant' : 'field', c.language, c.loc);
    }
    for (const f of facts.functions) if (f.free) add(f.name, 'function', languageOf.get(f.loc.file), f.loc);
    return out;
}

export interface Convention {
    language: Language;
    kind: NameKind;
    style: NamingStyle;
    from: 'config' | 'project' | 'standard';
    names: number;
    fitting: number;
}

export function namingFindings(facts: Facts, config: ProvenflowConfig, isTest: (file: string) => boolean): { findings: Finding[]; conventions: Convention[] } {
    if (config.naming === false) return { findings: [], conventions: [] };
    const groups = new Map<string, Name[]>();
    for (const n of collectNames(facts, isTest)) groups.set(`${n.language}|${n.kind}`, [...(groups.get(`${n.language}|${n.kind}`) ?? []), n]);
    const findings: Finding[] = [];
    const conventions: Convention[] = [];
    for (const group of groups.values()) {
        const convention = expectedStyle(group, config);
        if (!convention) continue;
        const off = group.filter(n => !fitsConvention(n, convention.style));
        findings.push(...off.map(n => namingFinding(n, convention, group)));
        conventions.push({ ...convention, names: group.length, fitting: group.length - off.length });
    }
    return { findings, conventions };
}

/** The style a group of names (one language, one kind) should follow, and where that comes from. */
function expectedStyle(group: Name[], config: ProvenflowConfig): Omit<Convention, 'names' | 'fitting'> | undefined {
    const { language, kind } = group[0];
    const declared = config.languages?.[language]?.naming?.[kind] ?? (config.naming ? config.naming[language]?.[kind] : undefined);
    if (declared) return { language, kind, style: declared, from: 'config' };
    const standard = STANDARDS[language]?.naming[kind];
    // The style guide, unless the project consistently does otherwise.
    const inferred = standard && percent(group, standard) >= 80 ? undefined : dominant(group);
    if (inferred) return { language, kind, style: inferred, from: 'project' };
    return standard ? { language, kind, style: standard, from: 'standard' } : undefined;
}

function fitsConvention(n: Name, style: NamingStyle): boolean {
    const shape = shapeOf(n.name);
    // In .tsx files, functions in PascalCase are components (they return JSX).
    return !shape || fits(shape, style) || (n.language === 'typescript' && n.kind === 'function' && n.loc.file.endsWith('.tsx') && shape === 'PascalCase');
}

function namingFinding(n: Name, c: Omit<Convention, 'names' | 'fitting'>, group: Name[]): Finding {
    const shape = shapeOf(n.name);
    const basis = c.from === 'config' ? 'provenflow.config.json declares' : c.from === 'project' ? `the project mostly uses (${percent(group, c.style)}% of ${group.length})` : `${STANDARDS[n.language].guide} asks for`;
    const plural = n.kind === 'class' ? 'classes' : `${n.kind}s`;
    return {
        rule: 'naming-convention',
        category: 'naming',
        severity: 'info',
        subject: `${n.kind} ${n.name}`,
        message: `${n.kind[0].toUpperCase()}${n.kind.slice(1)} ${n.name} is ${shape === 'mixed' ? 'in no single style' : shape}, but ${basis} ${c.style} for ${LANGUAGE_NAMES[n.language]} ${plural}.`,
        fix: `Rename it ${restyle(n.name, c.style)} (and its uses), or declare the project's convention in provenflow.config.json "languages".`,
        loc: n.loc,
        source: 'analysis'
    };
}

const STYLES: NamingStyle[] = ['camelCase', 'PascalCase', 'snake_case', 'SCREAMING_SNAKE_CASE'];

/** The style at least 80% of a group (of 8 or more names, not all one-word) fits. */
export function dominant(group: Array<{ name: string }>): NamingStyle | undefined {
    const shapes = group.map(n => shapeOf(n.name)).filter((s): s is Shape => !!s);
    const informative = shapes.filter(s => s !== 'lower' && s !== 'upper');
    if (shapes.length < 8 || informative.length < 4) return undefined;
    let best: NamingStyle | undefined;
    let bestCount = 0;
    for (const style of STYLES) {
        const count = shapes.filter(s => fits(s, style)).length;
        if (count > bestCount) [best, bestCount] = [style, count];
    }
    return best && bestCount / shapes.length >= 0.8 ? best : undefined;
}

function percent(group: Array<{ name: string }>, style: NamingStyle): number {
    const shapes = group.map(n => shapeOf(n.name)).filter((s): s is Shape => !!s);
    return Math.round((shapes.filter(s => fits(s, style)).length / Math.max(1, shapes.length)) * 100);
}

export const LANGUAGE_NAMES: Record<Language, string> = {
    typescript: 'TypeScript',
    python: 'Python',
    java: 'Java',
    kotlin: 'Kotlin',
    groovy: 'Groovy',
    scala: 'Scala',
    c: 'C',
    cpp: 'C++',
    c_sharp: 'C#',
    go: 'Go',
    rust: 'Rust',
    swift: 'Swift',
    ruby: 'Ruby',
    php: 'PHP',
    r: 'R'
};
