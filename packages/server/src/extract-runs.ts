/**
 * Code base analyses that outlive the request: a long analysis goes on when the browser loses the
 * connection (a proxy or browser timeout, a laptop going to sleep), and the browser reconnects to
 * GET /api/extract/runs/<id> to follow it again or collect its report.
 *
 * Each connection gets the current step at least every 15 s, so no browser or proxy takes a
 * quiet stream for a dead one (Firefox gives up after 300 s without data).
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Progress } from '@provenflow/extract';

type Outcome = { result: unknown } | { error: string };

interface Run {
    id: string;
    latest?: Progress;
    outcome?: Outcome;
    listeners: Set<(line: unknown) => void>;
}

/** How long a finished run's report can still be collected. */
const KEEP_MS = 30 * 60_000;
export const HEARTBEAT_MS = 15_000;

export class ExtractRuns {
    private readonly runs = new Map<string, Run>();

    constructor(private readonly heartbeatMs = HEARTBEAT_MS) {}

    create(): Run {
        const run: Run = { id: randomUUID(), listeners: new Set() };
        this.runs.set(run.id, run);
        return run;
    }

    get(id: string): Run | undefined {
        return this.runs.get(id);
    }

    progress(run: Run, progress: Progress): void {
        run.latest = progress;
        run.listeners.forEach(send => send({ progress }));
    }

    finish(run: Run, outcome: Outcome): void {
        run.outcome = outcome;
        run.listeners.forEach(send => send(outcome));
        run.listeners.clear();
        setTimeout(() => this.runs.delete(run.id), KEEP_MS).unref();
    }

    /** Streams a run to a response (NDJSON): its id, where it is, then every step until its outcome. */
    attach(run: Run, res: Response): void {
        res.status(200).setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('x-accel-buffering', 'no');
        res.flushHeaders();
        const write = (line: unknown) => {
            if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(line)}\n`);
        };
        write({ run: run.id });
        if (run.latest) write({ progress: run.latest });
        if (run.outcome) {
            write(run.outcome);
            res.end();
            return;
        }
        const heartbeat = setInterval(() => write(run.latest ? { progress: run.latest } : { heartbeat: true }), this.heartbeatMs);
        const listener = (line: unknown) => {
            write(line);
            if (typeof line === 'object' && line !== null && ('result' in line || 'error' in line)) {
                clearInterval(heartbeat);
                res.end();
            }
        };
        run.listeners.add(listener);
        res.on('close', () => {
            clearInterval(heartbeat);
            run.listeners.delete(listener);
        });
    }
}
