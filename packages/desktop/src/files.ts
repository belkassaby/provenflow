/**
 * Files the desktop application opens: from File → Open…, from the command line or the file
 * manager (a double-click on a .pflow file, "Open with"), and the macOS `open-file` event.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

export interface OpenedFile {
    name: string;
    path: string;
    text: string;
    /** A state diagram (.pflow), or a C4 workspace (Structurizr DSL, or its JSON form). */
    kind: 'diagram' | 'c4';
}

const MAX_BYTES = 16 * 1024 * 1024;

export const OPEN_FILTERS = [
    { name: 'ProvenFlow diagrams and C4 workspaces', extensions: ['pflow', 'nxd', 'dsl', 'json'] },
    { name: 'All files', extensions: ['*'] }
];

/** What kind of file a name is, or undefined when the application does not open it. */
export function kindOf(path: string): OpenedFile['kind'] | undefined {
    const ext = extname(path).toLowerCase();
    if (ext === '.pflow' || ext === '.nxd') return 'diagram';
    if (ext === '.dsl' || path.toLowerCase().endsWith('.c4.json')) return 'c4';
    return undefined;
}

/** Reads a file to open, or says why it cannot be. A `.json` chosen in the dialog is taken as a C4 workspace. */
export function readOpenable(path: string, chosen = false): OpenedFile | { error: string } {
    const kind = kindOf(path) ?? (chosen && extname(path).toLowerCase() === '.json' ? 'c4' : undefined);
    if (!kind) return { error: `${basename(path)}: ProvenFlow opens .pflow diagrams and C4 workspaces (.dsl, .c4.json).` };
    try {
        if (statSync(path).size > MAX_BYTES) return { error: `${basename(path)} is larger than 16 MB.` };
        return { name: basename(path), path, text: readFileSync(path, 'utf8'), kind };
    } catch (error) {
        return { error: `${basename(path)}: ${(error as Error).message}` };
    }
}

/** The files named on a command line (the application's own arguments and switches left out). */
export function filesFromArgv(argv: string[], cwd: string): string[] {
    return argv
        .slice(1)
        .filter(a => !a.startsWith('-') && kindOf(a) !== undefined)
        .map(a => resolve(cwd, a));
}
