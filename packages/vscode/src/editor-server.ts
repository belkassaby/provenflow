/**
 * The editor's server: one `pflow serve` for every editor tab, started with the first one and
 * stopped with the extension (it ends when its stdin closes). No `vscode` import here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnPlan } from './cli';
import { editorUrlOf } from './editor-page';

/** How long `pflow serve` may take to say where it listens. */
const START_TIMEOUT_MS = 30_000;

export class EditorServerProcess {
    private child?: ChildProcess;
    private started?: Promise<string>;

    /** The editor's address, starting `pflow serve` (with this pflow) when it is not running. */
    url(cli: string, cwd: string): Promise<string> {
        this.started ??= this.start(cli, cwd).catch(error => {
            this.dispose();
            throw error;
        });
        return this.started;
    }

    dispose(): void {
        this.child?.stdin?.end();
        this.child?.kill();
        this.child = undefined;
        this.started = undefined;
    }

    private start(cli: string, cwd: string): Promise<string> {
        const plan = spawnPlan(cli, ['serve', '--until-stdin-closes'], process.platform);
        const child = spawn(plan.command, plan.args, { cwd, shell: plan.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        return new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error(`pflow serve did not start within ${START_TIMEOUT_MS / 1000} s.`)), START_TIMEOUT_MS);
            const read = (chunk: unknown) => {
                output = (output + String(chunk)).slice(-8000);
                const url = editorUrlOf(output);
                if (!url) return;
                clearTimeout(timer);
                resolve(url);
            };
            child.stdout?.on('data', read);
            child.stderr?.on('data', read);
            child.on('error', error => {
                clearTimeout(timer);
                reject(error);
            });
            child.on('exit', code => {
                clearTimeout(timer);
                if (this.child === child) this.child = undefined;
                this.started = undefined;
                reject(new Error(`pflow serve stopped (exit ${code ?? '-'}): ${output.trim().split('\n').slice(-3).join(' ')}`));
            });
        });
    }
}
