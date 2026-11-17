/**
 * `pflow serve`: the editor and its API on this machine's loopback, as the desktop application runs
 * them. The VS Code extension starts it to show the editor in its tabs: it reads the address from
 * the first line, and `--until-stdin-closes` ends the server with the extension.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEditorServer } from '../serve.js';
import type { Values } from './shared.js';

/** The built editor next to this package: packages/app/dist/app/browser. */
const BUILT_EDITOR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../app/dist/app/browser');

/** The first line `pflow serve` writes, which the VS Code extension reads. */
export const SERVE_BANNER = 'ProvenFlow editor at';

export async function serveCommand(values: Values): Promise<number> {
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        console.error(`--port must be a port number (not ${values.port}).`);
        return 2;
    }
    const server = await startEditorServer({ staticDir: process.env['STATIC_DIR'] ?? BUILT_EDITOR, port });
    console.log(`${SERVE_BANNER} ${server.url}`);
    await new Promise<void>(done => {
        const stop = () => void server.close().then(done);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        if (values['until-stdin-closes']) {
            process.stdin.once('end', stop);
            process.stdin.resume();
        }
    });
    return 0;
}
