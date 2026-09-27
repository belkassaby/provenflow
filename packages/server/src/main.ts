import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanStaleWorkspaces } from '@provenflow/extract';
import { createApp } from './app.js';
import { LlmSettingsStore } from './llm-settings.js';
import { configFromEnv, nuxmvInfo } from './nuxmv-runner.js';
import { nurvExecutable } from './nurv-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env['PORT'] ?? 3000);
// Bind to loopback by default: the API runs a local binary on request.
const host = process.env['HOST'] ?? '127.0.0.1';
const staticDir = process.env['STATIC_DIR'] ?? resolve(here, '../../app/dist/app/browser');
const runner = configFromEnv();

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
// Reading folders by path is for a server on this machine only (PROVENFLOW_EXTRACT_PATHS=0 turns it off).
const allowLocalPaths = loopback && process.env['PROVENFLOW_EXTRACT_PATHS'] !== '0';
const llmSettings = new LlmSettingsStore();
if (allowLocalPaths) await llmSettings.load();
const app = createApp({ runner, staticDir, nurv: nurvExecutable(), allowLocalPaths, llmSettings });
app.listen(port, host, async () => {
    console.log(`provenflow server listening on http://${host}:${port}`);
    // Copies left by analyses interrupted when a server stopped.
    const cleaned = cleanStaleWorkspaces();
    if (cleaned > 0) console.log(`Removed ${cleaned} temporary folder(s) left by interrupted analyses.`);
    const info = await nuxmvInfo(runner);
    if (info.available) console.log(`Using ${info.version ?? 'nuXmv'} (${info.executable})`);
    else console.warn(`nuXmv not available (${info.error}). Set NUXMV_PATH to the nuXmv executable.`);
});
