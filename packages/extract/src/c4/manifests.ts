/**
 * What a project's manifest says about it: its published name (and the other names code depends on
 * it by), version, description, author and repository, its dependencies, and the modules it is
 * made of (npm/Nx/Angular workspaces, Maven modules, Cargo workspaces). npm (package.json), Python
 * (pyproject.toml, setup.cfg/setup.py, requirements.txt), Maven (pom.xml), Gradle, Go (go.mod) and
 * Rust (Cargo.toml). Read with regular expressions: enough for names and dependencies, not a full
 * TOML or XML reader.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export type Ecosystem = 'npm' | 'python' | 'maven' | 'gradle' | 'go' | 'cargo';

export interface ManifestDependency {
    name: string;
    range?: string;
    kind: 'runtime' | 'dev' | 'peer' | 'optional';
}

export interface ProjectModule {
    name: string;
    /** Relative to the project. */
    dir: string;
    kind: 'application' | 'library' | 'module';
    aliases: string[];
    dependencies: ManifestDependency[];
}

export interface Manifest {
    ecosystem: Ecosystem;
    name: string;
    /** Every name other code may depend on this project by (normalised, see normaliseName). */
    aliases: string[];
    version?: string;
    description?: string;
    author?: string;
    repository?: string;
    dependencies: ManifestDependency[];
    modules: ProjectModule[];
    /** An application rather than a library (private, with apps, or with no entry point). */
    application: boolean;
    /** The languages and frameworks, for the diagram ("TypeScript, Angular"). */
    technology: string;
}

/** The files that make a folder a project, in the order they are tried. */
export const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'setup.cfg', 'setup.py', 'pom.xml', 'build.gradle.kts', 'build.gradle', 'go.mod', 'Cargo.toml'];

/** How a dependency name compares across manifests: lower case, `_` and `.` as `-` for Python. */
export function normaliseName(name: string, ecosystem: Ecosystem): string {
    const n = name.trim().toLowerCase();
    return ecosystem === 'python' ? n.replace(/[_.]+/g, '-') : n;
}

function read(file: string): string | undefined {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

export function readManifest(dir: string): Manifest | undefined {
    if (existsSync(join(dir, 'package.json'))) return npmManifest(dir);
    if (['pyproject.toml', 'setup.cfg', 'setup.py'].some(f => existsSync(join(dir, f)))) return pythonManifest(dir);
    if (existsSync(join(dir, 'pom.xml'))) return mavenManifest(dir, read(join(dir, 'pom.xml')) ?? '');
    if (existsSync(join(dir, 'build.gradle.kts')) || existsSync(join(dir, 'build.gradle'))) return gradleManifest(dir);
    if (existsSync(join(dir, 'go.mod'))) return goManifest(read(join(dir, 'go.mod')) ?? '');
    if (existsSync(join(dir, 'Cargo.toml'))) return cargoManifest(dir, read(join(dir, 'Cargo.toml')) ?? '');
    return undefined;
}

// ---------------------------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------------------------

type PackageJson = Record<string, unknown>;

function parseJson(text: string | undefined): PackageJson | undefined {
    try {
        return text ? (JSON.parse(text) as PackageJson) : undefined;
    } catch {
        return undefined;
    }
}

const NPM_KINDS: Array<[string, ManifestDependency['kind']]> = [
    ['dependencies', 'runtime'],
    ['peerDependencies', 'peer'],
    ['optionalDependencies', 'optional'],
    ['devDependencies', 'dev']
];

function npmDependencies(pkg: PackageJson): ManifestDependency[] {
    const out: ManifestDependency[] = [];
    for (const [field, kind] of NPM_KINDS) {
        const deps = pkg[field];
        if (deps && typeof deps === 'object') for (const [name, range] of Object.entries(deps as Record<string, string>)) if (!out.some(d => d.name === name)) out.push({ name, range: String(range), kind });
    }
    return out;
}

function personName(value: unknown): string | undefined {
    if (typeof value === 'string') return value.replace(/\s*[<(].*$/, '').trim() || undefined;
    if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') return (value as { name: string }).name;
    return undefined;
}

function urlOf(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') return (value as { url: string }).url;
    return undefined;
}

function npmManifest(dir: string): Manifest | undefined {
    const pkg = parseJson(read(join(dir, 'package.json')));
    if (!pkg) return undefined;
    const name = stringField(pkg, 'name') ?? basename(dir);
    const dependencies = npmDependencies(pkg);
    const modules = [...npmWorkspaces(dir, pkg), ...nxProjects(dir), ...angularProjects(dir)].filter((m, i, all) => all.findIndex(x => x.dir === m.dir) === i);
    const entry = ['main', 'module', 'exports', 'types'].some(k => k in pkg) || existsSync(join(dir, 'ng-package.json'));
    return {
        ecosystem: 'npm',
        name,
        aliases: [normaliseName(name, 'npm'), ...modules.flatMap(m => m.aliases)],
        version: stringField(pkg, 'version'),
        description: stringField(pkg, 'description'),
        author: personName(pkg['author']),
        repository: urlOf(pkg['repository']),
        dependencies,
        modules,
        application: !entry && (pkg['private'] === true || modules.some(m => m.kind === 'application')),
        technology: npmTechnology(dependencies)
    };
}

function stringField(pkg: PackageJson, key: string): string | undefined {
    return typeof pkg[key] === 'string' ? (pkg[key] as string) : undefined;
}

const FRAMEWORKS: Array<[string, string]> = [
    ['@angular/core', 'Angular'],
    ['react', 'React'],
    ['vue', 'Vue'],
    ['express', 'Node.js']
];

function npmTechnology(dependencies: ManifestDependency[]): string {
    const framework = FRAMEWORKS.find(([dep]) => dependencies.some(d => d.name === dep));
    return framework ? `TypeScript, ${framework[1]}` : 'TypeScript';
}

/** The folders a `dir/*` pattern names (one level of `*`). */
function expandPattern(dir: string, pattern: string): string[] {
    const clean = pattern.replace(/\/\*\*$/, '/*').replace(/\/$/, '');
    if (!clean.endsWith('/*')) return existsSync(join(dir, clean)) ? [clean] : [];
    const parent = clean.slice(0, -2);
    try {
        return readdirSync(join(dir, parent), { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
            .map(e => (parent ? `${parent}/${e.name}` : e.name));
    } catch {
        return [];
    }
}

function npmWorkspaces(dir: string, pkg: PackageJson): ProjectModule[] {
    const ws = pkg['workspaces'];
    const patterns = Array.isArray(ws) ? ws : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: string[] }).packages : [];
    const out: ProjectModule[] = [];
    for (const sub of patterns.flatMap(p => expandPattern(dir, String(p)))) {
        const child = parseJson(read(join(dir, sub, 'package.json')));
        if (!child) continue;
        const name = typeof child['name'] === 'string' ? child['name'] : basename(sub);
        const entry = ['main', 'module', 'exports', 'bin'].some(k => k in child);
        out.push({ name, dir: sub, kind: entry ? 'library' : 'application', aliases: [normaliseName(name, 'npm')], dependencies: npmDependencies(child) });
    }
    return out;
}

/** Nx projects (apps/, libs/, packages/, projects/ with a `project.json`). */
function nxProjects(dir: string): ProjectModule[] {
    return ['apps/*', 'libs/*', 'packages/*', 'projects/*'].flatMap(p => expandPattern(dir, p)).flatMap(sub => {
        const project = parseJson(read(join(dir, sub, 'project.json')));
        if (!project) return [];
        return [{ name: stringField(project, 'name') ?? basename(sub), dir: sub, kind: project['projectType'] === 'application' ? 'application' : 'library', aliases: [], dependencies: [] } satisfies ProjectModule];
    });
}

/** The `projects` of an Angular CLI workspace (angular.json). */
function angularProjects(dir: string): ProjectModule[] {
    const projects = parseJson(read(join(dir, 'angular.json')))?.['projects'];
    if (!projects || typeof projects !== 'object') return [];
    return Object.entries(projects as Record<string, { root?: string; projectType?: string }>)
        .filter(([, p]) => !!p.root)
        .map(([name, p]) => ({ name, dir: p.root!, kind: p.projectType === 'application' ? 'application' : 'library', aliases: [], dependencies: [] }));
}

// ---------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------

/** The value of `key = "..."` in a TOML section (the first one). */
function tomlValue(section: string, key: string): string | undefined {
    return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm').exec(section)?.[1];
}

/** The body of a `[name]` section, up to the next section header. */
function tomlSection(text: string, name: string): string {
    const start = text.search(new RegExp(`^\\[${name.replace(/[.[\]]/g, '\\$&')}\\]\\s*$`, 'm'));
    if (start < 0) return '';
    const body = text.slice(text.indexOf('\n', start) + 1);
    const end = body.search(/^\[/m);
    return end < 0 ? body : body.slice(0, end);
}

/** The strings of a TOML array `key = [ "...", ... ]` (over several lines). */
function tomlArray(section: string, key: string): string[] {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(section);
    return m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1]) : [];
}

/** `requests>=2.0; python_version<"3.9"` → requests, >=2.0. */
export function pep508(spec: string, kind: ManifestDependency['kind']): ManifestDependency | undefined {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)/.exec(spec);
    return m ? { name: m[1], range: m[2].trim() || undefined, kind } : undefined;
}

function pythonManifest(dir: string): Manifest {
    const toml = read(join(dir, 'pyproject.toml')) ?? '';
    const project = tomlSection(toml, 'project');
    const poetry = tomlSection(toml, 'tool.poetry');
    const setup = (read(join(dir, 'setup.cfg')) ?? '') + (read(join(dir, 'setup.py')) ?? '');
    const name = tomlValue(project, 'name') ?? tomlValue(poetry, 'name') ?? /name\s*[=:]\s*["']?([A-Za-z0-9._-]+)/.exec(setup)?.[1] ?? basename(dir);
    const dependencies = [
        ...tomlArray(project, 'dependencies').map(d => pep508(d, 'runtime')),
        ...[...tomlSection(toml, 'tool.poetry.dependencies').matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*(?:["']([^"']*)["']|\{[^}]*version\s*=\s*["']([^"']*)["'])?/gm)].filter(m => m[1] !== 'python').map(m => ({ name: m[1], range: m[2] ?? m[3], kind: 'runtime' as const })),
        ...(read(join(dir, 'requirements.txt')) ?? '').split('\n').filter(l => /^[A-Za-z0-9]/.test(l)).map(l => pep508(l, 'runtime'))
    ].filter((d): d is ManifestDependency => !!d);
    const packages = pythonPackages(dir);
    return {
        ecosystem: 'python',
        name,
        aliases: [...new Set([normaliseName(name, 'python'), ...packages.map(p => normaliseName(p, 'python'))])],
        version: tomlValue(project, 'version') ?? tomlValue(poetry, 'version'),
        description: tomlValue(project, 'description') ?? tomlValue(poetry, 'description'),
        author: /name\s*=\s*["']([^"']+)["']/.exec(tomlArray(project, 'authors').join(' ') || /authors\s*=\s*\[\s*\{([^}]*)\}/.exec(project)?.[1] || '')?.[1] ?? tomlArray(poetry, 'authors')[0]?.replace(/\s*<.*$/, ''),
        repository: tomlValue(tomlSection(toml, 'project.urls'), '(?:Repository|repository|Source|source|Homepage|homepage)') ?? tomlValue(poetry, 'repository'),
        dependencies: dependencies.filter((d, i) => dependencies.findIndex(x => normaliseName(x.name, 'python') === normaliseName(d.name, 'python')) === i),
        modules: [],
        application: false,
        technology: 'Python'
    };
}

/** The import packages a Python project provides: folders with an __init__.py at the root or in src/. */
export function pythonPackages(dir: string): string[] {
    const out: string[] = [];
    for (const base of ['', 'src']) {
        try {
            for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
                if (e.isDirectory() && !e.name.startsWith('.') && !/^(tests?|docs?|examples?)$/.test(e.name) && existsSync(join(dir, base, e.name, '__init__.py'))) out.push(e.name);
            }
        } catch {
            // No such folder.
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Maven, Gradle, Go, Cargo
// ---------------------------------------------------------------------------------------------

function xmlTag(text: string, tag: string): string | undefined {
    return new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(text)?.[1];
}

/** The pom without the blocks whose groupId/artifactId are not the project's own. */
function ownPart(pom: string): string {
    return pom.replace(/<(parent|dependencies|dependencyManagement|build|profiles|plugins|reporting|developers|organization)>[\s\S]*?<\/\1>/g, '');
}

function mavenDependencies(pom: string): ManifestDependency[] {
    const deps = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, ''))?.[1] ?? '';
    return [...deps.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map(m => ({
        name: `${xmlTag(m[1], 'groupId') ?? ''}:${xmlTag(m[1], 'artifactId') ?? ''}`,
        range: xmlTag(m[1], 'version'),
        kind: /<scope>\s*test\s*<\/scope>/.test(m[1]) ? 'dev' : /<optional>\s*true/.test(m[1]) ? 'optional' : 'runtime'
    }));
}

function mavenCoordinates(pom: string): { group: string; artifact: string } {
    const own = ownPart(pom);
    const parent = /<parent>([\s\S]*?)<\/parent>/.exec(pom)?.[1] ?? '';
    return { group: xmlTag(own, 'groupId') ?? xmlTag(parent, 'groupId') ?? '', artifact: xmlTag(own, 'artifactId') ?? '' };
}

function mavenManifest(dir: string, pom: string): Manifest {
    const { group, artifact } = mavenCoordinates(pom);
    const own = ownPart(pom);
    const modules = [...pom.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map(m => m[1]).flatMap(sub => {
        const child = read(join(dir, sub, 'pom.xml'));
        if (!child) return [];
        const c = mavenCoordinates(child);
        const packaging = xmlTag(ownPart(child), 'packaging');
        const runnable = /spring-boot-maven-plugin|maven-shade-plugin|<mainClass>/.test(child);
        return [{ name: c.artifact || sub, dir: sub, kind: runnable ? 'application' : packaging === 'pom' ? 'module' : 'library', aliases: [`${c.group || group}:${c.artifact}`.toLowerCase()], dependencies: mavenDependencies(child) } satisfies ProjectModule];
    });
    return {
        ecosystem: 'maven',
        name: artifact || basename(dir),
        aliases: [`${group}:${artifact}`.toLowerCase(), ...modules.flatMap(m => m.aliases)],
        version: xmlTag(own, 'version') ?? xmlTag(/<parent>([\s\S]*?)<\/parent>/.exec(pom)?.[1] ?? '', 'version'),
        description: xmlTag(own, 'description') ?? xmlTag(own, 'name'),
        repository: xmlTag(/<scm>([\s\S]*?)<\/scm>/.exec(pom)?.[1] ?? '', 'url'),
        dependencies: mavenDependencies(pom),
        modules,
        application: modules.some(m => m.kind === 'application') || /spring-boot-maven-plugin/.test(pom),
        technology: /spring-boot/.test(pom) ? 'Java, Spring Boot' : 'Java'
    };
}

function gradleManifest(dir: string): Manifest {
    const build = read(join(dir, 'build.gradle.kts')) ?? read(join(dir, 'build.gradle')) ?? '';
    const settings = read(join(dir, 'settings.gradle.kts')) ?? read(join(dir, 'settings.gradle')) ?? '';
    const name = /rootProject\.name\s*=\s*["']([^"']+)/.exec(settings)?.[1] ?? basename(dir);
    const group = /^\s*group\s*=?\s*["']([^"']+)/m.exec(build)?.[1] ?? '';
    const dependencies = [...build.matchAll(/^\s*(\w+)\s*\(?\s*["']([\w.-]+):([\w.-]+):?([^"']*)["']/gm)].map(m => ({ name: `${m[2]}:${m[3]}`, range: m[4] || undefined, kind: /test/i.test(m[1]) ? ('dev' as const) : ('runtime' as const) }));
    return { ecosystem: 'gradle', name, aliases: [`${group}:${name}`.toLowerCase()], version: /^\s*version\s*=?\s*["']([^"']+)/m.exec(build)?.[1], dependencies, modules: [], application: /application\s*\{|id\s*\(?\s*["']application/.test(build), technology: build.includes('kotlin') ? 'Kotlin' : 'Java' };
}

function goManifest(mod: string): Manifest {
    const name = /^module\s+(\S+)/m.exec(mod)?.[1] ?? '';
    const block = /require\s*\(([\s\S]*?)\)/.exec(mod)?.[1] ?? '';
    const lines = [...block.split('\n'), ...[...mod.matchAll(/^require\s+([^(\s].*)$/gm)].map(m => m[1])];
    const dependencies = lines.map(l => /^\s*(\S+)\s+(\S+)/.exec(l)).filter((m): m is RegExpExecArray => !!m && !m[1].startsWith('//')).map(m => ({ name: m[1], range: m[2], kind: 'runtime' as const }));
    return { ecosystem: 'go', name, aliases: [name.toLowerCase()], dependencies, modules: [], application: false, technology: 'Go' };
}

function cargoManifest(dir: string, toml: string): Manifest {
    const pkg = tomlSection(toml, 'package');
    const name = tomlValue(pkg, 'name') ?? basename(dir);
    const deps = (section: string, kind: ManifestDependency['kind']) => [...tomlSection(toml, section).matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:["']([^"']*)["']|\{[^}]*?version\s*=\s*["']([^"']*)["'])?/gm)].map(m => ({ name: m[1], range: m[2] ?? m[3], kind }));
    const members = tomlArray(tomlSection(toml, 'workspace'), 'members').flatMap(p => expandPattern(dir, p));
    const modules = members.map(sub => ({ name: tomlValue(tomlSection(read(join(dir, sub, 'Cargo.toml')) ?? '', 'package'), 'name') ?? basename(sub), dir: sub, kind: 'library' as const, aliases: [], dependencies: [] }));
    return { ecosystem: 'cargo', name, aliases: [name.toLowerCase(), ...modules.map(m => m.name.toLowerCase())], version: tomlValue(pkg, 'version'), description: tomlValue(pkg, 'description'), repository: tomlValue(pkg, 'repository'), dependencies: [...deps('dependencies', 'runtime'), ...deps('dev-dependencies', 'dev')], modules, application: existsSync(join(dir, 'src', 'main.rs')), technology: 'Rust' };
}

/** Whether a path is a folder (and not a symbolic link loop). */
export function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

export function relativePath(from: string, to: string): string {
    return relative(from, to).split('\\').join('/') || '.';
}
