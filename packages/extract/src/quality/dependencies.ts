/**
 * Dependencies that exist: every package a file imports must be declared in the project's manifest
 * and installed. An import of a package that is neither may be a hallucinated name (LLMs invent
 * package names, and attackers register them: "slopsquatting"); one that is installed but not
 * declared only works by accident (a transitive or hoisted dependency).
 *
 * TypeScript/JavaScript: package.json (dependencies of every kind, workspace packages, tsconfig path
 * aliases, Node built-ins). Python: requirements*.txt, pyproject.toml, setup.cfg/setup.py, Pipfile,
 * the standard library and what is installed. Go: go.mod.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import type { Facts, ImportFact } from '../ir.js';
import type { Finding } from '../models.js';

interface Problem {
    file: string;
    imp: ImportFact;
    pkg: string;
    kind: 'unknown' | 'undeclared';
    manifest: string;
    certain: boolean;
}

export function dependencyFindings(facts: Facts, skip: (file: string) => boolean): Finding[] {
    const problems = [...javascriptProblems(facts, skip), ...pythonProblems(facts, skip), ...goProblems(facts, skip)];
    const seen = new Set<string>();
    const findings: Finding[] = [];
    for (const p of problems) {
        const key = `${p.file}|${p.pkg}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (p.kind === 'unknown') {
            findings.push({
                rule: 'unknown-dependency',
                category: 'dependencies',
                severity: p.certain ? 'error' : 'warning',
                subject: p.pkg,
                message: `${p.file} imports ${p.pkg}, which is not declared in ${p.manifest} and not installed: the import fails, and the name may have been invented (LLMs suggest packages that do not exist, and such names get registered by attackers).`,
                fix: `Check that ${p.pkg} is the package you mean and exists in its registry before installing it; then declare it in ${p.manifest} and commit the lockfile. Otherwise use the module the project already has for this.`,
                loc: p.imp.loc,
                source: 'analysis'
            });
        } else {
            findings.push({
                rule: 'undeclared-dependency',
                category: 'dependencies',
                severity: 'warning',
                subject: p.pkg,
                message: `${p.file} imports ${p.pkg}, which is installed but not declared in ${p.manifest}: it only works because another dependency brings it in.`,
                fix: `Declare ${p.pkg} in ${p.manifest} (with the version you use).`,
                loc: p.imp.loc,
                source: 'analysis'
            });
        }
    }
    return findings;
}

// ------------------------------------------------------------------ JavaScript / TypeScript

const BUILTINS = new Set(builtinModules.flatMap(m => [m, m.split('/')[0]]));

function packageName(spec: string): string {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function readJson<T>(path: string): T | undefined {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

interface PackageJson {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

/** The folders from a file's folder up to the project root. */
function dirsOf(file: string): string[] {
    const out: string[] = [];
    for (let dir = dirname(file); ; dir = dirname(dir)) {
        out.push(dir);
        if (dir === '.' || dir === '' || dir === '/') return out;
    }
}

const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** What the JavaScript/TypeScript side of a project declares: manifests, its own packages, path aliases, ambient modules. */
class JavascriptProject {
    private readonly manifests = new Map<string, PackageJson | undefined>();
    readonly local = new Set<string>();
    readonly aliases: string[] = [];
    readonly ambient = new Set<string>();

    constructor(private readonly root: string, files: string[]) {
        const dirs = new Set(files.flatMap(dirsOf));
        for (const d of dirs) {
            const name = this.manifest(d)?.name;
            if (name) this.local.add(name);
            this.aliases.push(...pathAliases(root, d));
        }
        for (const f of files.filter(f => f.endsWith('.d.ts'))) for (const m of (readText(join(root, f)) ?? '').matchAll(/declare\s+module\s+['"]([^'"]+)['"]/g)) this.ambient.add(m[1]);
    }

    manifest(dir: string): PackageJson | undefined {
        if (!this.manifests.has(dir)) this.manifests.set(dir, readJson<PackageJson>(join(this.root, dir, 'package.json')));
        return this.manifests.get(dir);
    }

    /** Whether an import needs a declared package: not relative, built in, aliased, ambient or the project's own. */
    external(spec: string): string | undefined {
        if (/^[./~#]/.test(spec) || spec.startsWith('@/') || spec.includes(':') || spec.includes('$') || BUILTINS.has(spec)) return undefined;
        if (this.aliases.some(a => a && spec.startsWith(a)) || this.ambient.has(spec)) return undefined;
        const pkg = packageName(spec);
        return this.local.has(pkg) || BUILTINS.has(pkg) ? undefined : pkg;
    }

    declares(dir: string, pkg: string): boolean {
        const json = this.manifest(dir);
        const types = `@types/${pkg.replace(/^@/, '').replace('/', '__')}`;
        return !!json && DEPENDENCY_KINDS.some(kind => !!json[kind] && (pkg in json[kind]! || types in json[kind]!));
    }
}

function pathAliases(root: string, dir: string): string[] {
    return ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json', 'jsconfig.json'].flatMap(name => Object.keys(readJson<{ compilerOptions?: { paths?: Record<string, string[]> } }>(join(root, dir, name))?.compilerOptions?.paths ?? {}).map(k => k.replace(/\*$/, '')));
}

function readText(path: string): string | undefined {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return undefined;
    }
}

function javascriptProblems(facts: Facts, skip: (file: string) => boolean): Problem[] {
    const modules = facts.modules.filter(m => m.language === 'typescript' && !skip(m.file));
    if (modules.length === 0) return [];
    const project = new JavascriptProject(facts.root, facts.files);
    return modules.flatMap(m => m.imports.flatMap(imp => javascriptProblem(project, facts.root, m.file, imp)));
}

/** The problem with one import, if any: a package neither declared nor installed, or installed but not declared. */
function javascriptProblem(project: JavascriptProject, root: string, file: string, imp: ImportFact): Problem[] {
    const pkg = imp.resolved ? undefined : project.external(imp.specifier);
    const dirs = dirsOf(file);
    if (!pkg || dirs.some(d => project.declares(d, pkg))) return [];
    const installed = dirs.some(d => existsSync(join(root, d, 'node_modules', pkg)));
    const nearest = dirs.find(d => project.manifest(d));
    const manifest = nearest !== undefined ? join(nearest === '.' ? '' : nearest, 'package.json') : 'package.json';
    return [{ file, imp, pkg, kind: installed ? 'undeclared' : 'unknown', manifest, certain: nearest !== undefined }];
}

// ------------------------------------------------------------------------------- Python

/** Import names whose distribution is named differently. */
const PYTHON_DISTRIBUTIONS: Record<string, string> = {
    yaml: 'pyyaml',
    cv2: 'opencv_python',
    pil: 'pillow',
    sklearn: 'scikit_learn',
    bs4: 'beautifulsoup4',
    dateutil: 'python_dateutil',
    attr: 'attrs',
    dotenv: 'python_dotenv',
    jwt: 'pyjwt',
    serial: 'pyserial',
    usb: 'pyusb',
    magic: 'python_magic',
    google: 'google',
    opentelemetry: 'opentelemetry',
    git: 'gitpython',
    docx: 'python_docx',
    pptx: 'python_pptx',
    fitz: 'pymupdf',
    crypto: 'pycryptodome',
    mpl_toolkits: 'matplotlib',
    pkg_resources: 'setuptools',
    typing_extensions: 'typing_extensions'
};

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '_');

/** Distribution names in the project's Python manifests, and the first manifest found. */
function pythonDeclared(root: string): { declared: Set<string>; manifest?: string } {
    const declared = new Set<string>();
    const manifests: string[] = [];
    const add = (names: Iterable<string>) => {
        for (const n of names) declared.add(normalize(n));
    };
    const files = safeList(root);
    for (const f of files.filter(f => /^requirements.*\.(txt|in)$/.test(f))) {
        manifests.push(f);
        add(requirementNames(readText(join(root, f)) ?? ''));
    }
    const pyproject = readText(join(root, 'pyproject.toml'));
    if (pyproject) {
        manifests.push('pyproject.toml');
        add(pyprojectNames(pyproject));
    }
    for (const f of ['setup.cfg', 'setup.py', 'Pipfile']) {
        const text = readText(join(root, f));
        if (!text) continue;
        manifests.push(f);
        add([...text.matchAll(/^\s*["']?([A-Za-z0-9][\w.-]*)\s*(?:[<>=~!;\[]|["']|$)/gm)].map(m => m[1]));
    }
    return { declared, manifest: manifests[0] };
}

function safeList(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function requirementNames(text: string): string[] {
    return text.split('\n').flatMap(line => {
        const m = /^\s*([A-Za-z0-9][\w.-]*)/.exec(line);
        return m && !line.trim().startsWith('-') ? [m[1]] : [];
    });
}

function pyprojectNames(text: string): string[] {
    const names: string[] = [];
    for (const block of text.matchAll(/(?:dependencies|requires|dev)\s*=\s*\[([\s\S]*?)\]/g)) names.push(...[...block[1].matchAll(/["']\s*([A-Za-z0-9][\w.-]*)/g)].map(m => m[1]));
    for (const table of text.matchAll(/\[tool\.poetry\.(?:(?:dev-)?dependencies|group\.\w+\.dependencies)\]([\s\S]*?)(?=\n\[|$)/g)) names.push(...[...table[1].matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=/gm)].map(m => m[1]));
    return names;
}

function classifyPython(names: string[]): Map<string, 'stdlib' | 'installed' | 'missing'> {
    const out = new Map<string, 'stdlib' | 'installed' | 'missing'>();
    if (names.length === 0) return out;
    const script = [
        'import sys, json, importlib.util',
        'names = json.loads(sys.stdin.read())',
        'std = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)',
        'out = {}',
        'for n in names:',
        '    if n in std: out[n] = "stdlib"; continue',
        '    try: out[n] = "installed" if importlib.util.find_spec(n) else "missing"',
        '    except Exception: out[n] = "missing"',
        'print(json.dumps(out))'
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-c', script], { input: JSON.stringify(names), encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) return out;
    try {
        for (const [k, v] of Object.entries(JSON.parse(r.stdout) as Record<string, 'stdlib' | 'installed' | 'missing'>)) out.set(k, v);
    } catch {
        // no answer: nothing classified
    }
    return out;
}

/** Top-level Python imports that are not the project's own modules. */
function externalPythonImports(facts: Facts, skip: (file: string) => boolean): Array<{ file: string; imp: ImportFact; top: string }> {
    const localTops = new Set(facts.files.filter(f => f.endsWith('.py')).flatMap(f => f.replace(/\.py$/, '').split('/')));
    const local = (top: string) => localTops.has(top) || existsSync(join(facts.root, top)) || existsSync(join(facts.root, 'src', top));
    return facts.modules
        .filter(m => m.language === 'python' && !skip(m.file))
        .flatMap(m => m.imports.filter(imp => !imp.resolved && !imp.specifier.startsWith('.') && !imp.typeOnly).map(imp => ({ file: m.file, imp, top: imp.specifier.split('.')[0] })))
        .filter(w => w.top && !local(w.top));
}

function pythonProblems(facts: Facts, skip: (file: string) => boolean): Problem[] {
    const wanted = externalPythonImports(facts, skip);
    if (wanted.length === 0) return [];
    const classes = classifyPython([...new Set(wanted.map(w => w.top))]);
    const { declared, manifest } = pythonDeclared(facts.root);
    const isDeclared = (top: string) => {
        const dist = PYTHON_DISTRIBUTIONS[top.toLowerCase()] ?? normalize(top);
        return declared.has(dist) || declared.has(normalize(top)) || [...declared].some(d => d.startsWith(`${dist}_`));
    };
    return wanted.flatMap((w): Problem[] => {
        const kind = classes.get(w.top);
        if (!kind || kind === 'stdlib' || isDeclared(w.top)) return [];
        // Installed but not declared matters only for a project that declares its dependencies.
        if (kind === 'installed') return manifest ? [{ ...w, pkg: w.top, kind: 'undeclared', manifest, certain: true }] : [];
        return [{ ...w, pkg: w.top, kind: 'unknown', manifest: manifest ?? 'requirements.txt or pyproject.toml', certain: !!manifest }];
    });
}

// ----------------------------------------------------------------------------------- Go

interface GoModule {
    dir: string;
    module: string;
    requires: string[];
}

function readGoMod(root: string, dir: string): GoModule | undefined {
    const text = readText(join(root, dir, 'go.mod'));
    if (text === undefined) return undefined;
    return { dir, module: /^module\s+(\S+)/m.exec(text)?.[1] ?? '', requires: [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v[\w.+-]+/gm)].map(m => m[1]) };
}

/** Whether a Go import is the standard library, the module itself, or a required module. */
function goKnows(mod: GoModule, spec: string): boolean {
    if (!spec.split('/')[0].includes('.')) return true; // standard library
    if (mod.module && (spec === mod.module || spec.startsWith(`${mod.module}/`))) return true;
    return mod.requires.some(r => spec === r || spec.startsWith(`${r}/`));
}

function goProblems(facts: Facts, skip: (file: string) => boolean): Problem[] {
    const mods = new Map<string, GoModule | undefined>();
    const modOf = (file: string) => {
        for (const dir of dirsOf(file)) {
            if (!mods.has(dir)) mods.set(dir, readGoMod(facts.root, dir));
            if (mods.get(dir)) return mods.get(dir);
        }
        return undefined;
    };
    return facts.modules
        .filter(m => m.language === 'go' && !skip(m.file))
        .flatMap(m => {
            const mod = modOf(m.file);
            if (!mod) return [];
            return m.imports
                .map(imp => ({ imp, spec: imp.specifier.replace(/^["`]|["`]$/g, '') }))
                .filter(({ imp, spec }) => !imp.resolved && !goKnows(mod, spec))
                .map(({ imp, spec }): Problem => ({ file: m.file, imp, pkg: spec, kind: 'unknown', manifest: join(mod.dir === '.' ? '' : mod.dir, 'go.mod'), certain: true }));
        });
}
