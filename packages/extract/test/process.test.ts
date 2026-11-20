import { afterEach, describe, expect, it } from 'vitest';
import { childEnv, run } from '../src/tools/process.js';

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe('run', () => {
    const versions = process.versions as Record<string, string | undefined>;
    afterEach(() => {
        delete versions['electron'];
    });

    it('returns on timeout even when a grandchild holds the output pipes, and kills the grandchild', async () => {
        // The child starts a grandchild that inherits stdout and stderr (as tsx starts the replay script), then hangs.
        const script = `
            const { spawn } = require('node:child_process');
            const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
            console.log('GRANDCHILD ' + g.pid);
            setInterval(() => {}, 1000);
        `;
        const started = Date.now();
        const r = await run(process.execPath, ['-e', script], { cwd: process.cwd(), timeoutMs: 1_000 });
        expect(r.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(8_000);
        const grandchild = Number(/GRANDCHILD (\d+)/.exec(r.stdout)?.[1]);
        expect(grandchild).toBeGreaterThan(0);
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(alive(grandchild)).toBe(false);
    }, 15_000);

    it('runs the Electron binary as Node, for itself and what it starts, inside the desktop application', () => {
        versions['electron'] = '0.0.0';
        expect(childEnv(process.execPath, undefined)['ELECTRON_RUN_AS_NODE']).toBe('1');
        expect(childEnv('/usr/bin/python3', undefined)['ELECTRON_RUN_AS_NODE']).toBe(process.env['ELECTRON_RUN_AS_NODE']);
    });

    it('leaves the environment alone outside Electron', () => {
        expect(childEnv(process.execPath, { A: 'b' })).toEqual({ ...process.env, A: 'b' });
    });
});
