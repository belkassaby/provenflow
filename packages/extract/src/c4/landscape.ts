/**
 * The projects as a C4 model: each project a software system, its modules (or the project itself)
 * its containers, the top folders of their sources their components; dependencies between projects
 * as relationships between containers, imports between folders and towards other projects as
 * relationships between components; the libraries several projects share as external systems.
 * Views: the landscape of all the projects, the context and containers of the code base analysed,
 * and the components of each of its containers.
 */
import type { C4Element, C4Relationship, C4View, C4Workspace } from '@provenflow/language';
import { importProfile, type PlacementContext } from './context.js';
import type { ProjectInfo, ProjectLink } from './discover.js';
import type { SharedLibrary } from './hygiene.js';
import { resolveRelative, type ProjectSources } from './sources.js';

const MAX_COMPONENTS = 25;
const MAX_LIBRARIES = 8;
/** Folders that hold sources rather than name a part of the code. */
const SOURCE_ROOTS = new Set(['src', 'lib', 'app', 'main', 'java', 'kotlin', 'python', 'source', 'sources', 'ts', 'js']);

interface Builder {
    ws: C4Workspace;
    taken: Set<string>;
    /** Project id → module name (or '') → container id. */
    containers: Map<string, Map<string, string>>;
    rels: Map<string, C4Relationship>;
}

function id(b: Builder, base: string): string {
    const clean = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'element';
    let out = /^\d/.test(clean) ? `e${clean}` : clean;
    for (let n = 2; b.taken.has(out); n++) out = `${clean}${n}`;
    b.taken.add(out);
    return out;
}

function relate(b: Builder, source: string, destination: string, description: string, technology?: string, tags: string[] = []): void {
    const key = `${source}>${destination}`;
    const existing = b.rels.get(key);
    if (existing) {
        existing.tags = [...new Set([...existing.tags, ...tags])];
        return;
    }
    b.rels.set(key, { id: id(b, `rel_${source}_${destination}`), source, destination, description, technology, tags });
}

export function buildWorkspace(ctx: PlacementContext, focus: ProjectInfo, libraries: SharedLibrary[]): C4Workspace {
    const b: Builder = { ws: { name: `${focus.name} and related projects`, description: `The projects around ${focus.name}, how they depend on each other, and what each is made of.`, elements: [], relationships: [], environments: [], views: [], styles: DEFAULT_STYLES }, taken: new Set(ctx.projects.map(p => p.id)), containers: new Map(), rels: new Map() };
    for (const p of ctx.projects) addProject(b, p);
    for (const l of ctx.links) if (ctx.byId.has(l.from) && ctx.byId.has(l.to)) linkContainers(b, l);
    for (const [pid, sources] of ctx.sources) if (ctx.byId.get(pid)?.owned) addComponents(b, ctx, sources);
    addLibraries(b, libraries.slice(0, MAX_LIBRARIES));
    b.ws.relationships = [...b.rels.values()];
    b.ws.views = defaultViews(b, focus);
    return b.ws;
}

function addProject(b: Builder, p: ProjectInfo): void {
    b.ws.elements.push(systemOf(p));
    const map = new Map<string, string>();
    // The project's own code is a container, unless it is only the root of the modules its manifest
    // declares (a workspace root); a project with packages added inside it keeps its own code.
    const own = { name: '', dir: '.', kind: p.application ? 'application' : 'library' };
    const modules: Array<{ name: string; dir: string; kind: string }> = p.modules.length && !p.modules.some(m => m.undeclared) ? p.modules : [own, ...p.modules];
    for (const m of modules) {
        const cid = id(b, `${p.id}_${m.name || 'code'}`);
        map.set(m.name, cid);
        b.ws.elements.push({ id: cid, type: 'container', name: m.name || p.name, description: moduleDescription(p, m), technology: p.technology || p.ecosystem, tags: [m.kind === 'application' ? 'Application' : 'Library'], parent: p.id, properties: { path: m.dir } });
    }
    b.containers.set(p.id, map);
}

function systemOf(p: ProjectInfo): C4Element {
    const tags = ['Project', p.focus ? 'Focus' : '', p.owned ? '' : 'Other owner', p.application ? 'Application' : 'Library'].filter(Boolean);
    const description = `${p.description ?? `${p.ecosystem} project`}.${p.version ? ` Version ${p.version}.` : ''}`.replace(/\.\./g, '.');
    const properties: Record<string, string> = { path: p.path, ecosystem: p.ecosystem };
    if (p.version) properties['version'] = p.version;
    if (p.remote) properties['repository'] = p.remote;
    return { id: p.id, type: 'softwareSystem', name: p.name, description, tags, properties };
}

function moduleDescription(p: ProjectInfo, m: { name: string; dir: string; kind: string }): string {
    if (!m.name) return `The ${p.application ? 'application' : 'library'} itself.`;
    const kind = m.kind === 'application' ? 'Application' : m.kind === 'library' ? 'Library' : 'Module';
    return `${kind} in ${m.dir}.`;
}

/** The container of a project a dependency (or an import) lands on: the module named, else its application or first module. */
function containerOf(b: Builder, project: string, module?: string): string | undefined {
    const map = b.containers.get(project);
    if (!map) return undefined;
    return (module !== undefined && map.get(module)) || map.get('') || [...map.values()][0];
}

function linkContainers(b: Builder, l: ProjectLink): void {
    const from = containerOf(b, l.from, l.fromModule);
    const to = containerOf(b, l.to, l.toModule);
    if (!from || !to) return;
    const kind = l.dependency.kind === 'runtime' ? [] : [`${l.dependency.kind.charAt(0).toUpperCase()}${l.dependency.kind.slice(1)} dependency`];
    relate(b, from, to, 'Depends on', [l.dependency.name, l.dependency.range].filter(Boolean).join(' '), [...kind, ...(l.satisfied === false ? ['Outdated'] : [])]);
}

/** The component a file is in: the first folder below the container's folder and its source roots. */
function componentKey(file: string, containerDir: string, packages: string[]): string {
    const rel = containerDir === '.' ? file : file.slice(containerDir.length + 1);
    const parts = rel.split('/');
    parts.pop();
    while (parts.length && (SOURCE_ROOTS.has(parts[0]) || packages.includes(parts[0]))) parts.shift();
    return parts[0] ?? '(root)';
}

function moduleOfFile(p: ProjectInfo, file: string): { name: string; dir: string } {
    const m = [...p.modules].sort((x, y) => y.dir.length - x.dir.length).find(x => file.startsWith(`${x.dir}/`));
    return m ? { name: m.name, dir: m.dir } : { name: '', dir: '.' };
}

function addComponents(b: Builder, ctx: PlacementContext, sources: ProjectSources): void {
    const p = sources.project;
    const packages = p.ecosystem === 'python' ? p.aliases.map(a => a.replace(/-/g, '_')) : [];
    const componentOf = new Map<string, string>();
    const counts = new Map<string, { container: string; name: string; files: number; language: string }>();
    for (const f of sources.files.filter(x => !x.test)) {
        const m = moduleOfFile(p, f.file);
        const container = containerOf(b, p.id, m.name);
        if (!container) continue;
        const key = `${container}/${componentKey(f.file, m.dir, packages)}`;
        const entry = counts.get(key) ?? { container, name: key.slice(container.length + 1), files: 0, language: f.language === 'py' ? 'Python' : 'TypeScript' };
        entry.files++;
        counts.set(key, entry);
        componentOf.set(f.file, key);
    }
    const ids = new Map<string, string>();
    const perContainer = new Map<string, number>();
    for (const [key, c] of [...counts].sort((x, y) => y[1].files - x[1].files)) {
        const n = perContainer.get(c.container) ?? 0;
        if (n >= MAX_COMPONENTS) continue;
        perContainer.set(c.container, n + 1);
        const cid = id(b, `${c.container}_${c.name}`);
        ids.set(key, cid);
        b.ws.elements.push({ id: cid, type: 'component', name: c.name, description: `${c.files} source file${c.files > 1 ? 's' : ''}.`, technology: c.language, tags: [], parent: c.container });
    }
    componentRelationships(b, ctx, sources, componentOf, ids);
}

function componentRelationships(b: Builder, ctx: PlacementContext, sources: ProjectSources, componentOf: Map<string, string>, ids: Map<string, string>): void {
    const files = new Set(sources.files.map(f => f.file));
    const counts = new Map<string, { source: string; destination: string; n: number; names: Set<string> }>();
    const count = (source: string | undefined, destination: string | undefined, names: string[] = []) => {
        if (!source || !destination || source === destination) return;
        const key = `${source}>${destination}`;
        const c = counts.get(key) ?? { source, destination, n: 0, names: new Set<string>() };
        c.n++;
        names.filter(x => x !== '*' && x !== 'default').forEach(x => c.names.add(x));
        counts.set(key, c);
    };
    for (const f of sources.files.filter(x => !x.test)) {
        const from = ids.get(componentOf.get(f.file) ?? '');
        for (const imp of f.imports.filter(i => i.relative)) count(from, ids.get(componentOf.get(resolveRelative(f.file, imp, f.language, files) ?? '') ?? ''));
        for (const [q, names] of importProfile(ctx, sources, f).projects) count(from, containerOf(b, q), [...names]);
    }
    for (const c of counts.values()) relate(b, c.source, c.destination, 'Uses', c.names.size ? [...c.names].slice(0, 4).join(', ') : `${c.n} import${c.n > 1 ? 's' : ''}`, ['Import']);
}

function addLibraries(b: Builder, libraries: SharedLibrary[]): void {
    for (const lib of libraries) {
        const lid = id(b, `lib_${lib.name}`);
        b.ws.elements.push({ id: lid, type: 'softwareSystem', name: lib.name, description: `A library ${lib.users.length} of the projects use.`, tags: ['External', 'Library'] });
        for (const u of lib.users) {
            const from = containerOf(b, u.project);
            if (from) relate(b, from, lid, 'Uses', u.range, ['Library dependency']);
        }
    }
}

function defaultViews(b: Builder, focus: ProjectInfo): C4View[] {
    const views: C4View[] = [
        // The shared libraries are left out of the landscape (every project uses some): the context views show them.
        { type: 'systemLandscape', key: 'projects', description: 'Every project and how they depend on each other.', include: ['*'], exclude: b.ws.elements.filter(e => e.tags.includes('Library') && e.tags.includes('External')).map(e => e.id), autoLayout: { direction: 'tb' } },
        { type: 'systemContext', scope: focus.id, key: 'context', description: `What ${focus.name} depends on, and what depends on it.`, include: ['*'], exclude: [], autoLayout: { direction: 'tb' } },
        { type: 'container', scope: focus.id, key: 'containers', description: `The parts of ${focus.name} and the projects they use.`, include: ['*'], exclude: [], autoLayout: { direction: 'lr' } }
    ];
    for (const cid of b.containers.get(focus.id)?.values() ?? []) {
        const components = b.ws.elements.filter(e => e.parent === cid);
        if (components.length < 2) continue;
        const name = b.ws.elements.find(e => e.id === cid)?.name ?? cid;
        views.push({ type: 'component', scope: cid, key: `components-${name.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`, description: `The folders of ${name} and what they use.`, include: ['*'], exclude: [], autoLayout: { direction: 'lr' } });
    }
    return views;
}

export const DEFAULT_STYLES: C4Workspace['styles'] = {
    elements: [
        { tag: 'Person', shape: 'Person', background: '#33454f', color: '#ffffff', stroke: '#33454f' },
        { tag: 'Software System', background: '#2f6db5', color: '#ffffff', stroke: '#245592' },
        { tag: 'Focus', background: '#17467f', stroke: '#0b2547', strokeWidth: 4 },
        { tag: 'Other owner', background: '#7b8a92', stroke: '#5c6a71' },
        { tag: 'External', background: '#e9edef', color: '#112028', stroke: '#7b8a92' },
        { tag: 'Container', shape: 'RoundedBox', background: '#e1edfa', color: '#112028', stroke: '#2f6db5' },
        { tag: 'Component', shape: 'RoundedBox', background: '#f4f8fd', color: '#112028', stroke: '#7ea3d1' },
        { tag: 'Database', shape: 'Cylinder', background: '#fbefd5', color: '#112028', stroke: '#b57a12' }
    ],
    relationships: [
        { tag: 'Relationship', color: '#2c3e48' },
        { tag: 'Dev dependency', dashed: true, color: '#7b8a92' },
        { tag: 'Optional dependency', dashed: true },
        { tag: 'Peer dependency', dashed: true },
        { tag: 'Library dependency', color: '#8a979e' },
        { tag: 'Outdated', color: '#b5485a', thickness: 3 }
    ]
};

