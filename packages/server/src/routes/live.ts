/**
 * Live link: a running Python state machine (EditorLink) posts each state change; editors subscribed
 * to the same channel receive it over Server-Sent Events. Two-way: the editor sends events to the
 * running machine, which applies them with send(), so only transitions of the verified model happen.
 *
 * POST /api/live/<channel>             a state update { state, event?, step?, values?, violations? }
 * GET  /api/live/<channel>/stream      the updates (the last one first, marked as replayed)
 * POST /api/live/<channel>/command     { event, values? } for the running machine
 * GET  /api/live/<channel>/commands    the commands, read by link_editor(..., commands=True)
 */
import type { Express, NextFunction, Request, Response } from 'express';
import { HttpError, route } from '../context.js';

interface Channel {
    clients: Set<Response>;
    commandClients: Set<Response>;
    last?: string;
}

export function registerLiveRoutes(app: Express): void {
    const channels = new Map<string, Channel>();
    const channel = (name: string): Channel => {
        if (!/^[\w-]{1,64}$/.test(name)) throw new HttpError(400, 'Channel names are 1-64 letters, digits, _ or -.');
        let c = channels.get(name);
        if (!c) channels.set(name, (c = { clients: new Set(), commandClients: new Set() }));
        return c;
    };
    app.post('/api/live/:channel', route((req, res) => postUpdate(channel(String(req.params['channel'])), req, res)));
    app.post('/api/live/:channel/command', route((req, res) => postCommand(channel(String(req.params['channel'])), req, res)));
    app.get('/api/live/:channel/commands', (req: Request, res: Response, next: NextFunction) => subscribe(() => channel(String(req.params['channel'])), 'commands', req, res, next));
    app.get('/api/live/:channel/stream', (req: Request, res: Response, next: NextFunction) => subscribe(() => channel(String(req.params['channel'])), 'updates', req, res, next));
}

function postUpdate(c: Channel, req: Request, res: Response): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body['state'] !== 'string') throw new HttpError(400, "'state' (string) is required.");
    const update = JSON.stringify({ ...body, receivedAt: Date.now() });
    c.last = update;
    for (const client of c.clients) client.write(`data: ${update}\n\n`);
    res.json({ ok: true, listeners: c.clients.size });
}

function postCommand(c: Channel, req: Request, res: Response): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body['event'] !== 'string' || !/^[\w :()-]{1,128}$/.test(body['event'])) throw new HttpError(400, "'event' (string) is required.");
    const values = body['values'] && typeof body['values'] === 'object' ? { values: body['values'] } : {};
    const command = JSON.stringify({ event: body['event'], ...values, sentAt: Date.now() });
    for (const client of c.commandClients) client.write(`data: ${command}\n\n`);
    res.json({ ok: true, listeners: c.commandClients.size });
}

/** Tells the editors of a channel how many machines listen for commands (0: none is running). */
function broadcastStatus(c: Channel): void {
    const status = JSON.stringify({ machines: c.commandClients.size });
    for (const client of c.clients) client.write(`event: status\ndata: ${status}\n\n`);
}

/** An SSE subscription: an editor to the updates, or a running machine to the commands. */
function subscribe(channelOf: () => Channel, kind: 'updates' | 'commands', req: Request, res: Response, next: NextFunction): void {
    let c: Channel;
    try {
        c = channelOf();
    } catch (error) {
        next(error);
        return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const set = kind === 'commands' ? c.commandClients : c.clients;
    if (kind === 'updates') {
        // The last update of the channel, marked as replayed: it may come from a process that has ended.
        if (c.last) res.write(`data: ${JSON.stringify({ ...JSON.parse(c.last), replayed: true })}\n\n`);
        res.write(`event: status\ndata: ${JSON.stringify({ machines: c.commandClients.size })}\n\n`);
    }
    set.add(res);
    if (kind === 'commands') broadcastStatus(c);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
        clearInterval(keepAlive);
        set.delete(res);
        if (kind === 'commands') broadcastStatus(c);
    });
}
