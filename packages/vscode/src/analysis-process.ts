/**
 * One pflow run at a time: starting a new one stops the one still running. No `vscode` import here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnPlan } from './cli';

export interface RunOutcome {
    /** The exit code (undefined when the run was stopped or could not start). */
    code?: number;
    stopped: boolean;
    /** The last lines pflow wrote on stderr (notes and errors). */
    stderr: string;
    /** What pflow wrote on stdout (up to 4 MB: `pflow trends --json`). */
    stdout: string;
}

/** How much of stderr is kept for the message shown when a run fails. */
const STDERR_KEPT = 4000;
const STDOUT_KEPT = 4 * 1024 * 1024;

export class AnalysisProcess {
    /** The pflow process of the run going on, if any. */
    private child?: ChildProcess;

    get running(): boolean {
        return this.child !== undefined;
    }

    /** Runs pflow with the arguments, after stopping the run still going. */
    start(cli: string, args: string[], cwd: string): Promise<RunOutcome> {
        this.dispose();
        const plan = spawnPlan(cli, args, process.platform);
        return new Promise(resolve => {
            const child = spawn(plan.command, plan.args, { cwd, shell: plan.shell, windowsHide: true });
            this.child = child;
            let stderr = '';
            let stdout = '';
            let stopped = false;
            child.stderr?.on('data', chunk => (stderr = (stderr + String(chunk)).slice(-STDERR_KEPT)));
            child.stdout?.on('data', chunk => (stdout = (stdout + String(chunk)).slice(0, STDOUT_KEPT)));
            child.on('error', error => this.finish(child, resolve, { stopped, stderr: `${stderr}${error.message}`, stdout }));
            child.on('exit', (code, signal) => {
                stopped = signal !== null;
                this.finish(child, resolve, { code: code ?? undefined, stopped, stderr, stdout });
            });
        });
    }

    /** Stops the running analysis, if any (a later start runs a new one). */
    dispose(): void {
        this.child?.kill();
        this.child = undefined;
    }

    private finish(child: ChildProcess, resolve: (outcome: RunOutcome) => void, outcome: RunOutcome): void {
        if (this.child === child) this.child = undefined;
        resolve(outcome);
    }
}
