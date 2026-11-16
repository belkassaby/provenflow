/**
 * How the extension runs pflow: which command, with which arguments. No `vscode` import here.
 */
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Where the extension asks pflow to write its outputs, under the analysed folder. */
export const OUTPUT_FOLDER = join('.provenflow', 'vscode');

export interface AnalysisSettings {
    /** Run the installed analysers and replay counterexamples too (slower). */
    full: boolean;
    /** Propose automatic fixes, each verified. */
    fixes: boolean;
}

/** `pflow extract` for a folder: the report only, never a failing exit code for findings. */
export function extractArguments(folder: string, output: string, settings: AnalysisSettings): string[] {
    return [
        'extract',
        folder,
        '-o',
        output,
        '--quiet',
        '--fail-on',
        'none',
        ...(settings.full ? [] : ['--no-analyzers', '--no-confirm']),
        ...(settings.fixes ? ['--fix'] : [])
    ];
}

/** Folders whose files do not start an analysis when saved: pflow's outputs, git, dependencies. */
const NOT_ANALYSED = /^(\.provenflow|\.git|node_modules)([\\/]|$)/;

/** Whether saving a file (its path relative to the workspace folder) should start an analysis. */
export function startsAnalysis(relativePath: string): boolean {
    return relativePath !== '' && !relativePath.startsWith('..') && !NOT_ANALYSED.test(relativePath);
}

/** The names pflow has on a platform (npm writes a .cmd shim on Windows). */
export function commandNames(platform: NodeJS.Platform): string[] {
    return platform === 'win32' ? ['pflow.cmd', 'pflow.exe', 'pflow'] : ['pflow'];
}

/** What the lookup needs from the file system, so that it can be tested. */
export interface FileProbe {
    exists(path: string): boolean;
}

export const DISK: FileProbe = { exists: path => existsSync(path) };

/**
 * The pflow to run, in this order: the configured path (relative to the folder), the workspace's
 * node_modules/.bin, then the PATH. Undefined when none is there.
 */
export function findCli(folder: string, configured: string, environment: { path: string; platform: NodeJS.Platform }, probe: FileProbe = DISK): string | undefined {
    const names = commandNames(environment.platform);
    if (configured.trim()) {
        const path = isAbsolute(configured) ? configured : join(folder, configured);
        return probe.exists(path) ? path : undefined;
    }
    const local = names.map(name => join(folder, 'node_modules', '.bin', name));
    const onPath = environment.path
        .split(delimiter)
        .filter(Boolean)
        .flatMap(dir => names.map(name => join(dir, name)));
    return [...local, ...onPath].find(path => probe.exists(path));
}

/** What to tell the user when no pflow is found. */
export function missingCliMessage(configured: string): string {
    return configured.trim()
        ? `ProvenFlow: the pflow command set in provenflow.cliPath (${configured}) does not exist.`
        : 'ProvenFlow: pflow was not found. Install ProvenFlow in the workspace (npm install, then npm run build), or set provenflow.cliPath to its packages/server/out/cli.js.';
}

/**
 * A .js path is run with the node on the PATH (the extension host's own executable is Electron);
 * a shim or binary directly (Windows shims need a shell).
 */
export function spawnPlan(cli: string, args: string[], platform: NodeJS.Platform): { command: string; args: string[]; shell: boolean } {
    if (/\.(c|m)?js$/.test(cli)) return { command: 'node', args: [cli, ...args], shell: false };
    return { command: cli, args, shell: platform === 'win32' && /\.cmd$/i.test(cli) };
}
