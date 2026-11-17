/**
 * How the extension runs pflow: which command, with which arguments. No `vscode` import here.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

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
        // Saves measure uncommitted work: the trends keep measures of commits only (pflow extract, --backfill).
        '--no-history',
        ...(settings.full ? [] : ['--no-analyzers', '--no-confirm']),
        ...(settings.fixes ? ['--fix'] : [])
    ];
}

/** `pflow trends` for a folder, as JSON; with `backfill`, first measures that many older commits. */
export function trendsArguments(folder: string, backfill = 0): string[] {
    return ['trends', folder, '--json', ...(backfill > 0 ? ['--backfill', String(backfill), '--quiet'] : [])];
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
 * The pflow to run, in this order: the configured path (relative to the folder), node_modules/.bin
 * of the folder or of a folder above it (a package of a monorepo), then the PATH. Undefined when
 * none is there.
 */
export function findCli(folder: string, configured: string, environment: { path: string; platform: NodeJS.Platform }, probe: FileProbe = DISK): string | undefined {
    const names = commandNames(environment.platform);
    if (configured.trim()) {
        const path = isAbsolute(configured) ? configured : join(folder, configured);
        return probe.exists(path) ? path : undefined;
    }
    const local = foldersUp(folder).flatMap(dir => names.map(name => join(dir, 'node_modules', '.bin', name)));
    const onPath = environment.path
        .split(delimiter)
        .filter(Boolean)
        .flatMap(dir => names.map(name => join(dir, name)));
    return [...local, ...onPath].find(path => probe.exists(path));
}

/** A folder and the folders above it, up to the root. */
function foldersUp(folder: string): string[] {
    const parent = dirname(folder);
    return parent === folder ? [folder] : [folder, ...foldersUp(parent)];
}

/** What to tell the user when no pflow is found. */
export function missingCliMessage(configured: string): string {
    return configured.trim()
        ? `ProvenFlow: the pflow set in provenflow.cliPath (${configured}) does not exist. Choose another one.`
        : 'ProvenFlow: pflow was not found (provenflow.cliPath is empty, and there is no node_modules/.bin/pflow here and no pflow on the PATH). Choose it: the packages/server/out/cli.js of a built ProvenFlow checkout, or a pflow command.';
}

/**
 * A .js path is run with the node on the PATH (the extension host's own executable is Electron);
 * a shim or binary directly (Windows shims need a shell).
 */
export function spawnPlan(cli: string, args: string[], platform: NodeJS.Platform): { command: string; args: string[]; shell: boolean } {
    if (/\.(c|m)?js$/.test(cli)) return { command: 'node', args: [cli, ...args], shell: false };
    return { command: cli, args, shell: platform === 'win32' && /\.cmd$/i.test(cli) };
}
