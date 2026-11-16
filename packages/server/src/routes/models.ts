/**
 * Model checking and settings:
 *
 * GET /api/health: nuXmv, NuRV and what the code review may do here.
 * POST /api/verify { model: "<nuXmv model>" } or { diagram: "<.pflow source>" }, engine?, bound?:
 *   runs nuXmv (BDD, BMC or IC3).
 * POST /api/nurv { diagram }: NuRV-generated full-LTL monitors (sources + build commands).
 * GET/PUT /api/llm-settings, POST /api/llm-settings/test { provider }: the LLM keys, models and
 *   addresses (writable only on a server bound to localhost; keys masked when read).
 */
import type { Express, Request, Response } from 'express';
import { providerFromSpec } from '@provenflow/extract';
import { generateSmv, parseDiagram } from '@provenflow/language';
import type { LlmKind, UpdateInput } from '../llm-settings.js';
import { nurvAvailable, runNurv } from '../nurv-runner.js';
import { ENGINES, nuxmvInfo, runNuxmv, type Engine } from '../nuxmv-runner.js';
import { bodyOf, HttpError, inSlot, route, type ServerContext } from '../context.js';

export function registerModelRoutes(app: Express, ctx: ServerContext): void {
    app.get('/api/health', route(async (_req, res) => {
        res.json({ ok: true, nuxmv: await nuxmvInfo(ctx.options.runner), nurv: { available: nurvAvailable(ctx.options.nurv) }, extract: { paths: !!ctx.options.allowLocalPaths, apply: !!ctx.options.allowLocalPaths, llm: ctx.settings.configured() } });
    }));
    app.post('/api/verify', route((req, res) => verify(ctx, req, res)));
    app.post('/api/nurv', route((req, res) => nurv(ctx, req, res)));
    app.get('/api/llm-settings', (_req: Request, res: Response) => {
        res.json({ ...ctx.settings.public(), editable: !!ctx.options.allowLocalPaths });
    });
    app.put('/api/llm-settings', route((req, res) => updateSettings(ctx, req, res)));
    app.post('/api/llm-settings/test', route((req, res) => testProvider(ctx, req, res)));
}

/** The nuXmv model of a request: given as is, or generated from a diagram. */
async function modelOf(body: { model?: unknown; diagram?: unknown }): Promise<string> {
    if (typeof body.model === 'string') return body.model;
    if (typeof body.diagram !== 'string') throw new HttpError(400, "Provide either 'model' (nuXmv text) or 'diagram' (.pflow text).");
    const parsed = await parseDiagram(body.diagram);
    if (parsed.hasErrors) throw new HttpError(422, 'The diagram has errors.', parsed.diagnostics.filter(d => d.severity === 'error'));
    return generateSmv(parsed.model).text;
}

async function verify(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    const body = bodyOf<{ model: string; diagram: string; engine: Engine; bound: number }>(req);
    const engine = (body.engine ?? 'bdd') as Engine;
    if (!ENGINES.includes(engine)) throw new HttpError(400, `Unknown engine '${String(body.engine)}'. Use one of ${ENGINES.join(', ')}.`);
    if (body.bound !== undefined && (typeof body.bound !== 'number' || !Number.isFinite(body.bound))) throw new HttpError(400, "'bound' must be a number.");
    const model = await modelOf(body);
    const result = await inSlot(ctx, 'nuXmv is busy, try again in a moment.', () => runNuxmv(model, { engine, bound: body.bound as number | undefined }, ctx.options.runner));
    res.json({ model, ...result });
}

async function nurv(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    const executable = ctx.options.nurv;
    if (!executable || !nurvAvailable(executable)) throw new HttpError(503, 'NuRV is not configured: set NURV_PATH to the NuRV executable (https://es-static.fbk.eu/tools/nurv/).');
    const body = bodyOf<{ diagram: string }>(req);
    if (typeof body.diagram !== 'string') throw new HttpError(400, "Provide 'diagram' (.pflow text).");
    const parsed = await parseDiagram(body.diagram);
    if (parsed.hasErrors) throw new HttpError(422, 'The diagram has errors.', parsed.diagnostics.filter(d => d.severity === 'error'));
    const result = await runNurv(parsed.model, executable);
    res.json({ files: result.files, monitors: result.monitors, build: result.build });
}

async function updateSettings(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    if (!ctx.options.allowLocalPaths) throw new HttpError(403, 'This server is not on this computer: set the LLM keys in its environment instead.');
    try {
        await ctx.settings.update((req.body ?? {}) as UpdateInput);
    } catch (error) {
        throw new HttpError(400, (error as Error).message);
    }
    res.json({ ...ctx.settings.public(), editable: true });
}

/** A one-line request, to check the key and the model. */
async function testProvider(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    const kind = bodyOf<{ provider: LlmKind }>(req).provider;
    if (kind !== 'anthropic' && kind !== 'openai' && kind !== 'ollama') throw new HttpError(400, "'provider' must be anthropic, openai or ollama.");
    const spec = ctx.settings.spec(kind);
    const started = Date.now();
    try {
        const provider = providerFromSpec(spec, ctx.settings.providerEnv());
        const answer = await Promise.race([provider.complete('Answer with one word.', 'Reply with the word OK.'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer within 30 s')), 30_000))]);
        res.json({ ok: true, spec, answer: answer.trim().slice(0, 80), ms: Date.now() - started });
    } catch (error) {
        res.json({ ok: false, spec, error: (error as Error).message.slice(0, 400) });
    }
}
