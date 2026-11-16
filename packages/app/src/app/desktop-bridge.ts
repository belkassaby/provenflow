import { Component, inject, Injectable, input, output } from '@angular/core';

/** A file the desktop application opened (File → Open…, a double-click in the file manager, the command line). */
export interface DesktopFile {
    name: string;
    path: string;
    text: string;
    kind: 'diagram' | 'c4';
}

/** What the desktop application's preload script exposes (packages/desktop/src/preload.cts). */
interface DesktopApi {
    platform: string;
    onCommand(callback: (command: string) => void): () => void;
    onOpenFile(callback: (file: DesktopFile) => void): () => void;
    ready(): void;
    pickFolder(title?: string): Promise<string | null>;
    setTheme?(theme: 'light' | 'dark'): void;
}

/**
 * The editor running inside the desktop application (Electron) rather than a browser: the native
 * menus send it commands, the files the user opens with the application come in, and folders can
 * be chosen with the system's dialog. In a browser `available` is false and nothing happens.
 */
@Injectable({ providedIn: 'root' })
export class DesktopBridge {
    private readonly api = (globalThis as { provenflowDesktop?: DesktopApi }).provenflowDesktop;
    readonly available = !!this.api;
    readonly platform = this.api?.platform ?? 'web';

    /** Runs the menu commands, and opens the files: from now on (and those waiting since the start). */
    connect(commands: Record<string, () => void>, open: (file: DesktopFile) => void): void {
        if (!this.api) return;
        this.api.onCommand(command => commands[command]?.());
        this.api.onOpenFile(open);
        this.api.ready();
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
