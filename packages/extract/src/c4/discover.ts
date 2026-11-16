/**
 * Finds the projects around a code base and how they depend on each other: the folders next to it
 * (and one level below) with a manifest, who owns each (git remote organisation, npm scope, author),
 * and, for every dependency one project declares on another, whether the other's local version
 * satisfies the range.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDirectory, MANIFEST_FILES, normaliseName, readManifest, relativePath, type Ecosystem, type Manifest, type ManifestDependency, type ProjectModule } from './manifests.js';
import { satisfies } from './semver.js';

export interface ProjectInfo extends Manifest {
    /** A C4 identifier. */
    id: string;
    /** Absolute path. */
    dir: string;
    /** Relative to the folder scanned. */
    path: string;
    /** `github.com/org` from the git remote (or the manifest's repository). */
    remote?: string;
    /** Same owner as the code base analysed. */
    owned: boolean;
    focus: boolean;
}

export interface ProjectLink {
    from: string;
    to: string;
    /** The module of `from` that declares it (when the project has modules), and the module of `to` it names. */
    fromModule?: string;
    toModule?: string;
    dependency: ManifestDependency;
    /** The local version of `to`. */
    version?: string;
    /** Whether that version is in the range (undefined: a path, a link, or no version). */
    satisfied?: boolean;
}

export interface DiscoverOptions {
    /** Folders whose sub-folders are projects (default: the folder around the code base). */
    scan?: string[];
    /** More owners: git organisations (`github.com/org` or `org`), npm scopes (`@scope`), authors. */
    owners?: string[];
    /** How deep below a scanned folder to look for projects (default 2). */
    depth?: number;
    /** At most this many projects (default 300). */
    limit?: number;
}

const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'target', 'vendor', 'coverage', '__pycache__', 'venv', '.venv', 'site-packages', 'cache', 'tmp']);
/** Which ecosystems can depend on which (Gradle and Maven share coordinates). */
const COMPATIBLE: Record<Ecosystem, Ecosystem[]> = { npm: ['npm'], python: ['python'], maven: ['maven', 'gradle'], gradle: ['maven', 'gradle'], go: ['go'], cargo: ['cargo'] };

function hasManifest(dir: string): boolean {
    return MANIFEST_FILES.some(f => existsSync(join(dir, f)));
}

/** The project folders under `root`, not descending into a project (its modules come from its manifest), nor into folders `skip` names. */
export function projectFolders(root: string, depth: number, limit: number, skip: (dir: string) => boolean = () => false): string[] {
    let entries: string[] = [];
    try {
        entries = readdirSync(root, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && !SKIP.has(e.name))
            .map(e => join(root, e.name))
            .filter(dir => !skip(dir))
            .sort();
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const dir of entries) {
        if (found.length >= limit) break;
        const here = hasManifest(dir) ? [dir] : depth > 1 ? projectFolders(dir, depth - 1, limit - found.length, skip) : [];
        found.push(...here);
    }
    return found.slice(0, limit);
}

/** Folders inside a project that hold examples or test data, not parts of it. */
const NOT_PARTS = new Set(['test', 'tests', '__tests__', 'spec', 'fixtures', 'testdata', 'examples', 'example', 'samples', 'docs', 'e2e']);

/**
 * The projects inside a project that its manifest does not list as modules (a package added to a
 * repository without a workspace entry): they are parts of it too, as its declared modules are.
 */
export function undeclaredModules(dir: string, declared: ProjectModule[]): ProjectModule[] {
    const known = declared.map(m => resolve(dir, m.dir));
    const skip = (d: string) => NOT_PARTS.has(basename(d)) || known.some(k => d === k || d.startsWith(`${k}/`));
    return projectFolders(dir, 3, 50, skip).flatMap(d => {
        const m = readManifest(d);
        return m ? [{ name: m.name, dir: relativePath(dir, d), kind: m.application ? ('application' as const) : ('library' as const), aliases: m.aliases, dependencies: m.dependencies, undeclared: true }] : [];
    });
}

/** A manifest with the projects inside its folder that it does not declare added to its modules. */
function withUndeclared(dir: string, manifest: Manifest): Manifest {
    const extra = undeclaredModules(dir, manifest.modules);
    return extra.length ? { ...manifest, modules: [...manifest.modules, ...extra], aliases: [...manifest.aliases, ...extra.flatMap(m => m.aliases)] } : manifest;
}

/** `git@github.com:Org/repo.git`, `https://github.com/Org/repo` → `github.com/org`. */
export function remoteOwner(url: string | undefined): string | undefined {
    if (!url) return undefined;
    // npm's shorthands: `github:owner/repo`, `gitlab:owner/repo`, `owner/repo`.
    const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/[\w.-]+$/.exec(url.trim());
    if (short) return `${short[1] === 'bitbucket' ? 'bitbucket.org' : `${short[1] ?? 'github'}.com`}/${short[2]}`.toLowerCase();
    const m = /^(?:git\+)?(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]([^/]+)\//i.exec(url.trim());
    return m ? `${m[1].replace(/^www\./, '')}/${m[2]}`.toLowerCase() : undefined;
}

/** The URL of the git remote `origin` of the repository a folder is in. */
export function gitRemote(dir: string): string | undefined {
    for (let d = dir, n = 0; n < 6; d = dirname(d), n++) {
        const git = join(d, '.git');
        if (!existsSync(git)) continue;
        let config = join(git, 'config');
        if (!isDirectory(git)) {
            const pointer = /gitdir:\s*(.+)/.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
            config = pointer ? join(resolve(d, pointer), '..', '..', 'config') : config;
        }
        try {
            const text = readFileSync(config, 'utf8');
            return /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(text)?.[1];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/** What identifies an owner: `remote:github.com/org`, `scope:@org`, `author:name`. */
function ownerKeys(p: { name: string; remote?: string; author?: string; ecosystem: Ecosystem }): string[] {
    const keys: string[] = [];
    if (p.remote) keys.push(`remote:${p.remote}`);
    if (p.ecosystem === 'npm' && p.name.startsWith('@')) keys.push(`scope:${p.name.split('/')[0].toLowerCase()}`);
    if (p.author) keys.push(`author:${p.author.trim().toLowerCase()}`);
    return keys;
}

function extraOwnerKeys(owners: string[]): string[] {
    return owners.flatMap(o => {
        const v = o.trim().toLowerCase();
        if (v.startsWith('@')) return [`scope:${v}`];
        if (v.includes('/')) return [`remote:${v.replace(/^https?:\/\//, '')}`];
        return [`remote:github.com/${v}`, `author:${v}`, `scope:@${v}`];
    });
}

function identifier(name: string, taken: Set<string>): string {
    const words = name.replace(/^@[^/]+\//, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/);
    const base = words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('') || 'project';
    let id = /^\d/.test(base) ? `p${base}` : base;
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
    taken.add(id);
    return id;
}

export function discoverProjects(focusDir: string, options: DiscoverOptions = {}): ProjectInfo[] {
    const focus = resolve(focusDir);
    const roots = (options.scan?.length ? options.scan : [dirname(focus)]).map(r => resolve(r));
    const limit = options.limit ?? 300;
    // A git worktree is another checkout of a project already there: only the one mapped is kept.
    const focusCheckout = worktreeOf(focus);
    const dirs = [...new Set([focus, ...roots.flatMap(r => projectFolders(r, options.depth ?? 2, limit))])].filter(d => d === focus || (!d.startsWith(`${focus}/`) && d !== focusCheckout && !worktreeOf(d)));
    const taken = new Set<string>();
    const projects: ProjectInfo[] = [];
    for (const dir of dirs) {
        const read = readManifest(dir) ?? (dir === focus ? emptyManifest(dir) : undefined);
        if (!read) continue;
        const manifest = withUndeclared(dir, read);
        // The manifest says whose project it is; a git remote found further up may be another repository's.
        const remote = remoteOwner(manifest.repository) ?? remoteOwner(gitRemote(dir));
        projects.push({ ...manifest, id: identifier(manifest.name, taken), dir, path: relativePath(roots[0], dir), remote, owned: false, focus: dir === focus });
    }
    markOwned(projects, extraOwnerKeys(options.owners ?? []));
    return projects;
}

/** The main checkout of a git worktree (its `.git` is a file pointing into `<main>/.git/worktrees/`), else nothing. */
export function worktreeOf(dir: string): string | undefined {
    const git = join(dir, '.git');
    if (!existsSync(git) || isDirectory(git)) return undefined;
    try {
        const target = /gitdir:\s*(.+)/.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
        return target ? /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(resolve(dir, target))?.[1] : undefined;
    } catch {
        return undefined;
    }
}

function emptyManifest(dir: string): Manifest {
    return { ecosystem: 'npm', name: basename(dir), aliases: [], dependencies: [], modules: [], application: true, technology: '' };
}

/**
 * The projects with the code base's owner (or one given), and the other local projects linked to
 * one of those: what the map shows. Ownership spreads through the git organisation, the npm scope
 * and the author, so a scoped package of the same organisation counts even in another repository.
 * A project with no owner at all (no git remote, scope or author) is local, unpublished work: the
 * user's own, like the code base next to it.
 */
function markOwned(projects: ProjectInfo[], extra: string[]): void {
    const focus = projects.find(p => p.focus);
    const keys = new Set([...(focus ? ownerKeys(focus) : []), ...extra]);
    for (let grew = true; grew; ) {
        grew = false;
        for (const p of projects) {
            if (p.owned) continue;
            const own = ownerKeys(p);
            if (p.focus || own.length === 0 || own.some(k => keys.has(k))) {
                p.owned = true;
                // An organisation's projects bring their npm scope (and the other way round), not their authors.
                own.filter(k => !k.startsWith('author:')).forEach(k => keys.add(k));
                grew = true;
            }
        }
    }
}

/** The dependencies between the projects, each matched to the project (and module) that provides it. */
export function linkProjects(projects: ProjectInfo[]): ProjectLink[] {
    const provider = new Map<string, { project: ProjectInfo; module?: string }>();
    for (const p of projects) {
        for (const alias of p.aliases) provider.set(`${p.ecosystem}|${alias}`, { project: p, module: p.modules.find(m => m.aliases.includes(alias))?.name });
    }
    const links: ProjectLink[] = [];
    const add = (p: ProjectInfo, dep: ManifestDependency, fromModule?: string) => {
        for (const eco of COMPATIBLE[p.ecosystem]) {
            const hit = provider.get(`${eco}|${normaliseName(dep.name, eco)}`);
            if (!hit || hit.project === p) continue;
            const version = hit.project.version;
            links.push({ from: p.id, to: hit.project.id, fromModule, toModule: hit.module, dependency: dep, version, satisfied: satisfies(version, dep.range) });
            return;
        }
    };
    for (const p of projects) {
        p.dependencies.forEach(d => add(p, d));
        for (const m of p.modules) m.dependencies.forEach(d => add(p, d, m.name));
    }
    return links;
}

/** The projects shown: the owned ones, and others linked to them. */
export function shownProjects(projects: ProjectInfo[], links: ProjectLink[]): ProjectInfo[] {
    const owned = new Set(projects.filter(p => p.owned).map(p => p.id));
    const linked = new Set(links.filter(l => owned.has(l.from) || owned.has(l.to)).flatMap(l => [l.from, l.to]));
    return projects.filter(p => owned.has(p.id) || linked.has(p.id));
}
