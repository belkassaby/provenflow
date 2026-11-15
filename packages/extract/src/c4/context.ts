/** What the placement suggestions share: the projects shown, their links and sources, and lookups over them. */
import { normaliseName } from './manifests.js';
import type { ProjectInfo, ProjectLink } from './discover.js';
import { packageOf, type ProjectSources, type SourceFile, type SourceImport } from './sources.js';

export interface PlacementSuggestion {
    kind: 'move-to-dependency' | 'move-to-consumer' | 'duplicate-across-projects' | 'unused-dependency' | 'undeclared-dependency' | 'cyclic-dependency' | 'outdated-dependency' | 'version-drift';
    severity: 'error' | 'warning' | 'info';
    confidence: 'high' | 'medium' | 'low';
    title: string;
    detail: string;
    /** Where the code (or the dependency) is now. */
    project: string;
    /** Where it belongs. */
    target?: string;
    files: Array<{ project: string; file: string; line?: number; lines?: number }>;
    /** The patterns and practices catalogue entry it is about. */
    practice?: string;
}

export interface PlacementContext {
    projects: ProjectInfo[];
    links: ProjectLink[];
    sources: Map<string, ProjectSources>;
    byId: Map<string, ProjectInfo>;
    /** The project that provides an imported package (TypeScript: npm names; Python: import packages). */
    provider(pkg: string, language: 'ts' | 'py'): string | undefined;
    /** The projects a project depends on, directly or not (development dependencies left out). */
    closure(id: string): Set<string>;
}

const BUILTINS = new Set('assert buffer child_process cluster crypto dgram dns events fs http http2 https net os path perf_hooks process querystring readline stream string_decoder timers tls tty url util v8 vm worker_threads zlib'.split(' '));

export function isBuiltin(pkg: string, language: 'ts' | 'py'): boolean {
    return language === 'ts' && (pkg.startsWith('node:') || BUILTINS.has(pkg));
}

export function createContext(projects: ProjectInfo[], links: ProjectLink[], sources: Map<string, ProjectSources>): PlacementContext {
    const byId = new Map(projects.map(p => [p.id, p]));
    // An alias two projects claim (a `utils` or `src` package) says nothing about which one is meant.
    const providers = new Map<string, string | null>();
    for (const p of projects) {
        const language = p.ecosystem === 'python' ? 'py' : p.ecosystem === 'npm' ? 'ts' : undefined;
        if (!language) continue;
        for (const alias of p.aliases) {
            const key = `${language}|${alias}`;
            providers.set(key, providers.has(key) && providers.get(key) !== p.id ? null : p.id);
        }
    }
    const runtime = links.filter(l => l.dependency.kind !== 'dev' && byId.has(l.from) && byId.has(l.to));
    const closures = new Map<string, Set<string>>();
    const closure = (id: string): Set<string> => {
        const cached = closures.get(id);
        if (cached) return cached;
        const seen = new Set<string>();
        const stack = [id];
        while (stack.length) {
            const from = stack.pop();
            for (const next of runtime.filter(l => l.from === from && l.to !== id && !seen.has(l.to)).map(l => l.to)) {
                seen.add(next);
                stack.push(next);
            }
        }
        closures.set(id, seen);
        return seen;
    };
    return {
        projects,
        links,
        sources,
        byId,
        provider: (pkg, language) => providers.get(`${language}|${normaliseName(pkg, language === 'py' ? 'python' : 'npm')}`) ?? undefined,
        closure
    };
}

/** How a file's imports split: its own code, other projects (with the names it takes from each), libraries. */
export interface ImportProfile {
    relative: SourceImport[];
    internal: SourceImport[];
    projects: Map<string, Set<string>>;
    libraries: Set<string>;
}

export function importProfile(ctx: PlacementContext, sources: ProjectSources, f: SourceFile): ImportProfile {
    const profile: ImportProfile = { relative: [], internal: [], projects: new Map(), libraries: new Set() };
    const own = sources.project.id;
    for (const imp of f.imports) {
        if (imp.relative) {
            profile.relative.push(imp);
            continue;
        }
        const pkg = packageOf(imp, f.language);
        const provider = ctx.provider(pkg, f.language);
        if (provider === own || sources.topLevel.has(pkg) || sources.internal.some(prefix => imp.spec === prefix || imp.spec.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) profile.internal.push(imp);
        else if (provider) profile.projects.set(provider, new Set([...(profile.projects.get(provider) ?? []), ...imp.names]));
        else if (!isBuiltin(pkg, f.language)) profile.libraries.add(pkg);
    }
    return profile;
}

/** Whether a project declares a dependency on a library (by its package name, for npm and Python). */
export function declares(p: ProjectInfo, pkg: string): boolean {
    const eco = p.ecosystem === 'python' ? 'python' : 'npm';
    const n = normaliseName(pkg, eco);
    return p.dependencies.some(d => d.kind !== 'dev' && normaliseName(d.name, eco) === n) || p.modules.some(m => m.dependencies.some(d => normaliseName(d.name, eco) === n));
}

/** Entry points and glue: files that belong to the project they are in whatever they import. */
export function isGlue(file: string): boolean {
    const base = file.split('/').pop() ?? file;
    return /^(main|index|public[-_]api|polyfills|setup|conftest|__init__|__main__|cli|server|app\.(config|routes|module|component))\.|\.(module|routes|config)\.ts$/.test(base) || /(^|\/)(environments?|scripts?|e2e|examples?|docs?|playground)\//.test(file);
}

export function displayName(ctx: PlacementContext, id: string | undefined): string {
    return (id && ctx.byId.get(id)?.name) || id || '';
}
