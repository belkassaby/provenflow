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

/** How long a killed run waits for its output pipes to close before it returns anyway. */
const CLOSE_GRACE_MS = 2_000;

/**
 * The environment of a child process. Inside Electron (the desktop application), `process.execPath`
 * is the Electron binary: without ELECTRON_RUN_AS_NODE it starts a second application instead of
 * running the script, and never exits. The variable is inherited, so a tool that starts itself again
 * (tsx does) runs as Node too.
 */
export function childEnv(command: string, env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const asNode = process.versions.electron !== undefined && command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    return { ...process.env, ...asNode, ...env };
}

/** The processes started by `pid`, and theirs, children first found first (`pgrep -P`; none where it is missing). */
function descendants(pid: number): number[] {
    const found: number[] = [];
    const queue = [pid];
    while (queue.length > 0) {
        const r = spawnSync('pgrep', ['-P', String(queue.shift())], { encoding: 'utf8', timeout: 5_000 });
        const children = (r.stdout ?? '').split('\n').map(Number).filter(n => n > 0);
        found.push(...children);
        queue.push(...children);
    }
    return found;
}

/** Kills a process and everything it started: a grandchild left alive would keep the output pipes open. */
function killTree(pid: number | undefined): void {
    if (pid === undefined) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 5_000 });
        return;
    }
    // Collect first: once the parent dies its children belong to init and pgrep -P no longer finds them.
    for (const target of [pid, ...descendants(pid)]) {
        try {
            process.kill(target, 'SIGKILL');
        } catch {
            // already gone
        }
    }
}

export function run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; shell?: boolean }): Promise<RunResult> {
    return new Promise(resolve => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let child: ReturnType<typeof spawn>;
        const finish = (result: Omit<RunResult, 'ms'>): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ...result, ms: Date.now() - started });
        };
        try {
            child = spawn(command, args, { cwd: options.cwd, env: childEnv(command, options.env), shell: options.shell ?? false, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({ code: -1, stdout: '', stderr: (error as Error).message, timedOut: false, ms: 0 });
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, options.timeoutMs ?? 120_000);
        child.stdout!.on('data', (d: Buffer) => {
            if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
        });
        child.stderr!.on('data', (d: Buffer) => {
            if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
        });
        child.on('error', error => finish({ code: -1, stdout, stderr: stderr + error.message, timedOut }));
        // 'close' waits for the pipes; after a kill, don't let a process that escaped hold the run open.
        child.on('exit', code => {
            if (!timedOut) return;
            setTimeout(() => {
                finish({ code, stdout, stderr, timedOut });
                child.stdout!.destroy();
                child.stderr!.destroy();
            }, CLOSE_GRACE_MS);
        });
        child.on('close', code => finish({ code, stdout, stderr, timedOut }));
        if (options.input !== undefined) child.stdin!.end(options.input);
        else child.stdin!.end();
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
