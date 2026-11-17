/**
 * The ProvenFlow editor in VS Code tabs: a tab per document (a model, the C4 architecture of a
 * folder, a .pflow or .dsl file), each a webview showing the editor `pflow serve` runs. Opening a
 * document again shows its tab. Messages to the editor wait until it says it listens.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { editorPageHtml } from './editor-page';
import type { EditorServerProcess } from './editor-server';

/** What the extension sends the editor (packages/app/src/app/host-frame.ts reads it). */
export type EditorMessage =
    | { provenflow: 'command'; command: string }
    | { provenflow: 'open-file'; file: { name: string; path: string; text: string; kind: 'diagram' | 'c4'; check?: boolean } }
    | { provenflow: 'map-c4'; path: string };

export interface EditorDocument {
    /** The tab's identity: the same key shows the same tab. */
    key: string;
    title: string;
    /** What to open in it, once the editor listens (none: an empty editor). */
    message?: EditorMessage;
}

/** The pflow to run and the folder to run it in, for the editor's server. */
export type ServerLauncher = () => Promise<{ cli: string; cwd: string } | undefined>;

class EditorTab {
    private listening = false;
    private waiting: unknown[] = [];

    constructor(
        readonly panel: vscode.WebviewPanel,
        url: string
    ) {
        panel.webview.html = editorPageHtml(url, randomBytes(16).toString('base64'));
        panel.webview.onDidReceiveMessage(message => void this.received(message));
    }

    send(message: unknown): void {
        if (this.listening) void this.panel.webview.postMessage(message);
        else this.waiting.push(message);
    }

    sendTheme(): void {
        const kind = vscode.window.activeColorTheme.kind;
        const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
        this.send({ provenflow: 'theme', theme: light ? 'light' : 'dark' });
    }

    private async received(message: { provenflow?: string; id?: number; title?: string }): Promise<void> {
        if (message.provenflow === 'ready') {
            this.listening = true;
            this.sendTheme();
            this.waiting.forEach(m => void this.panel.webview.postMessage(m));
            this.waiting = [];
        } else if (message.provenflow === 'pick-folder') {
            const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: message.title ?? 'Choose a folder' });
            this.send({ provenflow: 'folder', id: message.id, path: picked?.[0]?.fsPath ?? null });
        }
    }
}

export class EditorPanels implements vscode.Disposable {
    private readonly tabs = new Map<string, EditorTab>();
    private readonly themeWatch = vscode.window.onDidChangeActiveColorTheme(() => this.tabs.forEach(tab => tab.sendTheme()));

    constructor(
        private readonly server: EditorServerProcess,
        private readonly launcher: ServerLauncher,
        private readonly icon: vscode.Uri
    ) {}

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
        const tab = new EditorTab(panel, url);
        this.tabs.set(document.key, tab);
        panel.onDidDispose(() => this.tabs.delete(document.key));
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
