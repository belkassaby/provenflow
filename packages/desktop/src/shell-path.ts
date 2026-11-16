/**
 * An application started from the Dock, the Start menu or a desktop launcher does not get the PATH
 * of the user's shell, so nuXmv, Python, Semgrep and the other tools ProvenFlow runs would not be
 * found. On macOS and Linux the login shell is asked for its PATH once at start (as VS Code does).
 */
import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

const MARK = '__PROVENFLOW_PATH__';

/** The PATH printed by the login shell, or undefined (Windows, no shell, too slow). */
export function loginShellPath(platform: NodeJS.Platform, shell = process.env['SHELL']): string | undefined {
    if (platform === 'win32') return undefined;
    const result = spawnSync(shell || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { encoding: 'utf8', timeout: 4000 });
    return parseShellPath(result.stdout ?? '');
}

export function parseShellPath(output: string): string | undefined {
    const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(output);
    return m?.[1]?.trim() || undefined;
}

/** The shell's PATH entries first, then the ones only the process has, each once. */
export function mergePath(current: string | undefined, fromShell: string | undefined): string {
    const entries = [...(fromShell ?? '').split(delimiter), ...(current ?? '').split(delimiter)].filter(Boolean);
    return [...new Set(entries)].join(delimiter);
}
