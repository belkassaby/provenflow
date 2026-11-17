/**
 * The exact versions a project installs, from its lockfiles (and the exact versions of manifests that
 * have no lockfile): what a vulnerability database can be asked about. Local, linked and workspace
 * packages, and packages from other registries than the public one, are left out: they are the
 * project's own, and their names are not sent anywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny } from '../scan.js';

/** OSV's names of the ecosystems read here. */
export type OsvEcosystem = 'npm' | 'PyPI' | 'crates.io' | 'Go' | 'Packagist' | 'Maven';

export interface LockedPackage {
    name: string;
    version: string;
    ecosystem: OsvEcosystem;
    /** The lockfile (relative to the analysed folder) and the line naming the package. */
    file: string;
    line: number;
}

type Reader = (text: string, file: string) => LockedPackage[];

const READERS: Array<{ test: (name: string) => boolean; read: Reader }> = [
    { test: n => n === 'package-lock.json' || n === 'npm-shrinkwrap.json', read: npmLock },
    { test: n => n === 'poetry.lock' || n === 'uv.lock', read: (t, f) => tomlPackages(t, f, 'PyPI') },
    { test: n => /^requirements.*\.txt$/.test(n), read: requirements },
    { test: n => n === 'Cargo.lock', read: (t, f) => tomlPackages(t, f, 'crates.io') },
    { test: n => n === 'go.mod', read: goMod },
    { test: n => n === 'composer.lock', read: composerLock },
    { test: n => n === 'pom.xml', read: pom }
];

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.provenflow', 'vendor', 'dist', 'out', 'build', 'target', '.venv', 'venv', '__pycache__']);
const MAX_DEPTH = 4;

/** Every locked package of the folder and its subfolders (not in `exclude`, nor in dependency folders). */
export function lockedPackages(root: string, exclude: string[] = []): LockedPackage[] {
    const found: LockedPackage[] = [];
    const visit = (dir: string, depth: number) => {
        for (const entry of entries(join(root, dir))) {
            const path = dir ? `${dir}/${entry.name}` : entry.name;
            if (matchesAny(path, exclude)) continue;
            if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) visit(path, depth + 1);
            const reader = entry.isFile() ? READERS.find(r => r.test(entry.name)) : undefined;
            if (reader) found.push(...reader.read(readFileSync(join(root, path), 'utf8'), path));
        }
    };
    visit('', 0);
    return dedupe(found);
}

function entries(dir: string) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

function dedupe(packages: LockedPackage[]): LockedPackage[] {
    const seen = new Map<string, LockedPackage>();
    for (const p of packages) seen.set(`${p.ecosystem}|${p.name}|${p.version}|${p.file}`, p);
    return [...seen.values()];
}

/** The 1-based line of the first occurrence of a text, or 1. */
function lineOf(text: string, needle: string): number {
    const at = text.indexOf(needle);
    return at < 0 ? 1 : text.slice(0, at).split('\n').length;
}

interface NpmLockEntry {
    version?: string;
    resolved?: string;
    link?: boolean;
}

const PUBLIC_NPM = /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//;

/** package-lock.json v2/v3: `packages`, keyed by node_modules path. */
function npmLock(text: string, file: string): LockedPackage[] {
    const lock = parseJson<{ packages?: Record<string, NpmLockEntry> }>(text);
    return Object.entries(lock?.packages ?? {}).flatMap(([path, entry]) => {
        const at = path.lastIndexOf('node_modules/');
        if (at < 0 || entry.link || !entry.version || (entry.resolved && !PUBLIC_NPM.test(entry.resolved))) return [];
        return [{ name: path.slice(at + 'node_modules/'.length), version: entry.version, ecosystem: 'npm' as const, file, line: lineOf(text, `"${path}"`) }];
    });
}

/** poetry.lock, uv.lock and Cargo.lock: `[[package]]` tables; packages from a path, a git checkout or the workspace are left out. */
function tomlPackages(text: string, file: string, ecosystem: OsvEcosystem): LockedPackage[] {
    return text.split(/^\[\[package\]\]\s*$/m).slice(1).flatMap(block => {
        const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        const source = /^source\s*=\s*(.+)$/m.exec(block)?.[1] ?? '';
        const local = ecosystem === 'crates.io' ? !source.includes('registry+') : /editable|virtual|path|directory|git/.test(source);
        if (!name || !version || local) return [];
        return [{ name, version, ecosystem, file, line: lineOf(text, `name = "${name}"`) }];
    });
}

/** requirements.txt: pinned lines (`name==version`). */
function requirements(text: string, file: string): LockedPackage[] {
    return text.split('\n').flatMap((raw, i) => {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([^\s;#]+)/.exec(raw);
        return m ? [{ name: m[1], version: m[3], ecosystem: 'PyPI' as const, file, line: i + 1 }] : [];
    });
}

/** go.mod: the required modules and their versions (without the leading v, as OSV compares them). */
function goMod(text: string, file: string): LockedPackage[] {
    return text.split('\n').flatMap((raw, i) => {
        const m = /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v([0-9][^\s]*)/.exec(raw);
        return m ? [{ name: m[1], version: m[2], ecosystem: 'Go' as const, file, line: i + 1 }] : [];
    });
}

/** composer.lock: `packages` and `packages-dev`. */
function composerLock(text: string, file: string): LockedPackage[] {
    const lock = parseJson<Record<string, Array<{ name?: string; version?: string }>>>(text);
    return [...(lock?.['packages'] ?? []), ...(lock?.['packages-dev'] ?? [])].flatMap(p =>
        p.name && p.version ? [{ name: p.name, version: p.version.replace(/^v/, ''), ecosystem: 'Packagist' as const, file, line: lineOf(text, `"name": "${p.name}"`) }] : []
    );
}

/** pom.xml: dependencies with a literal version (group:artifact). */
function pom(text: string, file: string): LockedPackage[] {
    return [...text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap(m => {
        const tag = (name: string) => new RegExp(`<${name}>\\s*([^<\\s]+)\\s*</${name}>`).exec(m[1])?.[1];
        const [group, artifact, version] = [tag('groupId'), tag('artifactId'), tag('version')];
        if (!group || !artifact || !version || version.includes('$')) return [];
        return [{ name: `${group}:${artifact}`, version, ecosystem: 'Maven' as const, file, line: lineOf(text, `<artifactId>${artifact}</artifactId>`) }];
    });
}

function parseJson<T>(text: string): T | undefined {
    try {
        return JSON.parse(text) as T;
    } catch {
        return undefined;
    }
}
