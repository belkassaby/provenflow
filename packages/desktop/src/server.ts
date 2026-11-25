/**
 * The ProvenFlow server inside the desktop application: the same Express app as the web version,
 * bound to loopback on a free port, serving the built editor (see startEditorServer).
 */
import { startEditorServer, type EditorServer } from '@provenflow/server';

export type RunningServer = EditorServer;

export function startServer(uiDir: string): Promise<RunningServer> {
    return startEditorServer({ staticDir: uiDir });
}
