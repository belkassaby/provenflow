/**
 * ProvenFlow desktop: the editor and its server in one application for macOS, Windows and Linux.
 * The server (the same one `npm start` runs for the web version) listens on a free loopback port;
 * the window shows its page, with native menus, a folder picker for code bases, and the files
 * the user opens with the application (.pflow diagrams, C4 workspaces).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import { filesFromArgv, OPEN_FILTERS, readOpenable, type OpenedFile } from './files.js';
import { menuTemplate, type DesktopCommand } from './menu.js';
import { startServer, type RunningServer } from './server.js';
import { loginShellPath, mergePath } from './shell-path.js';
import { createWindow, preloadPath } from './window.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The built editor: next to the application when packaged (see scripts/stage.mjs), else in the repository. */
const UI_DIR = [resolve(here, '../ui'), resolve(here, '../../app/dist/app/browser')].find(d => existsSync(join(d, 'index.html'))) ?? resolve(here, '../ui');
const ICON = [resolve(here, '../build/icon.png'), resolve(here, '../icon.png')].find(p => existsSync(p));

/** The running application: its server, its window, and the files waiting for the editor to listen. */
class DesktopApp {
    private server?: RunningServer;
    private win?: BrowserWindow;
    /** Files to open once the editor listens (opened before it loaded, or before the app was ready). */
    private pending: string[] = filesFromArgv(process.argv, process.cwd());
    private rendererReady = false;

    start(): void {
        process.env['PATH'] = mergePath(process.env['PATH'], loginShellPath(process.platform));
        app.setName('ProvenFlow');
        app.setAboutPanelOptions({ applicationName: 'ProvenFlow', applicationVersion: app.getVersion(), copyright: 'MIT License', credits: 'Design and verify state machines with nuXmv, and review code.' });
        app.on('second-instance', (_event, argv, cwd) => {
            this.openPaths(filesFromArgv(argv, cwd));
            this.focus();
        });
        // macOS: a file dropped on the Dock icon or opened from Finder (also before the app is ready).
        app.on('open-file', (event, path) => {
            event.preventDefault();
            this.openPaths([path]);
        });
        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') app.quit();
        });
        app.on('activate', () => {
            if (!this.win || this.win.isDestroyed()) this.showWindow();
        });
        app.on('will-quit', () => void this.server?.close());
        this.listen();
        void app.whenReady().then(() => this.ready());
    }

    /** What the editor's page asks: it is ready for files; a folder chosen in the system's dialog. */
    private listen(): void {
        ipcMain.on('provenflow:ready', event => {
            if (event.sender !== this.win?.webContents) return;
            this.rendererReady = true;
            this.flushPending();
        });
        ipcMain.handle('provenflow:pick-folder', (event, title: unknown) => this.pickFolder(event, typeof title === 'string' ? title : undefined));
    }

    private async ready(): Promise<void> {
        try {
            this.server = await startServer(UI_DIR);
        } catch (error) {
            dialog.showErrorBox('ProvenFlow could not start', (error as Error).message);
            app.quit();
            return;
        }
        const actions = { command: (c: DesktopCommand) => this.send(c), openFile: () => void this.openDialog(), openExternal: (url: string) => void shell.openExternal(url), about: () => this.about() };
        Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, 'ProvenFlow', actions)));
        this.showWindow();
    }

    private showWindow(): void {
        if (!this.server) return;
        this.rendererReady = false;
        this.win = createWindow({ url: this.server.url, preload: preloadPath(here), stateFile: join(app.getPath('userData'), 'window-state.json'), icon: ICON });
        this.win.webContents.on('did-start-loading', () => {
            this.rendererReady = false;
        });
    }

    private focus(): void {
        if (!this.win || this.win.isDestroyed()) return this.showWindow();
        if (this.win.isMinimized()) this.win.restore();
        this.win.focus();
    }

    private send(command: DesktopCommand): void {
        this.win?.webContents.send('provenflow:command', command);
    }

    private openPaths(paths: string[]): void {
        this.pending = [...this.pending, ...paths];
        if (this.rendererReady) this.flushPending();
    }

    private flushPending(): void {
        const paths = this.pending;
        this.pending = [];
        for (const path of paths) this.deliver(readOpenable(path));
    }

    private deliver(result: OpenedFile | { error: string }): void {
        if ('error' in result) {
            if (this.win) void dialog.showMessageBox(this.win, { type: 'warning', message: result.error });
            return;
        }
        app.addRecentDocument(result.path);
        this.win?.webContents.send('provenflow:open-file', result);
    }

    private async openDialog(): Promise<void> {
        if (!this.win) return;
        const choice = await dialog.showOpenDialog(this.win, { title: 'Open a diagram or a C4 workspace', properties: ['openFile'], filters: OPEN_FILTERS });
        if (!choice.canceled && choice.filePaths[0]) this.deliver(readOpenable(choice.filePaths[0], true));
    }

    /** A native folder picker, for the code base to analyse or map (only for the editor's own page). */
    private async pickFolder(event: IpcMainInvokeEvent, title: string | undefined): Promise<string | null> {
        if (!this.win || event.sender !== this.win.webContents) return null;
        const choice = await dialog.showOpenDialog(this.win, { title: title ?? 'Choose a folder', properties: ['openDirectory'] });
        return choice.canceled ? null : (choice.filePaths[0] ?? null);
    }

    private about(): void {
        if (!this.win) return;
        void dialog.showMessageBox(this.win, { type: 'info', title: 'About ProvenFlow', message: `ProvenFlow ${app.getVersion()}`, detail: `Design and verify state machines with nuXmv, and review code.\nElectron ${process.versions.electron}, Node.js ${process.versions.node}, Chromium ${process.versions.chrome}.` });
    }
}

if (!app.requestSingleInstanceLock()) app.quit();
else new DesktopApp().start();
