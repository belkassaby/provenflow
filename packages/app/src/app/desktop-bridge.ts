import { Component, inject, Injectable, input, output } from '@angular/core';
import { ParentFrameHost } from './host-frame';

/** A file the desktop application opened (File → Open…, a double-click in the file manager, the command line). */
export interface DesktopFile {
    name: string;
    path: string;
    text: string;
    kind: 'diagram' | 'c4';
    /** A model extracted from code, to check at once (its counterexamples show). */
    check?: boolean;
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
    ready(): void;
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

    /** Runs the menu commands, and opens the files: from now on (and those waiting since the start). */
    connect(commands: Record<string, () => void>, open: FileOpeners, mapC4?: (path: string) => void): void {
        if (!this.api) return;
        this.api.onCommand(command => commands[command]?.());
        this.api.onOpenFile(file => (file.kind === 'c4' ? open.c4(file) : file.check ? open.model(file) : open.diagram(file)));
        if (mapC4) this.api.onMapC4?.(mapC4);
        this.api.ready();
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
