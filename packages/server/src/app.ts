import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { changeContext, extractProject, fixWithLlm, isApplied, providerFromSpec, verifyVersion, webReport, type Finding, type PreviousRun, type ProvenflowConfig } from '@provenflow/extract';
import { generateSmv, GenerationError, parseDiagram } from '@provenflow/language';
import { ENGINES, nuxmvInfo, runNuxmv, type Engine, type RunnerConfig } from './nuxmv-runner.js';
import { LlmSettingsStore, type LlmKind, type UpdateInput } from './llm-settings.js';
import { nurvAvailable, runNurv } from './nurv-runner.js';
import { ExtractRuns } from './extract-runs.js';

export interface AppOptions {
    runner: RunnerConfig;
    /** Directory of the built Angular application, served on `/`. */
    staticDir?: string;
    /** Maximum number of nuXmv processes running at the same time. */
    maxConcurrentRuns?: number;
    /** How often a streamed analysis repeats its current step (default 15 s). */
    heartbeatMs?: number;
    /** NuRV executable for full-LTL monitor generation (optional). */
    nurv?: string;
    /**
     * Allow POST /api/extract to analyse a folder of this machine by path. Only for servers bound to
     * loopback: anyone who can reach the API can then read the source files of any folder.
     */
    allowLocalPaths?: boolean;
    /** LLM settings entered in the editor (only accepted by a server bound to localhost). */
    llmSettings?: LlmSettingsStore;
}

/** Limits of an uploaded code base. */
const MAX_UPLOAD_FILES = 5000;

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown
    ) {
        super(message);
    }
}

export function createApp(options: AppOptions): express.Express {
    const app = express();
    app.disable('x-powered-by');
    // Code bases are uploaded to /api/extract, which takes larger bodies.
    const json = express.json({ limit: '2mb' });
    app.use((req, res, next) => (['/api/extract', '/api/apply', '/api/apply-edits', '/api/fix', '/api/verify-change'].includes(req.path) ? next() : json(req, res, next)));

    let running = 0;
    const runs = new ExtractRuns(options.heartbeatMs);
    /** The last run of each folder (a path, or an uploaded folder by name), for incremental re-runs. */
    const previousRuns = new Map<string, PreviousRun>();
    const maxRuns = options.maxConcurrentRuns ?? 2;
    /** Folders analysed by path: the only places /api/apply may write to. */
    const analysedRoots = new Set<string>();
    const settings = options.llmSettings ?? new LlmSettingsStore();
    const llmProviders = () => settings.configured();

    app.get('/api/health', async (_req, res) => {
        res.json({ ok: true, nuxmv: await nuxmvInfo(options.runner), nurv: { available: nurvAvailable(options.nurv) }, extract: { paths: !!options.allowLocalPaths, apply: !!options.allowLocalPaths, llm: llmProviders() } });
    });

    /** POST /api/nurv { diagram }: NuRV-generated full-LTL monitors (sources + build commands). */
    app.post('/api/nurv', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const executable = options.nurv;
            if (!executable || !nurvAvailable(executable)) throw new HttpError(503, 'NuRV is not configured: set NURV_PATH to the NuRV executable (https://es-static.fbk.eu/tools/nurv/).');
            const body = (req.body ?? {}) as { diagram?: unknown };
            if (typeof body.diagram !== 'string') throw new HttpError(400, "Provide 'diagram' (.pflow text).");
            const parsed = await parseDiagram(body.diagram);
            if (parsed.hasErrors) throw new HttpError(422, 'The diagram has errors.', parsed.diagnostics.filter(d => d.severity === 'error'));
            const result = await runNurv(parsed.model, executable);
            res.json({ files: result.files, monitors: result.monitors, build: result.build });
        } catch (error) {
            next(error);
        }
    });

    /**
     * POST /api/extract: models of a code base, verified (pflow extract).
     *   { path: "/abs/folder" }                   a folder on this machine (allowLocalPaths), or
     *   { files: { "src/a.ts": "...", ... } }     uploaded sources (and provenflow.config.json, package.json)
     *   config?: provenflow.config.json contents (default: the one in the folder)
     *   quickFixes?: number of verified quick fixes to propose (default 20, 0: none)
     *   llm?: "anthropic:<model>" | "openai:<model>" | "ollama:<model>", llmFixes?: number (keys come from the server's environment)
     *   incremental?: true to redo only what the files changed since the last run of this folder can
     *     affect (after applying changes); name?: the uploaded folder's name, to find its last run
     *   analyzers?: false to skip the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani) and the replay on the code
     * With `Accept: application/x-ndjson` the response streams one JSON object per line while it runs:
     * { run: id }, { progress: { phase, message, percent } }... (the current one again every 15 s),
     * then { result } or { error }. The analysis goes on if the connection drops:
     * GET /api/extract/runs/<id> follows it again.
     */
    /** The folder a request is about: a path of this machine, or uploaded files (written to a temporary folder). */
    const folderOf = async (body: { path?: unknown; files?: unknown }): Promise<{ root: string; temp?: string }> => {
        if (typeof body.path === 'string') {
            if (!options.allowLocalPaths) throw new HttpError(403, 'This server does not read folders by path (it is not bound to localhost): upload the folder instead.');
            if (!isAbsolute(body.path)) throw new HttpError(400, "'path' must be an absolute folder path.");
            const info = await stat(body.path).catch(() => undefined);
            if (!info?.isDirectory()) throw new HttpError(404, `No folder at ${body.path}.`);
            return { root: resolve(body.path) };
        }
        if (body.files && typeof body.files === 'object' && !Array.isArray(body.files)) {
            const entries = Object.entries(body.files as Record<string, unknown>);
            if (entries.length === 0) throw new HttpError(400, 'No files uploaded.');
            if (entries.length > MAX_UPLOAD_FILES) throw new HttpError(413, `At most ${MAX_UPLOAD_FILES} files.`);
            const temp = await mkdtemp(join(tmpdir(), 'provenflow-extract-'));
            // On success the caller owns the folder (and removes it); on any error it is removed here.
            let written = false;
            try {
                for (const [path, text] of entries) {
                    const safe = normalize(path).replace(/\\/g, '/');
                    if (typeof text !== 'string' || isAbsolute(safe) || safe.startsWith('..') || safe.includes('\0')) throw new HttpError(400, `Invalid file ${path}.`);
                    await mkdir(dirname(join(temp, safe)), { recursive: true });
                    await writeFile(join(temp, safe), text, 'utf8');
                }
                written = true;
                return { root: temp, temp };
            } finally {
                if (!written) await rm(temp, { recursive: true, force: true });
            }
        }
        throw new HttpError(400, "Provide 'path' (a folder on the server) or 'files' (uploaded sources).");
    };
    const providerOf = (spec: unknown) => {
        if (spec === undefined) return undefined;
        if (typeof spec !== 'string' || !/^(anthropic|openai|ollama):[\w.:/-]*$/.test(spec)) throw new HttpError(400, "'llm' must be anthropic:<model>, openai:<model> or ollama:<model>.");
        try {
            return providerFromSpec(spec, settings.providerEnv());
        } catch (error) {
            throw new HttpError(400, (error as Error).message);
        }
    };

    app.post('/api/extract', express.json({ limit: '64mb' }), async (req: Request, res: Response, next: NextFunction) => {
        let temp: string | undefined;
        try {
            const body = (req.body ?? {}) as { path?: unknown; files?: unknown; config?: unknown; quickFixes?: unknown; llm?: unknown; llmFixes?: unknown; analyzers?: unknown; incremental?: unknown; name?: unknown };
            const quickFixes = body.quickFixes === undefined ? 20 : Number(body.quickFixes);
            const llmFixes = body.llmFixes === undefined ? 5 : Number(body.llmFixes);
            if (!Number.isFinite(quickFixes) || quickFixes < 0 || !Number.isFinite(llmFixes) || llmFixes < 0) throw new HttpError(400, "'quickFixes' and 'llmFixes' must be numbers >= 0.");
            const llm = providerOf(body.llm);
            const source = await folderOf(body);
            temp = source.temp;
            const root = source.root;
            if (body.config !== undefined && (typeof body.config !== 'object' || body.config === null)) throw new HttpError(400, "'config' must be an object.");
            if (running >= maxRuns) throw new HttpError(429, 'Too many runs in progress, try again shortly.');
            running++;
            const stream = /application\/x-ndjson/.test(req.headers.accept ?? '');
            // A streamed analysis goes on if the connection drops; the browser follows it again by its id.
            const run = stream ? runs.create() : undefined;
            if (run) runs.attach(run, res);
            const folderKey = temp ? `upload:${typeof body.name === 'string' ? body.name : ''}` : root;
            try {
                const available = (await nuxmvInfo(options.runner)).available;
                const result = await extractProject(root, {
                    previous: body.incremental === true ? previousRuns.get(folderKey) : undefined,
                    config: body.config as ProvenflowConfig | undefined,
                    checker: available ? smv => runNuxmv(smv, { engine: 'bdd' }, options.runner) : undefined,
                    quickFixes: Math.min(100, quickFixes),
                    llm,
                    llmFixes: llm ? Math.min(20, llmFixes) : 0,
                    analyzers: body.analyzers !== false,
                    confirm: body.analyzers !== false,
                    onProgress: run ? progress => runs.progress(run, progress) : undefined
                });
                if (!temp) analysedRoots.add(root);
                previousRuns.set(folderKey, result.previous);
                const report = { ...(webReport(result) as object), root: temp ? '(uploaded folder)' : root, applicable: !temp && !!options.allowLocalPaths };
                if (run) runs.finish(run, { result: report });
                else res.json(report);
            } catch (error) {
                if (!run) throw error;
                runs.finish(run, { error: (error as Error).message });
            } finally {
                running--;
            }
        } catch (error) {
            next(error);
        } finally {
            if (temp) await rm(temp, { recursive: true, force: true });
        }
    });

    /**
     * One change for one finding, checked like the automatic fixes (re-run of the analysis on the
     * changed files, build or type check on a copy). The folder is given as for /api/extract
     * (`path`, or `files` and `name`); its last run on this server is the reference.
     *   POST /api/fix { finding, llm }: the LLM implements the finding's suggested fix;
     *   POST /api/verify-change { finding, changed: [{ file, after }] }: verifies the reviewer's version.
     * Both answer { finding } (with its suggestedPatch: the files before/after, the diff, verified and
     * why), and `error` when there was nothing to check.
     */
    const singleChange = (kind: 'fix' | 'verify') => async (req: Request, res: Response, next: NextFunction) => {
        let temp: string | undefined;
        try {
            const body = (req.body ?? {}) as { path?: unknown; files?: unknown; name?: unknown; config?: unknown; finding?: unknown; llm?: unknown; changed?: unknown; analyzers?: unknown };
            const finding = body.finding as Finding | undefined;
            if (!finding || typeof finding !== 'object' || typeof finding.rule !== 'string' || typeof finding.subject !== 'string') throw new HttpError(400, "Provide the 'finding' to change.");
            const provider = kind === 'fix' ? providerOf(body.llm) : undefined;
            if (kind === 'fix' && !provider) throw new HttpError(400, "Provide 'llm' (anthropic:<model>, openai:<model> or ollama:<model>).");
            const changed = kind === 'verify' ? body.changed : undefined;
            if (kind === 'verify' && (!Array.isArray(changed) || changed.length === 0 || changed.some(c => typeof c?.file !== 'string' || typeof c?.after !== 'string'))) throw new HttpError(400, "Provide 'changed': [{ file, after }].");
            if (body.config !== undefined && (typeof body.config !== 'object' || body.config === null)) throw new HttpError(400, "'config' must be an object.");
            const source = await folderOf(body);
            temp = source.temp;
            const folderKey = temp ? `upload:${typeof body.name === 'string' ? body.name : ''}` : source.root;
            if (running >= maxRuns) throw new HttpError(429, 'Too many runs in progress, try again shortly.');
            running++;
            try {
                const available = (await nuxmvInfo(options.runner)).available;
                const ctx = await changeContext(source.root, {
                    config: body.config as ProvenflowConfig | undefined,
                    checker: available ? smv => runNuxmv(smv, { engine: 'bdd' }, options.runner) : undefined,
                    analyzers: body.analyzers !== false,
                    previous: previousRuns.get(folderKey)
                });
                const result = kind === 'fix' ? await fixWithLlm(ctx, finding, provider!) : await verifyVersion(ctx, finding, changed as Array<{ file: string; after: string }>);
                res.json(result);
            } finally {
                running--;
            }
        } catch (error) {
            next(error);
        } finally {
            if (temp) await rm(temp, { recursive: true, force: true });
        }
    };
    app.post('/api/fix', express.json({ limit: '64mb' }), singleChange('fix'));
    app.post('/api/verify-change', express.json({ limit: '64mb' }), singleChange('verify'));

    /** GET /api/extract/runs/<id>: follows a streamed analysis again (NDJSON), or collects its report. */
    app.get('/api/extract/runs/:id', (req: Request, res: Response) => {
        const run = runs.get(String(req.params['id']));
        if (!run) {
            res.status(404).json({ error: 'This analysis is not known to the server (it was restarted, or the report expired): run it again.' });
            return;
        }
        runs.attach(run, res);
    });

    /**
     * POST /api/apply { root, file, before, after }: writes a reviewed change to a file of a folder this
     * server analysed by path. Refused when the file changed since the analysis (409).
     */
    app.post('/api/apply', express.json({ limit: '16mb' }), async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!options.allowLocalPaths) throw new HttpError(403, 'This server does not write files (it is not bound to localhost): download the changed file instead.');
            const body = (req.body ?? {}) as { root?: unknown; file?: unknown; before?: unknown; after?: unknown };
            if (typeof body.root !== 'string' || typeof body.file !== 'string' || typeof body.before !== 'string' || typeof body.after !== 'string') throw new HttpError(400, "Provide 'root', 'file', 'before' and 'after'.");
            const root = resolve(body.root);
            if (!analysedRoots.has(root)) throw new HttpError(403, `${root} was not analysed by this server since it started: run the analysis again, then apply.`, { code: 'not-analysed' });
            const target = resolve(root, body.file);
            const inside = relative(root, target);
            if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new HttpError(400, `Invalid file ${body.file}.`);
            const current = await readFile(target, 'utf8').catch(() => undefined);
            if (current === undefined) throw new HttpError(404, `No file ${body.file} in ${root}.`);
            if (current !== body.before) throw new HttpError(409, `${body.file} changed since the analysis: run the analysis again before applying.`);
            await writeFile(target, body.after, 'utf8');
            res.json({ ok: true, file: body.file });
        } catch (error) {
            next(error);
        }
    });

    /** GET /api/llm-settings: the LLM settings with the keys masked. */
    app.get('/api/llm-settings', (_req, res) => {
        res.json({ ...settings.public(), editable: !!options.allowLocalPaths });
    });

    /** PUT /api/llm-settings: keys, models and addresses (a server on this computer only). */
    app.put('/api/llm-settings', async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!options.allowLocalPaths) throw new HttpError(403, 'This server is not on this computer: set the LLM keys in its environment instead.');
            try {
                await settings.update((req.body ?? {}) as UpdateInput);
            } catch (error) {
                throw new HttpError(400, (error as Error).message);
            }
            res.json({ ...settings.public(), editable: true });
        } catch (error) {
            next(error);
        }
    });

    /** POST /api/llm-settings/test { provider }: a one-line request, to check the key and the model. */
    app.post('/api/llm-settings/test', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const kind = (req.body as { provider?: unknown } | undefined)?.provider;
            if (kind !== 'anthropic' && kind !== 'openai' && kind !== 'ollama') throw new HttpError(400, "'provider' must be anthropic, openai or ollama.");
            const spec = settings.spec(kind as LlmKind);
            const started = Date.now();
            try {
                const provider = providerFromSpec(spec, settings.providerEnv());
                const answer = await Promise.race([
                    provider.complete('Answer with one word.', 'Reply with the word OK.'),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer within 30 s')), 30_000))
                ]);
                res.json({ ok: true, spec, answer: answer.trim().slice(0, 80), ms: Date.now() - started });
            } catch (error) {
                res.json({ ok: false, spec, error: (error as Error).message.slice(0, 400) });
            }
        } catch (error) {
            next(error);
        }
    });

    /**
     * POST /api/apply-edits { root, changes: [{ id, edits: [{ file, search, replace }] }] }: applies
     * several changes in order, each on top of the previous ones. A change whose edits no longer match
     * the current text is skipped ("conflict"); the others are written. Only in folders analysed by path.
     */
    app.post('/api/apply-edits', express.json({ limit: '16mb' }), async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!options.allowLocalPaths) throw new HttpError(403, 'This server does not write files (it is not bound to localhost): download the changed files instead.');
            const body = (req.body ?? {}) as { root?: unknown; changes?: unknown };
            if (typeof body.root !== 'string' || !Array.isArray(body.changes)) throw new HttpError(400, "Provide 'root' and 'changes'.");
            const root = resolve(body.root);
            if (!analysedRoots.has(root)) throw new HttpError(403, `${root} was not analysed by this server since it started: run the analysis again, then apply.`, { code: 'not-analysed' });
            const texts = new Map<string, string | undefined>();
            const target = (file: string) => {
                const path = resolve(root, file);
                const inside = relative(root, path);
                if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new HttpError(400, `Invalid file ${file}.`);
                return path;
            };
            const current = async (file: string) => {
                if (!texts.has(file)) texts.set(file, await readFile(target(file), 'utf8').catch(() => undefined));
                return texts.get(file);
            };
            const results: Array<{ id: string; status: 'applied' | 'conflict'; message?: string }> = [];
            const written = new Set<string>();
            for (const change of body.changes as Array<{ id?: unknown; edits?: unknown }>) {
                const id = String(change.id ?? results.length);
                const edits = Array.isArray(change.edits) ? (change.edits as Array<{ file?: unknown; search?: unknown; replace?: unknown }>) : [];
                const pending = new Map<string, string>();
                let conflict: string | undefined;
                for (const e of edits) {
                    if (typeof e.file !== 'string' || typeof e.search !== 'string' || typeof e.replace !== 'string') {
                        conflict = 'invalid edit';
                        break;
                    }
                    const text = pending.get(e.file) ?? (await current(e.file));
                    if (text === undefined && e.search === '') {
                        pending.set(e.file, e.replace);
                        continue;
                    }
                    if (isApplied(text, { file: e.file, search: e.search, replace: e.replace })) {
                        conflict = `This change is already in ${e.file}: it was not applied a second time.`;
                        break;
                    }
                    if (text === undefined || text.split(e.search).length !== 2) {
                        conflict = `${e.file} no longer contains the text this change replaces (another change or an edit touched it): run the analysis again for an up-to-date proposal.`;
                        break;
                    }
                    const replacement = e.replace;
                    pending.set(e.file, text.replace(e.search, () => replacement));
                }
                if (conflict || pending.size === 0) {
                    results.push({ id, status: 'conflict', message: conflict ?? 'nothing to change' });
                    continue;
                }
                for (const [file, text] of pending) {
                    texts.set(file, text);
                    written.add(file);
                }
                results.push({ id, status: 'applied' });
            }
            for (const file of written) {
                const path = target(file);
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, texts.get(file)!, 'utf8');
            }
            res.json({ results, files: [...written] });
        } catch (error) {
            next(error);
        }
    });

    /**
     * POST /api/verify
     *   { model: "<nuXmv model>" }            run a model as is, or
     *   { diagram: "<.pflow source>" }          generate the model from a diagram first
     *   engine?: "bdd" | "bmc" | "ic3", bound?: number
     */
    app.post('/api/verify', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const body = (req.body ?? {}) as { model?: unknown; diagram?: unknown; engine?: unknown; bound?: unknown };
            const engine = (body.engine ?? 'bdd') as Engine;
            if (!ENGINES.includes(engine)) throw new HttpError(400, `Unknown engine '${String(body.engine)}'. Use one of ${ENGINES.join(', ')}.`);
            if (body.bound !== undefined && (typeof body.bound !== 'number' || !Number.isFinite(body.bound))) {
                throw new HttpError(400, "'bound' must be a number.");
            }

            let model: string;
            if (typeof body.model === 'string') {
                model = body.model;
            } else if (typeof body.diagram === 'string') {
                const parsed = await parseDiagram(body.diagram);
                if (parsed.hasErrors) {
                    throw new HttpError(422, 'The diagram has errors.', parsed.diagnostics.filter(d => d.severity === 'error'));
                }
                model = generateSmv(parsed.model).text;
            } else {
                throw new HttpError(400, "Provide either 'model' (nuXmv text) or 'diagram' (.pflow text).");
            }

            if (running >= maxRuns) throw new HttpError(429, 'nuXmv is busy, try again in a moment.');
            running++;
            try {
                const result = await runNuxmv(model, { engine, bound: body.bound as number | undefined }, options.runner);
                res.json({ model, ...result });
            } finally {
                running--;
            }
        } catch (error) {
            next(error);
        }
    });

    // ------------------------------------------------------------------
    // Live link: a running Python state machine (EditorLink) posts each state
    // change; editors subscribed to the same channel receive it over SSE.
    // ------------------------------------------------------------------
    const channels = new Map<string, { clients: Set<Response>; commandClients: Set<Response>; last?: string }>();
    const channel = (name: string) => {
        if (!/^[\w-]{1,64}$/.test(name)) throw new HttpError(400, 'Channel names are 1-64 letters, digits, _ or -.');
        let c = channels.get(name);
        if (!c) channels.set(name, (c = { clients: new Set(), commandClients: new Set() }));
        return c;
    };

    /** Tells the editors of a channel how many machines listen for commands (0: none is running). */
    const broadcastStatus = (c: { clients: Set<Response>; commandClients: Set<Response> }) => {
        const status = JSON.stringify({ machines: c.commandClients.size });
        for (const client of c.clients) client.write(`event: status\ndata: ${status}\n\n`);
    };

    app.post('/api/live/:channel', (req: Request, res: Response, next: NextFunction) => {
        try {
            const c = channel(String(req.params['channel']));
            const body = (req.body ?? {}) as Record<string, unknown>;
            if (typeof body['state'] !== 'string') throw new HttpError(400, "'state' (string) is required.");
            const update = JSON.stringify({ ...body, receivedAt: Date.now() });
            c.last = update;
            for (const client of c.clients) client.write(`data: ${update}\n\n`);
            res.json({ ok: true, listeners: c.clients.size });
        } catch (error) {
            next(error);
        }
    });

    // Two-way link: the editor sends events to the running machine (it applies them with send(),
    // so only transitions of the verified model can happen).
    app.post('/api/live/:channel/command', (req: Request, res: Response, next: NextFunction) => {
        try {
            const c = channel(String(req.params['channel']));
            const body = (req.body ?? {}) as Record<string, unknown>;
            if (typeof body['event'] !== 'string' || !/^[\w :()-]{1,128}$/.test(body['event'])) throw new HttpError(400, "'event' (string) is required.");
            const command = JSON.stringify({ event: body['event'], ...(body['values'] && typeof body['values'] === 'object' ? { values: body['values'] } : {}), sentAt: Date.now() });
            for (const client of c.commandClients) client.write(`data: ${command}\n\n`);
            res.json({ ok: true, listeners: c.commandClients.size });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/live/:channel/commands', (req: Request, res: Response, next: NextFunction) => {
        let c;
        try {
            c = channel(String(req.params['channel']));
        } catch (error) {
            next(error);
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        c.commandClients.add(res);
        broadcastStatus(c);
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        req.on('close', () => {
            clearInterval(keepAlive);
            c.commandClients.delete(res);
            broadcastStatus(c);
        });
    });

    app.get('/api/live/:channel/stream', (req: Request, res: Response, next: NextFunction) => {
        let c;
        try {
            c = channel(String(req.params['channel']));
        } catch (error) {
            next(error);
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        // The last update of the channel, marked as replayed: it may come from a process that has ended.
        if (c.last) res.write(`data: ${JSON.stringify({ ...JSON.parse(c.last), replayed: true })}\n\n`);
        res.write(`event: status\ndata: ${JSON.stringify({ machines: c.commandClients.size })}\n\n`);
        c.clients.add(res);
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        req.on('close', () => {
            clearInterval(keepAlive);
            c.clients.delete(res);
        });
    });

    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) {
        const dir = options.staticDir;
        // Bundles have content hashes and can be cached; index.html must always be
        // revalidated so a rebuilt app is picked up on the next page load.
        app.use(
            express.static(dir, {
                index: 'index.html',
                maxAge: '1h',
                setHeaders: (res, path) => {
                    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
                }
            })
        );
        app.get(/^\/(?!api\/).*/, (_req, res) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(join(dir, 'index.html'));
        });
    }

    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (error instanceof HttpError) {
            res.status(error.status).json({ error: error.message, details: error.details });
        } else if (error instanceof GenerationError) {
            res.status(422).json({ error: error.message });
        } else if (error instanceof SyntaxError && 'body' in error) {
            res.status(400).json({ error: 'Invalid JSON body.' });
        } else {
            const message = error instanceof Error ? error.message : String(error);
            const notFound = /not found/.test(message);
            res.status(notFound ? 503 : 500).json({ error: message });
        }
    });

    return app;
}
