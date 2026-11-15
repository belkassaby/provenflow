/**
 * Analysis of a code base and one change at a time:
 *
 * POST /api/extract: models of a code base, verified (pflow extract).
 *   { path: "/abs/folder" }                   a folder on this machine (allowLocalPaths), or
 *   { files: { "src/a.ts": "...", ... } }     uploaded sources (and provenflow.config.json, package.json)
 *   config?: provenflow.config.json contents (default: the one in the folder)
 *   quickFixes?: number of verified quick fixes to propose (default 20, 0: none)
 *   llm?: "anthropic:<model>" | "openai:<model>" | "ollama:<model>", llmFixes?: number (keys come from the server's environment)
 *   incremental?: true to redo only what the files changed since the last run of this folder can
 *     affect (after applying changes); name?: the uploaded folder's name, to find its last run
 *   analyzers?: false to skip the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani) and the replay on the code
 *   checks?: { select?: [ids], skip?: [ids] }: the catalogue entries to check, over the config's "checks"
 * With `Accept: application/x-ndjson` the response streams one JSON object per line while it runs:
 * { run: id }, { progress: { phase, message, percent } }... (the current one again every 15 s),
 * then { result } or { error }. The analysis goes on if the connection drops:
 * GET /api/extract/runs/<id> follows it again.
 *
 * One change for one finding, checked like the automatic fixes (re-run of the analysis on the
 * changed files, build or type check on a copy). The folder is given as for /api/extract
 * (`path`, or `files` and `name`); its last run on this server is the reference.
 *   POST /api/fix { finding, llm }: the LLM implements the finding's suggested fix;
 *   POST /api/fix { finding, how: 'analysis' }: the fix the analysis makes itself (a verified quick
 *     fix), or a draft with the suggested fix as a comment where the code has to change;
 *   POST /api/verify-change { finding, changed: [{ file, after }] }: verifies the reviewer's version.
 * Both answer { finding } (with its suggestedPatch: the files before/after, the diff, verified and
 * why), and `error` when there was nothing to check. With `Accept: application/x-ndjson` they
 * stream { event } lines first: { type: 'stage' | 'thinking' | 'text' | 'usage' | 'note', ... }.
 * Every LLM call is also logged by the server, with its token usage.
 *
 * GET /api/catalogue: the patterns and practices catalogue ({ entries }), each entry explained in
 * the form of Fowler's "Writing Software Patterns", with the rules that check it.
 */
import { rm } from 'node:fs/promises';
import express, { type Express, type Request, type Response } from 'express';
import { CATALOGUE, changeContext, extractProject, fixWithLlm, fixWithoutLlm, logged, verifyVersion, webReport, type ChangeEvent, type ChangeContext, type Finding, type ChecksConfig, type LlmProvider, type ProvenflowConfig } from '@provenflow/extract';
import { nuxmvInfo, runNuxmv } from '../nuxmv-runner.js';
import { bodyOf, folderKey, folderOf, HttpError, inSlot, providerOf, route, type ServerContext } from '../context.js';

const BUSY = 'Too many runs in progress, try again shortly.';
const streamed = (req: Request) => /application\/x-ndjson/.test(req.headers.accept ?? '');

export function registerAnalysisRoutes(app: Express, ctx: ServerContext): void {
    app.get('/api/catalogue', (_req: Request, res: Response) => {
        res.json({ entries: CATALOGUE });
    });
    app.post('/api/extract', express.json({ limit: '64mb' }), route((req, res) => extract(ctx, req, res)));
    app.post('/api/fix', express.json({ limit: '64mb' }), route((req, res) => singleChange(ctx, 'fix', req, res)));
    app.post('/api/verify-change', express.json({ limit: '64mb' }), route((req, res) => singleChange(ctx, 'verify', req, res)));
    /** GET /api/extract/runs/<id>: follows a streamed analysis again (NDJSON), or collects its report. */
    app.get('/api/extract/runs/:id', (req: Request, res: Response) => {
        const run = ctx.runs.get(String(req.params['id']));
        if (run) ctx.runs.attach(run, res);
        else res.status(404).json({ error: 'This analysis is not known to the server (it was restarted, or the report expired): run it again.' });
    });
}

/** nuXmv when it is installed; otherwise the explicit-state checker. */
async function checkerOf(ctx: ServerContext) {
    const available = (await nuxmvInfo(ctx.options.runner)).available;
    return available ? (smv: string) => runNuxmv(smv, { engine: 'bdd' }, ctx.options.runner) : undefined;
}

interface ExtractBody {
    path: string;
    files: Record<string, string>;
    config: ProvenflowConfig;
    quickFixes: number;
    llm: string;
    llmFixes: number;
    analyzers: boolean;
    incremental: boolean;
    name: string;
    checks: ChecksConfig;
}

function counts(body: Partial<Record<keyof ExtractBody, unknown>>): { quickFixes: number; llmFixes: number } {
    const quickFixes = body.quickFixes === undefined ? 20 : Number(body.quickFixes);
    const llmFixes = body.llmFixes === undefined ? 5 : Number(body.llmFixes);
    if (!Number.isFinite(quickFixes) || quickFixes < 0 || !Number.isFinite(llmFixes) || llmFixes < 0) throw new HttpError(400, "'quickFixes' and 'llmFixes' must be numbers >= 0.");
    return { quickFixes, llmFixes };
}

function checkChecks(checks: unknown): ChecksConfig | undefined {
    if (checks === undefined) return undefined;
    const list = (x: unknown) => x === undefined || (Array.isArray(x) && x.every(id => typeof id === 'string'));
    const c = checks as Record<string, unknown>;
    if (typeof checks !== 'object' || checks === null || !list(c['select']) || !list(c['skip'])) throw new HttpError(400, "'checks' must be { select?: string[], skip?: string[] }.");
    return checks as ChecksConfig;
}

function checkConfig(config: unknown): ProvenflowConfig | undefined {
    if (config !== undefined && (typeof config !== 'object' || config === null)) throw new HttpError(400, "'config' must be an object.");
    return config as ProvenflowConfig | undefined;
}

async function extract(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    const body = bodyOf<ExtractBody>(req);
    const { quickFixes, llmFixes } = counts(body);
    const llm = providerOf(ctx, body.llm);
    const source = await folderOf(ctx, body);
    try {
        const config = checkConfig(body.config);
        const checks = checkChecks(body.checks);
        await inSlot(ctx, BUSY, () => analyse(ctx, req, res, { source, key: folderKey(source, body.name), config, checks, quickFixes, llmFixes, llm, analyzers: body.analyzers !== false, incremental: body.incremental === true }));
    } finally {
        if (source.temp) await rm(source.temp, { recursive: true, force: true });
    }
}

interface Analysis {
    source: { root: string; temp?: string };
    key: string;
    config?: ProvenflowConfig;
    checks?: ChecksConfig;
    quickFixes: number;
    llmFixes: number;
    llm?: LlmProvider;
    analyzers: boolean;
    incremental: boolean;
}

async function analyse(ctx: ServerContext, req: Request, res: Response, a: Analysis): Promise<void> {
    // A streamed analysis goes on if the connection drops; the browser follows it again by its id.
    const run = streamed(req) ? ctx.runs.create() : undefined;
    if (run) ctx.runs.attach(run, res);
    const { root, temp } = a.source;
    try {
        const result = await extractProject(root, {
            previous: a.incremental ? ctx.previousRuns.get(a.key) : undefined,
            config: a.config,
            checks: a.checks,
            checker: await checkerOf(ctx),
            quickFixes: Math.min(100, a.quickFixes),
            llm: a.llm ? logged(a.llm, line => console.log(line), `analysis of ${root}`) : undefined,
            llmFixes: a.llm ? Math.min(20, a.llmFixes) : 0,
            analyzers: a.analyzers,
            confirm: a.analyzers,
            onProgress: run ? progress => ctx.runs.progress(run, progress) : undefined
        });
        if (!temp) ctx.analysedRoots.add(root);
        ctx.previousRuns.set(a.key, result.previous);
        const report = { ...(webReport(result) as object), root: temp ? '(uploaded folder)' : root, applicable: !temp && !!ctx.options.allowLocalPaths };
        if (run) ctx.runs.finish(run, { result: report });
        else res.json(report);
    } catch (error) {
        if (!run) throw error;
        ctx.runs.finish(run, { error: (error as Error).message });
    }
}

interface ChangeBody {
    path: string;
    files: Record<string, string>;
    name: string;
    config: ProvenflowConfig;
    finding: Finding;
    llm: string;
    how: string;
    changed: Array<{ file: string; after: string }>;
    analyzers: boolean;
}

/** What a single-change request asks for, checked. */
interface ChangeRequest {
    finding: Finding;
    provider?: LlmProvider;
    byAnalysis: boolean;
    changed?: Array<{ file: string; after: string }>;
}

function changeRequest(ctx: ServerContext, kind: 'fix' | 'verify', body: Partial<Record<keyof ChangeBody, unknown>>): ChangeRequest {
    const finding = body.finding as Finding | undefined;
    if (!finding || typeof finding !== 'object' || typeof finding.rule !== 'string' || typeof finding.subject !== 'string') throw new HttpError(400, "Provide the 'finding' to change.");
    if (kind === 'verify') {
        const changed = body.changed;
        if (!Array.isArray(changed) || changed.length === 0 || changed.some(c => typeof c?.file !== 'string' || typeof c?.after !== 'string')) throw new HttpError(400, "Provide 'changed': [{ file, after }].");
        return { finding, byAnalysis: false, changed };
    }
    if (body.how === 'analysis') return { finding, byAnalysis: true };
    const provider = providerOf(ctx, body.llm);
    if (!provider) throw new HttpError(400, "Provide 'llm' (anthropic:<model>, openai:<model> or ollama:<model>), or how: 'analysis' for the fix without an LLM.");
    return { finding, provider, byAnalysis: false };
}

async function singleChange(ctx: ServerContext, kind: 'fix' | 'verify', req: Request, res: Response): Promise<void> {
    const body = bodyOf<ChangeBody>(req);
    const asked = changeRequest(ctx, kind, body);
    const config = checkConfig(body.config);
    const source = await folderOf(ctx, body);
    try {
        const key = folderKey(source, body.name);
        const options = { config, checker: await checkerOf(ctx), analyzers: body.analyzers !== false, previous: ctx.previousRuns.get(key) };
        await inSlot(ctx, BUSY, () =>
            respond(req, res, async onEvent => {
                onEvent({ type: 'stage', text: options.previous ? 'Preparing the check (from the last analysis of this folder)…' : 'Analysing the folder first (the server has no analysis of it since it started)…' });
                const change = await changeContext(source.root, options);
                return makeChange(change, asked, options, onEvent);
            })
        );
    } finally {
        if (source.temp) await rm(source.temp, { recursive: true, force: true });
    }
}

function makeChange(change: ChangeContext, asked: ChangeRequest, options: Parameters<typeof fixWithoutLlm>[2], onEvent: (e: ChangeEvent) => void) {
    if (asked.byAnalysis) return fixWithoutLlm(change, asked.finding, options, onEvent);
    if (asked.provider) return fixWithLlm(change, asked.finding, logged(asked.provider, line => console.log(line), `fix ${asked.finding.rule} on ${asked.finding.subject}`), onEvent);
    return verifyVersion(change, asked.finding, asked.changed!, 'your version', onEvent);
}

/**
 * Answers with the result of `work`: as JSON, or (with `Accept: application/x-ndjson`) as a stream of
 * { event } lines, the last event again every 15 s, then { result } or { error }.
 */
async function respond(req: Request, res: Response, work: (onEvent: (e: ChangeEvent) => void) => Promise<unknown>): Promise<void> {
    if (!streamed(req)) {
        res.json(await work(() => undefined));
        return;
    }
    const write = (line: unknown) => {
        if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(line)}\n`);
    };
    let last: ChangeEvent | undefined;
    const heartbeat = setInterval(() => write({ event: last ?? { type: 'stage', text: 'Working…' }, heartbeat: true }), 15_000);
    res.status(200).setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.flushHeaders();
    try {
        write({
            result: await work(event => {
                if (event.type === 'stage' || event.type === 'usage') last = event;
                write({ event });
            })
        });
    } catch (error) {
        write({ error: (error as Error).message });
    } finally {
        clearInterval(heartbeat);
        res.end();
    }
}
