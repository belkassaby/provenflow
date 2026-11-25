/**
 * The ProvenFlow editor in VS Code tabs: a tab per document (a model, the C4 architecture of a
 * folder, a .pflow or .dsl file), each a webview showing the editor `pflow serve` runs. Opening a
 * document again shows its tab. Messages to the editor wait until it says it listens.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { editorPageHtml } from './editor-page';
import type { EditorExample } from './editor-menu';
import type { EditorServerProcess } from './editor-server';

/** What the extension sends the editor (packages/app/src/app/host-frame.ts reads it). */
export type EditorMessage =
    | { provenflow: 'command'; command: string }
    | { provenflow: 'folder'; id: number; path: string | null }
    | { provenflow: 'theme'; theme: 'light' | 'dark' }
    | { provenflow: 'open-file'; file: { name: string; path: string; text: string; kind: 'diagram' | 'c4'; check?: boolean } }
    | { provenflow: 'map-c4'; path: string };

export interface EditorDocument {
    /** The tab's identity: the same key shows the same tab. */
    key: string;
    title: string;
    /** The file it shows, when it shows a file of the workspace (Save writes it). */
    path?: string;
    /** What to open in it, once the editor listens (none: an empty editor). */
    message?: EditorMessage;
}

/** A file the editor saves or exports (packages/app/src/app/file-io.ts). */
export interface SavedFile {
    name: string;
    content: string;
    encoding: 'text' | 'base64';
    type: string;
}

/** What the extension does with what an editor tab asks for. */
export interface EditorHost {
    /** The editor is ready, and lists the examples its menu offers. */
    ready(examples: EditorExample[]): void;
    save(document: EditorDocument, file: SavedFile): Promise<void>;
    notify(text: string): void;
}

/** The pflow to run and the folder to run it in, for the editor's server. */
export type ServerLauncher = () => Promise<{ cli: string; cwd: string } | undefined>;

type FromEditor = { provenflow?: string; id?: number; title?: string; examples?: EditorExample[]; text?: string; file?: SavedFile };

class EditorTab {
    private listening = false;
    private waiting: EditorMessage[] = [];

    constructor(
        readonly panel: vscode.WebviewPanel,
        readonly document: EditorDocument,
        url: string,
        private readonly host: EditorHost
    ) {
        panel.webview.html = editorPageHtml(url, randomBytes(16).toString('base64'));
        panel.webview.onDidReceiveMessage((message: FromEditor) => void this.received(message));
    }

    send(message: EditorMessage): void {
        if (this.listening) void this.panel.webview.postMessage(message);
        else this.waiting.push(message);
    }

    sendTheme(): void {
        const kind = vscode.window.activeColorTheme.kind;
        const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
        this.send({ provenflow: 'theme', theme: light ? 'light' : 'dark' });
    }

    private async received(message: FromEditor): Promise<void> {
        switch (message.provenflow) {
            case 'ready':
                this.listening = true;
                this.sendTheme();
                this.waiting.forEach(m => void this.panel.webview.postMessage(m));
                this.waiting = [];
                this.host.ready(message.examples ?? []);
                break;
            case 'pick-folder': {
                const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: message.title ?? 'Choose a folder' });
                this.send({ provenflow: 'folder', id: message.id ?? 0, path: picked?.[0]?.fsPath ?? null });
                break;
            }
            case 'save-file':
                if (message.file) await this.host.save(this.document, message.file);
                break;
            case 'notify':
                if (message.text) this.host.notify(message.text);
        }
    }
}

export class EditorPanels implements vscode.Disposable {
    private readonly tabs = new Map<string, EditorTab>();
    private readonly themeWatch = vscode.window.onDidChangeActiveColorTheme(() => this.tabs.forEach(tab => tab.sendTheme()));
    /** The ProvenFlow tab last in front: the one the menu's commands act on. */
    private front?: string;

    constructor(
        private readonly server: EditorServerProcess,
        private readonly launcher: ServerLauncher,
        private readonly icon: vscode.Uri,
        private readonly host: EditorHost
    ) {}

    /** Sends a command to the ProvenFlow tab in front; false when no ProvenFlow tab is open. */
    sendToFront(message: EditorMessage): boolean {
        const tab = this.front ? this.tabs.get(this.front) : undefined;
        tab?.panel.reveal();
        tab?.send(message);
        return !!tab;
    }

    /** Shows the document's tab, opening it (and the editor's server) when needed. */
    async open(document: EditorDocument): Promise<void> {
        const open = this.tabs.get(document.key);
        if (open) {
            open.panel.reveal();
            if (document.message) open.send(document.message);
            return;
        }
        const url = await this.serverUrl();
        if (!url) return;
        const panel = vscode.window.createWebviewPanel('provenflow.editor', document.title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        panel.iconPath = this.icon;
        const tab = new EditorTab(panel, document, url, this.host);
        this.tabs.set(document.key, tab);
        this.front = document.key;
        panel.onDidChangeViewState(e => e.webviewPanel.active && (this.front = document.key));
        panel.onDidDispose(() => {
            this.tabs.delete(document.key);
            if (this.front === document.key) this.front = undefined;
        });
        if (document.message) tab.send(document.message);
    }

    dispose(): void {
        this.tabs.forEach(tab => tab.panel.dispose());
        this.tabs.clear();
        this.themeWatch.dispose();
        this.server.dispose();
    }

    private async serverUrl(): Promise<string | undefined> {
        const launch = await this.launcher();
        if (!launch) return undefined;
        try {
            return await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Starting the ProvenFlow editor' }, () => this.server.url(launch.cli, launch.cwd));
        } catch (error) {
            void vscode.window.showErrorMessage(`ProvenFlow: the editor could not start. ${(error as Error).message} Is the editor built (npm run build)?`);
            return undefined;
        }
    }
}
