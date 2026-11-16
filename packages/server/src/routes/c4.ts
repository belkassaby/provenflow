/**
 * The C4 map of a code base's projects:
 *
 * POST /api/c4/discover { path, scan?: [folders], owners?: [names], depth? }: the projects around the
 *   folder with the same owner, how they depend on each other, what each is made of (a C4 model),
 *   where code belongs (suggestions), and the folder's own C4 model if it has one (`existing`, with
 *   the discovered projects merged in). Folders are read by path: only on a server bound to localhost.
 * POST /api/c4/save { path, file, text }: writes a model (Structurizr DSL) into a folder discovered
 *   or analysed since the server started.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { mapProjects } from '@provenflow/extract';
import { bodyOf, folderOf, HttpError, inSlot, route, writableFile, type ServerContext } from '../context.js';

interface DiscoverBody {
    path: string;
    scan: string[];
    owners: string[];
    depth: number;
}

function strings(value: unknown, name: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new HttpError(400, `'${name}' must be a list of strings.`);
    return value as string[];
}

export function registerC4Routes(app: Express, ctx: ServerContext): void {
    app.post('/api/c4/discover', express.json({ limit: '1mb' }), route((req, res) => discover(ctx, req, res)));
    app.post('/api/c4/save', express.json({ limit: '16mb' }), route((req, res) => save(ctx, req, res)));
}

async function discover(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    const body = bodyOf<DiscoverBody>(req);
    if (typeof body.path !== 'string') throw new HttpError(400, "Provide 'path': the folder of the code base (the server reads the folders around it).");
    const { root } = await folderOf(ctx, { path: body.path });
    const scan = strings(body.scan, 'scan');
    if (scan?.some(s => !isAbsolute(s))) throw new HttpError(400, "'scan' folders must be absolute paths.");
    const depth = body.depth === undefined ? undefined : Number(body.depth);
    if (depth !== undefined && !(depth >= 1 && depth <= 4)) throw new HttpError(400, "'depth' must be 1 to 4.");
    const map = await inSlot(ctx, 'Too many runs in progress, try again shortly.', async () => mapProjects(root, { scan, owners: strings(body.owners, 'owners'), depth }));
    // Mapped by path: the model may be saved into it.
    ctx.analysedRoots.add(root);
    res.json(map);
}

async function save(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    const body = bodyOf<{ path: string; file: string; text: string }>(req);
    if (typeof body.path !== 'string' || typeof body.file !== 'string' || typeof body.text !== 'string') throw new HttpError(400, "Provide 'path', 'file' and 'text'.");
    if (!/\.(dsl|json|puml|mmd|md)$/.test(body.file)) throw new HttpError(400, 'Only .dsl, .json, .puml, .mmd and .md files are written.');
    const target = writableFile(ctx, body.path, body.file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body.text, 'utf8');
    res.json({ written: target });
}
