/**
 * Writing reviewed changes into a folder this server analysed by path (never an uploaded copy):
 *
 * POST /api/apply { root, file, before, after }: one file; refused when the file changed since the
 *   analysis (409).
 * POST /api/apply-edits { root, changes: [{ id, edits: [{ file, search, replace }] }] }: several
 *   changes in order, each on top of the previous ones. A change whose edits no longer match the
 *   current text is skipped ("conflict"); the others are written.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { isApplied } from '@provenflow/extract';
import { analysedRoot, bodyOf, HttpError, route, writableFile, type ServerContext } from '../context.js';

export function registerApplyRoutes(app: Express, ctx: ServerContext): void {
    app.post('/api/apply', express.json({ limit: '16mb' }), route((req, res) => applyFile(ctx, req, res)));
    app.post('/api/apply-edits', express.json({ limit: '16mb' }), route((req, res) => applyEdits(ctx, req, res)));
}

function mayWrite(ctx: ServerContext, what: string): void {
    if (!ctx.options.allowLocalPaths) throw new HttpError(403, `This server does not write files (it is not bound to localhost): download the changed ${what} instead.`);
}

async function applyFile(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    mayWrite(ctx, 'file');
    const body = bodyOf<{ root: string; file: string; before: string; after: string }>(req);
    if (typeof body.root !== 'string' || typeof body.file !== 'string' || typeof body.before !== 'string' || typeof body.after !== 'string') throw new HttpError(400, "Provide 'root', 'file', 'before' and 'after'.");
    const target = writableFile(ctx, body.root, body.file);
    const current = await readFile(target, 'utf8').catch(() => undefined);
    if (current === undefined) throw new HttpError(404, `No file ${body.file} in ${body.root}.`);
    if (current !== body.before) throw new HttpError(409, `${body.file} changed since the analysis: run the analysis again before applying.`);
    await writeFile(target, body.after, 'utf8');
    res.json({ ok: true, file: body.file });
}

interface Edit {
    file?: unknown;
    search?: unknown;
    replace?: unknown;
}

async function applyEdits(ctx: ServerContext, req: Request, res: Response): Promise<void> {
    mayWrite(ctx, 'files');
    const body = bodyOf<{ root: string; changes: Array<{ id?: unknown; edits?: unknown }> }>(req);
    if (typeof body.root !== 'string' || !Array.isArray(body.changes)) throw new HttpError(400, "Provide 'root' and 'changes'.");
    const root = analysedRoot(ctx, body.root);
    const texts = new Map<string, string | undefined>();
    const current = async (file: string) => {
        if (!texts.has(file)) texts.set(file, await readFile(writableFile(ctx, root, file), 'utf8').catch(() => undefined));
        return texts.get(file);
    };
    const results: Array<{ id: string; status: 'applied' | 'conflict'; message?: string }> = [];
    const written = new Set<string>();
    for (const change of body.changes as Array<{ id?: unknown; edits?: unknown }>) {
        const id = String(change.id ?? results.length);
        const outcome = await applyChange(Array.isArray(change.edits) ? (change.edits as Edit[]) : [], current);
        if (typeof outcome === 'string') {
            results.push({ id, status: 'conflict', message: outcome });
            continue;
        }
        for (const [file, text] of outcome) {
            texts.set(file, text);
            written.add(file);
        }
        results.push({ id, status: 'applied' });
    }
    for (const file of written) {
        const path = writableFile(ctx, root, file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, texts.get(file)!, 'utf8');
    }
    res.json({ results, files: [...written] });
}

/** The new texts of the files one change edits, or why it cannot be applied. */
async function applyChange(edits: Edit[], current: (file: string) => Promise<string | undefined>): Promise<Map<string, string> | string> {
    const pending = new Map<string, string>();
    for (const e of edits) {
        if (typeof e.file !== 'string' || typeof e.search !== 'string' || typeof e.replace !== 'string') return 'invalid edit';
        const text = pending.get(e.file) ?? (await current(e.file));
        const next = applyEdit(text, { file: e.file, search: e.search, replace: e.replace });
        if (!next.ok) return next.conflict;
        pending.set(e.file, next.text);
    }
    return pending.size ? pending : 'nothing to change';
}

function applyEdit(text: string | undefined, e: { file: string; search: string; replace: string }): { ok: true; text: string } | { ok: false; conflict: string } {
    if (text === undefined && e.search === '') return { ok: true, text: e.replace };
    if (isApplied(text, e)) return { ok: false, conflict: `This change is already in ${e.file}: it was not applied a second time.` };
    if (text === undefined || text.split(e.search).length !== 2) return { ok: false, conflict: `${e.file} no longer contains the text this change replaces (another change or an edit touched it): run the analysis again for an up-to-date proposal.` };
    return { ok: true, text: text.replace(e.search, () => e.replace) };
}
