import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { GenerationError } from '@provenflow/language';
import { createContext, HttpError, type AppOptions } from './context.js';
import { registerAnalysisRoutes } from './routes/analysis.js';
import { registerApplyRoutes } from './routes/apply.js';
import { registerLiveRoutes } from './routes/live.js';
import { registerModelRoutes } from './routes/models.js';

export type { AppOptions } from './context.js';

/** Routes that read their (larger) bodies themselves: code bases and changes. */
const OWN_BODY = ['/api/extract', '/api/apply', '/api/apply-edits', '/api/fix', '/api/verify-change'];

/** The ProvenFlow server: the REST API (routes/), the built editor, and the error responses. */
export function createApp(options: AppOptions): express.Express {
    const app = express();
    app.disable('x-powered-by');
    const json = express.json({ limit: '2mb' });
    app.use((req, res, next) => (OWN_BODY.includes(req.path) ? next() : json(req, res, next)));
    const ctx = createContext(options);
    registerModelRoutes(app, ctx);
    registerAnalysisRoutes(app, ctx);
    registerApplyRoutes(app, ctx);
    registerLiveRoutes(app);
    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });
    if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) serveEditor(app, options.staticDir);
    app.use(errorHandler);
    return app;
}

/** The built editor. Bundles have content hashes and can be cached; index.html is always revalidated. */
function serveEditor(app: express.Express, dir: string): void {
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

function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
    if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, details: error.details });
    } else if (error instanceof GenerationError) {
        res.status(422).json({ error: error.message });
    } else if (error instanceof SyntaxError && 'body' in error) {
        res.status(400).json({ error: 'Invalid JSON body.' });
    } else {
        const message = error instanceof Error ? error.message : String(error);
        res.status(/not found/.test(message) ? 503 : 500).json({ error: message });
    }
}
