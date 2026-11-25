/** What the routes of the server share: options, run slots, the last analysis of each folder, errors. */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { providerFromSpec, type PreviousRun } from '@provenflow/extract';
import { ExtractRuns } from './extract-runs.js';
import { LlmSettingsStore } from './llm-settings.js';
import type { RunnerConfig } from './nuxmv-runner.js';

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

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown
    ) {
        super(message);
    }
}

export interface ServerContext {
    readonly options: AppOptions;
    readonly runs: ExtractRuns;
    /** The last run of each folder (a path, or an uploaded folder by name), for incremental re-runs. */
    readonly previousRuns: Map<string, PreviousRun>;
    /**
     * The analysis a single change (POST /api/fix, /api/verify-change) was checked against, for a folder
     * this server did not analyse itself (the IDEs analyse with pflow extract): kept for the next change.
     */
    readonly changeBaselines: Map<string, PreviousRun>;
    /** Folders analysed by path: the only places /api/apply may write to. */
    readonly analysedRoots: Set<string>;
    readonly settings: LlmSettingsStore;
    /** Analyses and nuXmv runs in progress, against maxConcurrentRuns. */
    running: number;
}

export function createContext(options: AppOptions): ServerContext {
    return { options, runs: new ExtractRuns(options.heartbeatMs), previousRuns: new Map(), changeBaselines: new Map(), analysedRoots: new Set(), settings: options.llmSettings ?? new LlmSettingsStore(), running: 0 };
}

/** Runs `work` in one of the run slots, or refuses with 429 when all are taken. */
export async function inSlot<T>(ctx: ServerContext, busy: string, work: () => Promise<T>): Promise<T> {
    if (ctx.running >= (ctx.options.maxConcurrentRuns ?? 2)) throw new HttpError(429, busy);
    ctx.running++;
    try {
        return await work();
    } finally {
        ctx.running--;
    }
}

/** An async route whose errors go to the error handler. */
export function route(handler: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve()
            .then(() => handler(req, res))
            .catch(next);
    };
}

/** The folder a request is about: a path of this machine, or uploaded files (written to a temporary folder). */
export async function folderOf(ctx: ServerContext, body: { path?: unknown; files?: unknown }): Promise<{ root: string; temp?: string }> {
    if (typeof body.path === 'string') return { root: await localFolder(ctx, body.path) };
    if (body.files && typeof body.files === 'object' && !Array.isArray(body.files)) return uploadedFolder(Object.entries(body.files as Record<string, unknown>));
    throw new HttpError(400, "Provide 'path' (a folder on the server) or 'files' (uploaded sources).");
}

async function localFolder(ctx: ServerContext, path: string): Promise<string> {
    if (!ctx.options.allowLocalPaths) throw new HttpError(403, 'This server does not read folders by path (it is not bound to localhost): upload the folder instead.');
    if (!isAbsolute(path)) throw new HttpError(400, "'path' must be an absolute folder path.");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) throw new HttpError(404, `No folder at ${path}.`);
    return resolve(path);
}

async function uploadedFolder(entries: Array<[string, unknown]>): Promise<{ root: string; temp: string }> {
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

/** The key of a folder's last run: its path, or the uploaded folder's name. */
export function folderKey(source: { root: string; temp?: string }, name: unknown): string {
    return source.temp ? `upload:${typeof name === 'string' ? name : ''}` : source.root;
}

export function providerOf(ctx: ServerContext, spec: unknown) {
    if (spec === undefined) return undefined;
    if (typeof spec !== 'string' || !/^(anthropic|openai|ollama):[\w.:/-]*$/.test(spec)) throw new HttpError(400, "'llm' must be anthropic:<model>, openai:<model> or ollama:<model>.");
    try {
        return providerFromSpec(spec, ctx.settings.providerEnv());
    } catch (error) {
        throw new HttpError(400, (error as Error).message);
    }
}

/** A folder this server analysed by path (the only folders changes may be written to). */
export function analysedRoot(ctx: ServerContext, rootPath: string): string {
    const root = resolve(rootPath);
    if (!ctx.analysedRoots.has(root)) throw new HttpError(403, `${root} was not analysed by this server since it started: run the analysis again, then apply.`, { code: 'not-analysed' });
    return root;
}

/** A file inside an analysed folder (refused when the folder was not analysed by path, or the file is outside it). */
export function writableFile(ctx: ServerContext, rootPath: string, file: string): string {
    const root = analysedRoot(ctx, rootPath);
    const target = resolve(root, file);
    const inside = relative(root, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new HttpError(400, `Invalid file ${file}.`);
    return target;
}

/** The body of a request as an object (an empty one when there is none). */
export function bodyOf<T>(req: Request): Partial<Record<keyof T, unknown>> {
    return (req.body ?? {}) as Partial<Record<keyof T, unknown>>;
}
