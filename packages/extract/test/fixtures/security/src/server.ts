import { exec } from 'child_process';

interface Request { query: Record<string, string>; body: Record<string, string> }
interface Response { send(text: string): void }

export function listFiles(req: Request, res: Response): void {
    exec('ls ' + req.query.dir, (_error, stdout) => res.send(stdout));
}

export function render(el: { innerHTML: string }, html: string): void {
    el.innerHTML = html;
}

export const apiKey = 'sk_live_4f9a8b7c6d5e4f3a2b1c';

export const agentOptions = { rejectUnauthorized: false };
