/** Runs external tools (analysers, builds, tests) with a timeout and bounded output. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    ms: number;
}

const MAX_OUTPUT = 20_000_000;

export function run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; shell?: boolean }): Promise<RunResult> {
    return new Promise(resolve => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let child;
        try {
            child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: options.shell ?? false, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({ code: -1, stdout: '', stderr: (error as Error).message, timedOut: false, ms: 0 });
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, options.timeoutMs ?? 120_000);
        child.stdout.on('data', (d: Buffer) => {
            if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d: Buffer) => {
            if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
        });
        child.on('error', error => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: stderr + error.message, timedOut, ms: Date.now() - started });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
        });
        if (options.input !== undefined) child.stdin.end(options.input);
        else child.stdin.end();
    });
}

/**
 * The executable of a tool: `<NAME>_PATH` (e.g. SEMGREP_PATH), then the PATH. Returns undefined when
 * it is not installed; tools are optional and the report says which ones ran.
 */
export function findTool(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const fromEnv = env[`${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`];
    if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
    for (const dir of (env['PATH'] ?? '').split(delimiter)) {
        if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
    return undefined;
}

export function toolVersion(executable: string, args = ['--version']): string | undefined {
    try {
        const r = spawnSync(executable, args, { encoding: 'utf8', timeout: 20_000 });
        return `${r.stdout}${r.stderr}`.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 80);
    } catch {
        return undefined;
    }
}

/** The last lines of an output, for reports. */
export function tail(text: string, lines = 30): string {
    return text.trimEnd().split('\n').slice(-lines).join('\n');
}
