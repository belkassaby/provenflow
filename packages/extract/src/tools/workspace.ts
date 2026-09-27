/**
 * A temporary copy of a project with some files replaced: analysers, builds and tests run on the
 * changed code without touching the real files. Heavy folders (node_modules, vendor, target, .venv)
 * are linked, not copied, so builds and type checks still find their dependencies.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const LINKED = new Set(['node_modules', 'vendor', '.venv', 'venv', 'target', 'Pods', '.gradle', 'bower_components']);
const SKIPPED = new Set(['.git', '.provenflow', '.angular', 'coverage', '.DS_Store']);

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
                cpSync(source, target);
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
