/**
 * The editor and its API on a loopback port: what the desktop application and `pflow serve` (the
 * VS Code extension's editor tabs) run. It reads folders by path, since it serves the user's own
 * machine only, and keeps the LLM settings in the user's configuration folder, as `npm start` does.
 */
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cleanStaleWorkspaces } from '@provenflow/extract';
import { createApp } from './app.js';
import { LlmSettingsStore } from './llm-settings.js';
import { configFromEnv } from './nuxmv-runner.js';
import { nurvExecutable } from './nurv-runner.js';

export interface EditorServer {
    /** The editor's address, ending with a slash. */
    url: string;
    close(): Promise<void>;
}

export interface EditorServerOptions {
    /** The built editor (packages/app/dist/app/browser). */
    staticDir: string;
    /** 0 (the default): a free port. */
    port?: number;
}

const LOOPBACK = '127.0.0.1';

export async function startEditorServer(options: EditorServerOptions): Promise<EditorServer> {
    if (!existsSync(options.staticDir)) throw new Error(`The editor is not built (${options.staticDir}): run npm run build first.`);
    const llmSettings = new LlmSettingsStore();
    await llmSettings.load();
    const app = createApp({ runner: configFromEnv(), staticDir: options.staticDir, nurv: nurvExecutable(), allowLocalPaths: true, llmSettings });
    const server = await new Promise<Server>((resolve, reject) => {
        const s = app.listen(options.port ?? 0, LOOPBACK, () => resolve(s));
        s.once('error', reject);
    });
    // Copies left by analyses interrupted when a server stopped.
    cleanStaleWorkspaces();
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://${LOOPBACK}:${port}/`,
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
}
