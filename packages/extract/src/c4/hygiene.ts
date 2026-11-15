/**
 * The dependencies between projects, checked against the code and against each other:
 * cycles between projects, a local project newer than the range that depends on it, a project
 * declared but never imported (or imported but not declared), and a library several projects use
 * at versions that do not overlap.
 */
import { minimum, satisfies } from './semver.js';
import { displayName, importProfile, type PlacementContext, type PlacementSuggestion } from './context.js';
import type { ProjectInfo } from './discover.js';
import { normaliseName } from './manifests.js';
import type { ProjectSources } from './sources.js';

export function cycles(ctx: PlacementContext): PlacementSuggestion[] {
    const out: PlacementSuggestion[] = [];
    const done = new Set<string>();
    for (const p of ctx.projects) {
        if (done.has(p.id)) continue;
        const cycle = [...ctx.closure(p.id)].filter(q => ctx.closure(q).has(p.id));
        if (!cycle.length) continue;
        const members = [p.id, ...cycle];
        members.forEach(m => done.add(m));
        out.push({
            kind: 'cyclic-dependency',
            severity: 'error',
            confidence: 'high',
            title: `${members.map(m => displayName(ctx, m)).join(', ')} depend on each other`,
            detail: 'Projects in a cycle can only be released together, and a change to one rebuilds all of them. Move what the lower one takes from the higher one down into it (or into a new shared library), so the dependencies go one way.',
            project: p.id,
            files: [],
            practice: 'cyclic-dependency'
        });
    }
    return out;
}

export function outdated(ctx: PlacementContext): PlacementSuggestion[] {
    return ctx.links
        .filter(l => l.satisfied === false && ctx.byId.has(l.from) && ctx.byId.has(l.to))
        .map(l => ({
            kind: 'outdated-dependency' as const,
            severity: l.dependency.kind === 'dev' ? ('info' as const) : ('warning' as const),
            confidence: 'high' as const,
            title: `${displayName(ctx, l.from)} depends on ${l.dependency.name} ${l.dependency.range}, the local version is ${l.version}`,
            detail: `${displayName(ctx, l.from)} builds against an older ${displayName(ctx, l.to)} than the one being developed, so changes made there do not reach it. Update the range (for example to ^${l.version}), or keep it on purpose and say so.`,
            project: l.from,
            target: l.to,
            files: []
        }));
}

/** Projects declared as dependencies but never imported, and imported but not declared. */
export function declaredVersusUsed(ctx: PlacementContext): PlacementSuggestion[] {
    return [...ctx.sources].flatMap(([id, sources]) => {
        const used = usedProjects(ctx, sources);
        return [...unused(ctx, sources, used), ...undeclared(ctx, id, used)];
    });
}

/** The projects a project's (non-test) code imports, each with the first file that does. */
function usedProjects(ctx: PlacementContext, sources: ProjectSources): Map<string, string> {
    const used = new Map<string, string>();
    for (const f of sources.files.filter(x => !x.test)) for (const q of importProfile(ctx, sources, f).projects.keys()) if (!used.has(q)) used.set(q, f.file);
    return used;
}

function unused(ctx: PlacementContext, sources: ProjectSources, used: Map<string, string>): PlacementSuggestion[] {
    const id = sources.project.id;
    const languageOf = (q: string) => (ctx.byId.get(q)?.ecosystem === 'python' ? 'py' : 'ts');
    // Only when the other project's code could be seen being imported: it has sources, and this one has sources in its language.
    const checkable = (to: string) => !!ctx.sources.get(to) && sources.files.some(f => f.language === languageOf(to));
    return ctx.links
        .filter(l => l.from === id && l.dependency.kind !== 'dev' && !used.has(l.to) && checkable(l.to))
        .map(l => ({ kind: 'unused-dependency' as const, severity: 'info' as const, confidence: 'medium' as const, title: `${displayName(ctx, id)} declares ${l.dependency.name} but never imports it`, detail: `No source file of ${displayName(ctx, id)} imports ${displayName(ctx, l.to)}. Drop the dependency, or make it optional if it is loaded another way (a plugin, a template, a string).`, project: id, target: l.to, files: [] }));
}

function undeclared(ctx: PlacementContext, id: string, used: Map<string, string>): PlacementSuggestion[] {
    const declared = ctx.links.filter(l => l.from === id);
    return [...used]
        .filter(([q]) => !declared.some(l => l.to === q && l.dependency.kind !== 'dev'))
        .map(([q, file]) => {
            const dev = declared.some(l => l.to === q);
            return { kind: 'undeclared-dependency' as const, severity: 'warning' as const, confidence: 'high' as const, title: `${displayName(ctx, id)} imports ${displayName(ctx, q)} without ${dev ? 'a runtime' : 'a'} dependency on it`, detail: `${file} imports ${displayName(ctx, q)}, ${dev ? 'which is only a development dependency' : 'which only arrives through another dependency'}. Declare it, so an update of the other one cannot break ${displayName(ctx, id)}.`, project: id, target: q, files: [{ project: id, file }] };
        });
}

export interface SharedLibrary {
    name: string;
    users: Array<{ project: string; range?: string }>;
}

const NOISE = /^(@types\/|tslib$|typescript$|zone\.js$|python$)/;

/** Libraries (not one of the projects) that two or more owned projects depend on at run time. */
export function sharedLibraries(ctx: PlacementContext): SharedLibrary[] {
    const map = new Map<string, SharedLibrary>();
    for (const p of ctx.projects.filter(x => x.owned)) {
        for (const d of p.dependencies) {
            if (d.kind === 'dev' || NOISE.test(d.name) || isProject(ctx, p, d.name)) continue;
            const key = normaliseName(d.name, p.ecosystem);
            const lib = map.get(key) ?? { name: d.name, users: [] };
            if (!lib.users.some(u => u.project === p.id)) lib.users.push({ project: p.id, range: d.range });
            map.set(key, lib);
        }
    }
    return [...map.values()].filter(l => l.users.length > 1).sort((a, b) => b.users.length - a.users.length || a.name.localeCompare(b.name));
}

function isProject(ctx: PlacementContext, p: ProjectInfo, name: string): boolean {
    return ctx.links.some(l => l.from === p.id && l.dependency.name === name);
}

/** One project depends on the other, or a third one depends on both: they run in the same process or bundle. */
function loadedTogether(ctx: PlacementContext, a: string, b: string): boolean {
    if (ctx.closure(a).has(b) || ctx.closure(b).has(a)) return true;
    return ctx.projects.some(p => {
        const deps = ctx.closure(p.id);
        return (deps.has(a) || p.id === a) && (deps.has(b) || p.id === b);
    });
}

/** A library that projects loaded together use at ranges with no version in common. */
export function versionDrift(ctx: PlacementContext, libraries: SharedLibrary[]): PlacementSuggestion[] {
    const out: PlacementSuggestion[] = [];
    for (const lib of libraries) {
        const ranged = lib.users.filter(u => minimum(u.range));
        // Two ranges overlap when the lowest version of one is in the other.
        const disjoint = (a: { range?: string }, b: { range?: string }) => satisfies(minimum(a.range), b.range) === false && satisfies(minimum(b.range), a.range) === false;
        const clash = ranged.some(a => ranged.some(b => disjoint(a, b) && loadedTogether(ctx, a.project, b.project)));
        if (!clash) continue;
        out.push({
            kind: 'version-drift',
            severity: 'info',
            confidence: 'high',
            title: `${lib.name} is used at different versions`,
            detail: `${ranged.map(u => `${displayName(ctx, u.project)} ${u.range}`).join(', ')}. The ranges have no version in common: projects loaded together (an application and its libraries) then bundle two copies, or one runs against a version it was not tested with. Align the ranges.`,
            project: ranged[0].project,
            files: []
        });
    }
    return out;
}
