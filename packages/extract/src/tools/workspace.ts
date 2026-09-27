/**
 * A temporary copy of a project with some files replaced: analysers, builds and tests run on the
 * changed code without touching the real files. Heavy folders (node_modules, vendor, target, .venv)
 * are linked, not copied, so builds and type checks still find their dependencies. So are build
 * outputs and files that are not source or configuration (images, data): on large projects the
 * copy stays small. Source files are copied, never linked: a type checker follows a link back to
 * the real folder and would resolve its imports there, next to the unchanged files.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const LINKED = new Set(['node_modules', 'vendor', '.venv', 'venv', 'target', 'Pods', '.gradle', 'bower_components', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache']);
const SKIPPED = new Set(['.git', '.provenflow', '.angular', 'coverage', '.DS_Store', '__pycache__', '.pytest_cache', '.mypy_cache']);
/** Files copied (source, configuration, text, up to MAX_COPIED bytes); any other file is linked. */
const COPIED = /\.(m?[jt]sx?|c[jt]s|d\.ts|json|jsonc|ya?ml|toml|ini|cfg|conf|properties|xml|html?|css|s[ac]ss|less|vue|svelte|py|pyi|java|kts?|groovy|gradle|scala|sc|sbt|c|h|cc|cpp|cxx|hh|hpp|hxx|m|mm|cs|csproj|sln|props|targets|go|mod|sum|rs|swift|rb|gemspec|php|r|R|Rmd|sh|bash|zsh|ps1|bat|cmd|mk|cmake|txt|md|lock|env|sql|graphql|proto|pflow)$|(^|\/)(Makefile|Dockerfile|Gemfile|Rakefile|DESCRIPTION|NAMESPACE|gradlew|mvnw|LICENSE|\.[\w.-]+rc)$/;

const MAX_COPIED = 1_000_000;

/** Prefixes of the temporary folders ProvenFlow creates while it analyses. */
const TEMP_PREFIXES = ['provenflow-ws-', 'provenflow-harness-', 'provenflow-replay-', 'provenflow-infer-', 'provenflow-codeql-', 'provenflow-diff-', 'provenflow-extract-'];

/**
 * Removes the temporary folders left by analyses that were interrupted (a server stopped mid-run),
 * older than `minAgeMs`. Returns how many were removed.
 */
export function cleanStaleWorkspaces(minAgeMs = 10 * 60_000, dir = tmpdir()): number {
    let removed = 0;
    for (const name of readdirSync(dir)) {
        if (!TEMP_PREFIXES.some(p => name.startsWith(p))) continue;
        const path = join(dir, name);
        try {
            if (Date.now() - lstatSync(path).mtimeMs < minAgeMs) continue;
            rmSync(path, { recursive: true, force: true });
            removed++;
        } catch {
            // in use or already gone
        }
    }
    return removed;
}

export interface Workspace {
    dir: string;
    dispose(): void;
}

export function materialize(root: string, overrides: Map<string, string>): Workspace {
    const dir = mkdtempSync(join(tmpdir(), 'provenflow-ws-'));
    const copy = (from: string, to: string) => {
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            if (SKIPPED.has(entry.name)) continue;
            const source = join(from, entry.name);
            const target = join(to, entry.name);
            if (entry.isDirectory()) {
                if (LINKED.has(entry.name)) {
                    symlinkSync(source, target, 'dir');
                } else {
                    mkdirSync(target, { recursive: true });
                    copy(source, target);
                }
            } else if (entry.isFile()) {
                if (COPIED.test(entry.name) && statSync(source).size <= MAX_COPIED) cpSync(source, target);
                else symlinkSync(source, target, 'file');
            } else if (entry.isSymbolicLink()) {
                try {
                    symlinkSync(source, target);
                } catch {
                    // unreadable link: skipped
                }
            }
        }
    };
    copy(root, dir);
    for (const [file, text] of overrides) {
        const target = join(dir, file);
        if (!relative(dir, target) || relative(dir, target).startsWith('..')) continue;
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target) && lstatSync(target).isSymbolicLink()) rmSync(target);
        writeFileSync(target, text);
    }
    return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
