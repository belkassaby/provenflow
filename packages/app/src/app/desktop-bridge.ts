import { Component, inject, Injectable, input, output } from '@angular/core';
import { EXAMPLES } from '@provenflow/language';
import { SaveTarget, type SavedFile } from './file-io';
import { IDE_HOSTS, ParentFrameHost } from './host-frame';

/** A file the desktop application opened (File → Open…, a double-click in the file manager, the command line). */
export interface DesktopFile {
    name: string;
    path: string;
    text: string;
    kind: 'diagram' | 'c4';
    /** A model extracted from code, to check at once (its counterexamples show). */
    check?: boolean;
}

/** What the editor tells its host when it is ready: the examples its Examples menu has. */
export interface EditorInfo {
    examples: Array<{ id: string; title: string; group: string; description: string }>;
}

/** How the editor opens each kind of file the desktop application or VS Code sends it. */
export interface FileOpeners {
    diagram(file: DesktopFile): void;
    /** A model extracted from code, to check at once. */
    model(file: DesktopFile): void;
    c4(file: DesktopFile): void;
}

/**
 * What the desktop application's preload script exposes (packages/desktop/src/preload.cts), and the
 * VS Code extension through the frame it shows the editor in (host-frame.ts).
 */
export interface DesktopApi {
    platform: string;
    onCommand(callback: (command: string) => void): () => void;
    onOpenFile(callback: (file: DesktopFile) => void): () => void;
    /** A folder whose projects to map in the C4 tab (VS Code). */
    onMapC4?(callback: (path: string) => void): () => void;
    /** The host's theme, which the editor follows (VS Code). */
    onTheme?(callback: (theme: 'light' | 'dark') => void): () => void;
    /** The editor listens; `info` tells the host what its menus can offer (the examples). */
    ready(info?: EditorInfo): void;
    /** A message for the host to show (an IDE: the editor shows no message bar of its own there). */
    notify?(text: string): void;
    /** A file saved or exported, for the host to write (an IDE: no browser downloads there). */
    saveFile?(file: SavedFile): void;
    pickFolder(title?: string): Promise<string | null>;
    setTheme?(theme: 'light' | 'dark'): void;
}

/**
 * The editor running inside the desktop application (Electron) or a VS Code tab rather than a
 * browser: the native menus or the extension send it commands, the files the user opens with them
 * come in, and folders can be chosen with the system's dialog. In a browser `available` is false and
 * nothing happens.
 */
@Injectable({ providedIn: 'root' })
export class DesktopBridge {
    private readonly api = (globalThis as { provenflowDesktop?: DesktopApi }).provenflowDesktop ?? (typeof window === 'undefined' ? undefined : ParentFrameHost.fromPage(window));
    readonly available = !!this.api;
    readonly platform = this.api?.platform ?? 'web';
    /** In an IDE tab (VS Code, JetBrains): the IDE shows the menus, the messages and the saved files. */
    readonly embedded = (IDE_HOSTS as readonly string[]).includes(this.platform);

    constructor() {
        const save = this.api?.saveFile;
        if (save) SaveTarget.set(file => save.call(this.api, file));
    }

    /**
     * Runs the menu commands (`name` or `name:argument`), and opens the files: from now on (and those
     * waiting since the start).
     */
    connect(commands: Record<string, (arg?: string) => void>, open: FileOpeners, mapC4?: (path: string) => void): void {
        if (!this.api) return;
        this.api.onCommand(command => {
            const colon = command.indexOf(':');
            const [name, arg] = colon < 0 ? [command, undefined] : [command.slice(0, colon), command.slice(colon + 1)];
            commands[name]?.(arg);
        });
        this.api.onOpenFile(file => (file.kind === 'c4' ? open.c4(file) : file.check ? open.model(file) : open.diagram(file)));
        if (mapC4) this.api.onMapC4?.(mapC4);
        this.api.ready({ examples: EXAMPLES.map(e => ({ id: e.id, title: e.title, group: e.group, description: e.description })) });
    }

    /** Shows a message in the host, when it shows the editor's messages (an IDE). */
    notify(text: string): void {
        this.api?.notify?.(text);
    }

    /** Follows the host's theme, when it has one to follow (VS Code). */
    followTheme(apply: (theme: 'light' | 'dark') => void): void {
        this.api?.onTheme?.(apply);
    }

    pickFolder(title?: string): Promise<string | null> {
        return this.api ? this.api.pickFolder(title) : Promise.resolve(null);
    }

    /** The window's frame and native menus follow the editor's theme. */
    setTheme(theme: 'light' | 'dark'): void {
        this.api?.setTheme?.(theme);
    }
}

/** "Browse…" next to a folder path: the system's folder dialog, in the desktop application only. */
@Component({
    selector: 'app-folder-browse',
    template: `@if (desktop.available) {
        <button type="button" (click)="browse()" [title]="title()">Browse…</button>
    }`
})
export class FolderBrowse {
    readonly desktop = inject(DesktopBridge);
    readonly title = input('Choose a folder');
    readonly picked = output<string>();

    async browse(): Promise<void> {
        const folder = await this.desktop.pickFolder(this.title());
        if (folder) this.picked.emit(folder);
    }
}
