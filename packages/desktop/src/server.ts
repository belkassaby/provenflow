/**
 * The ProvenFlow server inside the desktop application: the same Express app as the web version,
 * bound to loopback on a free port, serving the built editor. It reads folders by path (the
 * desktop application analyses the user's own code base) and keeps the LLM settings in the user's
 * configuration folder, as `npm start` does.
 */
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { configFromEnv, createApp, LlmSettingsStore, nurvExecutable } from '@provenflow/server';
import { cleanStaleWorkspaces } from '@provenflow/extract';

export interface RunningServer {
    url: string;
    close(): Promise<void>;
}

export async function startServer(uiDir: string): Promise<RunningServer> {
    if (!existsSync(uiDir)) throw new Error(`The editor is not built (${uiDir}): run npm run build first.`);
    const llmSettings = new LlmSettingsStore();
    await llmSettings.load();
    const app = createApp({ runner: configFromEnv(), staticDir: uiDir, nurv: nurvExecutable(), allowLocalPaths: true, llmSettings });
    const server = await new Promise<import('node:http').Server>((resolve, reject) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
    });
    cleanStaleWorkspaces();
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
}
