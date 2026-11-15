/**
 * The editor window: the local server's page in a sandboxed renderer (no Node, context isolation),
 * kept on that page (links elsewhere open in the browser), with its size and place remembered.
 */
import { join } from 'node:path';
import { BrowserWindow, screen, shell, type WebContents } from 'electron';
import { DEFAULT_SIZE, loadWindowState, saveWindowState, visibleBounds } from './window-state.js';

export interface WindowOptions {
    url: string;
    preload: string;
    stateFile: string;
    icon?: string;
}

export function createWindow(options: WindowOptions): BrowserWindow {
    const state = loadWindowState(options.stateFile);
    const bounds = visibleBounds(
        state.bounds,
        screen.getAllDisplays().map(d => d.workArea)
    );
    const win = new BrowserWindow({
        ...(bounds ?? DEFAULT_SIZE),
        minWidth: 720,
        minHeight: 480,
        show: false,
        title: 'ProvenFlow',
        backgroundColor: '#eef1f5',
        ...(options.icon ? { icon: options.icon } : {}),
        webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    });
    if (state.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    keepOnOrigin(win.webContents, new URL(options.url).origin);
    rememberBounds(win, options.stateFile);
    void win.loadURL(options.url);
    return win;
}

/** Only the local editor runs in the window: other pages open in the user's browser. */
function keepOnOrigin(contents: WebContents, origin: string): void {
    const external = (url: string) => {
        if (/^https?:\/\//.test(url) && new URL(url).origin !== origin) void shell.openExternal(url);
    };
    contents.setWindowOpenHandler(({ url }) => {
        external(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        if (new URL(url).origin === origin) return;
        event.preventDefault();
        external(url);
    });
}

function rememberBounds(win: BrowserWindow, file: string): void {
    win.on('close', () => saveWindowState(file, { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() }));
}

/** Where the preload script is, next to the compiled main process. */
export function preloadPath(dir: string): string {
    return join(dir, 'preload.cjs');
}
