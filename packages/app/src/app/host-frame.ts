import type { DesktopApi, DesktopFile } from './desktop-bridge';

/**
 * The editor inside an IDE tab: the VS Code extension shows it in a frame of a webview, the
 * JetBrains plugin in a frame of a JCEF browser; the page around the frame passes messages between
 * the IDE and the editor. The IDE sends menu-like commands, models and C4 workspaces to open,
 * folders to map and its theme; the editor says when it listens and asks for a folder (the IDE's
 * dialog). Each message is `{ provenflow: <type>, ... }`;
 * the IDEs' side is packages/vscode/src/editor-page.ts and packages/jetbrains/.../EditorPage.kt.
 */
type HostMessage =
    | { provenflow: 'command'; command: string }
    | { provenflow: 'open-file'; file: DesktopFile }
    | { provenflow: 'map-c4'; path: string }
    | { provenflow: 'theme'; theme: 'light' | 'dark' }
    | { provenflow: 'folder'; id: number; path: string | null };

type Listener = (message: HostMessage) => void;

/** The values of the `host` query parameter the IDEs add to the editor's address. */
export const IDE_HOSTS = ['vscode', 'jetbrains'] as const;

export class ParentFrameHost implements DesktopApi {
    private readonly listeners = new Set<Listener>();
    private readonly folderRequests = new Map<number, (path: string | null) => void>();
    private nextRequest = 1;

    /** Messages are taken from the frame's parent only. */
    constructor(
        private readonly parent: Pick<Window, 'postMessage'>,
        events: Pick<Window, 'addEventListener'>,
        readonly platform: string = IDE_HOSTS[0]
    ) {
        events.addEventListener('message', event => {
            if (event.source === parent && isHostMessage(event.data)) this.receive(event.data);
        });
    }

    /** The host of an editor opened by an IDE (`?host=vscode` or `?host=jetbrains`, inside a frame); undefined elsewhere. */
    static fromPage(page: Window): ParentFrameHost | undefined {
        const framed = page.parent && page.parent !== page;
        const host = new URLSearchParams(page.location.search).get('host') ?? '';
        return framed && (IDE_HOSTS as readonly string[]).includes(host) ? new ParentFrameHost(page.parent, page, host) : undefined;
    }

    onCommand(callback: (command: string) => void): () => void {
        return this.on(m => m.provenflow === 'command' && callback(m.command));
    }

    onOpenFile(callback: (file: DesktopFile) => void): () => void {
        return this.on(m => m.provenflow === 'open-file' && callback(m.file));
    }

    onMapC4(callback: (path: string) => void): () => void {
        return this.on(m => m.provenflow === 'map-c4' && callback(m.path));
    }

    onTheme(callback: (theme: 'light' | 'dark') => void): () => void {
        return this.on(m => m.provenflow === 'theme' && callback(m.theme));
    }

    ready(): void {
        this.parent.postMessage({ provenflow: 'ready' }, '*');
    }

    pickFolder(title?: string): Promise<string | null> {
        const id = this.nextRequest++;
        return new Promise(resolve => {
            this.folderRequests.set(id, resolve);
            this.parent.postMessage({ provenflow: 'pick-folder', id, title }, '*');
        });
    }

    /** The IDE chooses the theme: the editor's toggle changes this tab only. */
    setTheme(): void {
        // Nothing to tell the extension.
    }

    private on(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private receive(message: HostMessage): void {
        if (message.provenflow === 'folder') {
            this.folderRequests.get(message.id)?.(message.path);
            this.folderRequests.delete(message.id);
            return;
        }
        this.listeners.forEach(listener => listener(message));
    }
}

function isHostMessage(data: unknown): data is HostMessage {
    return typeof data === 'object' && data !== null && typeof (data as { provenflow?: unknown }).provenflow === 'string';
}
