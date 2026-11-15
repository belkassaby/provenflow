/**
 * Where code belongs, across the projects of one owner:
 *
 * - **move-to-dependency**: a file that uses nothing of its own project, only another project it
 *   depends on (and libraries), could live in that project: the lowest one that has everything it
 *   imports, so that the other users of that project can share it.
 * - **move-to-consumer**: a file of a library used by only one of the library's consumers, and not
 *   by the library itself, belongs to that consumer (unless code outside these projects uses it).
 * - **duplicate-across-projects**: the same function or class in two projects (80%+ of tokens
 *   shared): keep one, in the project the other depends on, or in a dependency they share.
 */
import { similarFunctions } from '../quality/duplication.js';
import type { FunctionFact } from '../ir.js';
import { declares, displayName, importProfile, isGlue, type PlacementContext, type PlacementSuggestion } from './context.js';
import { packageOf, resolveRelative, type ProjectSources, type SourceFile } from './sources.js';

const PER_PROJECT = 15;

export function moveToDependency(ctx: PlacementContext, sources: ProjectSources): PlacementSuggestion[] {
    const deps = ctx.closure(sources.project.id);
    if (!deps.size) return [];
    const importers = importerCounts(sources);
    const out = sources.files.filter(f => !f.test && !isGlue(f.file)).flatMap(f => moveSuggestion(ctx, sources, f, deps, importers.get(f.file) ?? 0));
    return out.sort((a, b) => Number(a.confidence !== 'high') - Number(b.confidence !== 'high')).slice(0, PER_PROJECT);
}

/** A file that imports nothing of its own project, only projects it depends on (and libraries): where it could go. */
function moveSuggestion(ctx: PlacementContext, sources: ProjectSources, f: SourceFile, deps: Set<string>, users: number): PlacementSuggestion[] {
    const p = sources.project;
    const profile = importProfile(ctx, sources, f);
    const used = [...profile.projects.keys()].filter(id => deps.has(id));
    if (profile.relative.length || profile.internal.length || !used.length || used.length !== profile.projects.size) return [];
    const target = lowestProvider(ctx, used, deps);
    if (!target) return [];
    const to = displayName(ctx, target);
    const missing = [...profile.libraries].filter(lib => !declares(ctx.byId.get(target)!, lib));
    const names = used.map(id => `${displayName(ctx, id)} (${[...profile.projects.get(id)!].filter(n => n !== '*' && n !== 'default').slice(0, 4).join(', ') || 'whole module'})`).join(', ');
    const libraries = profile.libraries.size ? ` and ${[...profile.libraries].join(', ')}` : '';
    const importedBy = users ? ` (${users} file${users > 1 ? 's' : ''} of ${p.name} import${users > 1 ? '' : 's'} it)` : '';
    const needs = missing.length ? ` ${to} would need ${missing.join(', ')} as dependencies.` : '';
    return [{
        kind: 'move-to-dependency',
        severity: 'info',
        confidence: missing.length ? 'medium' : 'high',
        title: `${f.file} could move to ${to}`,
        detail: `It imports nothing from ${p.name}, only ${names}${libraries}. In ${to} the other projects using it could share it; ${p.name} would import it from there${importedBy}.${needs}`,
        project: p.id,
        target,
        files: [{ project: p.id, file: f.file, line: 1 }],
        practice: 'orthogonality'
    }];
}

/** Of the dependencies that provide everything `used` names, the one depending on the fewest others (the tightest fit). */
function lowestProvider(ctx: PlacementContext, used: string[], deps: Set<string>): string | undefined {
    const fits = [...deps].filter(q => used.every(u => u === q || ctx.closure(q).has(u)) && ctx.sources.has(q));
    return fits.sort((a, b) => ctx.closure(a).size - ctx.closure(b).size)[0];
}

/** How many files of the project import each file (re-exporting barrels left out). */
function importerCounts(sources: ProjectSources): Map<string, number> {
    const files = new Set(sources.files.map(f => f.file));
    const counts = new Map<string, number>();
    for (const f of sources.files) {
        if (/(^|\/)(index\.tsx?|public[-_]api\.ts|__init__\.py)$/.test(f.file)) continue;
        for (const imp of f.imports.filter(i => i.relative)) {
            const target = resolveRelative(f.file, imp, f.language, files);
            if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
        }
    }
    return counts;
}

/** For a library: which names each consumer project imports from it (`*`: all of them). */
function consumerNames(ctx: PlacementContext, lib: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const [id, s] of ctx.sources) {
        if (id === lib) continue;
        for (const f of s.files) {
            for (const imp of f.imports) {
                if (imp.relative || ctx.provider(packageOf(imp, f.language), f.language) !== lib) continue;
                out.set(id, new Set([...(out.get(id) ?? []), ...imp.names]));
            }
        }
    }
    return out;
}

export function moveToConsumer(ctx: PlacementContext, sources: ProjectSources): PlacementSuggestion[] {
    const lib = sources.project;
    const consumers = consumerNames(ctx, lib.id);
    if (consumers.size < 2) return [];
    const importers = importerCounts(sources);
    const definedIn = new Map<string, number>();
    for (const d of sources.files.flatMap(f => f.definitions)) definedIn.set(d.name, (definedIn.get(d.name) ?? 0) + 1);
    const out: PlacementSuggestion[] = [];
    for (const f of sources.files) {
        if (f.test || isGlue(f.file) || importers.get(f.file)) continue;
        // A name defined in several files of the library (`main`) does not say which one a consumer uses.
        const exported = f.definitions.filter(d => d.exported && d.kind !== 'type' && definedIn.get(d.name) === 1).map(d => d.name);
        if (!exported.length) continue;
        const users = [...consumers].filter(([, names]) => names.has('*') || exported.some(n => names.has(n))).map(([id]) => id);
        if (users.length !== 1) continue;
        out.push(consumerSuggestion(ctx, lib.id, f, users[0], exported.filter(n => consumers.get(users[0])!.has(n) || consumers.get(users[0])!.has('*')), consumers.size));
    }
    return out.slice(0, PER_PROJECT);
}

function consumerSuggestion(ctx: PlacementContext, lib: string, f: SourceFile, user: string, names: string[], consumers: number): PlacementSuggestion {
    const libName = displayName(ctx, lib);
    return {
        kind: 'move-to-consumer',
        severity: 'info',
        confidence: 'medium',
        title: `${f.file} of ${libName} is used only by ${displayName(ctx, user)}`,
        detail: `Of the ${consumers} projects using ${libName}, only ${displayName(ctx, user)} imports ${names.slice(0, 5).join(', ')}, and nothing in ${libName} uses this file. It may belong in ${displayName(ctx, user)}, which keeps ${libName} general; keep it if code outside these projects uses it (${libName} is published).`,
        project: lib,
        target: user,
        files: [{ project: lib, file: f.file, line: 1 }],
        practice: 'orthogonality'
    };
}

const SEPARATOR = '::';
/** Identifiers, keywords and literals a definition needs to count as a copy (operators left out). */
const MIN_TOKENS = 40;

/** Functions and classes defined in two projects with 85% of their tokens in common. */
export function duplicatesAcross(ctx: PlacementContext): PlacementSuggestion[] {
    const facts = [...ctx.sources].flatMap(([id, s]) => s.files.filter(f => !f.test).flatMap(f => f.definitions.filter(d => (d.kind === 'function' || d.kind === 'class') && d.lines >= 5).map(d => fact(id, f.file, d.name, d.line, d.lines))));
    const tokensOf = (key: string) => ctx.sources.get(projectOf(key))?.tokens(fileOf(key));
    const pairs = similarFunctions(facts, tokensOf, 0.85, MIN_TOKENS).filter(p => projectOf(p.a.loc.file) !== projectOf(p.b.loc.file));
    const byProjects = new Map<string, typeof pairs>();
    for (const pair of pairs) {
        const key = [projectOf(pair.a.loc.file), projectOf(pair.b.loc.file)].sort().join('|');
        byProjects.set(key, [...(byProjects.get(key) ?? []), pair]);
    }
    return [...byProjects.values()].map(group => duplicateSuggestion(ctx, group.sort((x, y) => y.similarity * y.a.lines - x.similarity * x.a.lines)));
}

/** A definition's project and file, from its `project::file` key. */
const projectOf = (key: string) => key.slice(0, key.indexOf(SEPARATOR));
const fileOf = (key: string) => key.slice(key.indexOf(SEPARATOR) + SEPARATOR.length);

function fact(project: string, file: string, name: string, line: number, lines: number): FunctionFact {
    return { id: `${project}${SEPARATOR}${file}:${line}`, name, loc: { file: `${project}${SEPARATOR}${file}`, line }, lines, exported: true, free: true, params: 0, higherOrder: false, mutatesParams: [], writesOuter: [], effects: [], usesThis: false };
}

function duplicateSuggestion(ctx: PlacementContext, pairs: Array<{ a: FunctionFact; b: FunctionFact; similarity: number }>): PlacementSuggestion {
    const pa = projectOf(pairs[0].a.loc.file);
    const pb = projectOf(pairs[0].b.loc.file);
    const home = ctx.closure(pa).has(pb) ? pb : ctx.closure(pb).has(pa) ? pa : sharedDependency(ctx, pa, pb);
    const best = Math.max(...pairs.map(p => p.similarity));
    const names = pairs.slice(0, 6).map(p => (p.a.name === p.b.name ? p.a.name : `${p.a.name} / ${p.b.name}`)).join(', ');
    const many = pairs.length > 1;
    return {
        kind: 'duplicate-across-projects',
        severity: 'warning',
        confidence: best >= 0.95 ? 'high' : 'medium',
        title: many ? `${pairs.length} functions or classes are in both ${displayName(ctx, pa)} and ${displayName(ctx, pb)}` : `${names} is in both ${displayName(ctx, pa)} and ${displayName(ctx, pb)} (${Math.round(best * 100)}% alike)`,
        detail: `${many ? `${names}${pairs.length > 6 ? ', …' : ''}: up to ${Math.round(best * 100)}% of their tokens in common. ` : ''}The same code in two projects drifts apart as each is fixed on its own (DRY). ${whereToKeep(ctx, pa, pb, home, many ? 'them' : 'it')}`,
        project: home && home !== pa && home !== pb ? pa : home === pa ? pb : pa,
        target: home,
        files: pairs.slice(0, 30).flatMap(p => [p.a, p.b].map(f => ({ project: projectOf(f.loc.file), file: fileOf(f.loc.file), line: f.loc.line, lines: f.lines }))),
        practice: 'dry'
    };
}

function whereToKeep(ctx: PlacementContext, pa: string, pb: string, home: string | undefined, it: 'it' | 'them'): string {
    if (!home) return `Neither project depends on the other: move ${it} to a library both can depend on.`;
    if (home !== pa && home !== pb) return `Keep ${it} in ${displayName(ctx, home)}, which both depend on, and import ${it} in both.`;
    return `Keep ${it} in ${displayName(ctx, home)} and import ${it} in ${displayName(ctx, home === pa ? pb : pa)}.`;
}

/** The dependency two projects share that is closest to them (it depends on the most of the others). */
function sharedDependency(ctx: PlacementContext, a: string, b: string): string | undefined {
    const common = [...ctx.closure(a)].filter(x => ctx.closure(b).has(x));
    return common.sort((x, y) => ctx.closure(y).size - ctx.closure(x).size)[0];
}
