/**
 * The application menu, in the shape desktop editors share (VS Code's): the app menu on macOS, then
 * File, Edit, View, Window and Help. Items that act on the editor send it a command; the others
 * use Electron's roles. Built from plain data so that it can be checked without Electron running.
 */
import type { MenuItemConstructorOptions } from 'electron';

/** What the editor does when a menu item is chosen (see the app's DesktopBridge). */
export type DesktopCommand =
    | 'new-diagram'
    | 'save'
    | 'import-code'
    | 'c4'
    | 'export-png'
    | 'export-svg'
    | 'export-smv'
    | 'export-python'
    | 'export-notebook'
    | 'check'
    | 'simulate'
    | 'llm-settings'
    | 'help-guide'
    | 'help-walkthroughs';

export interface MenuActions {
    /** Sends a command to the editor. */
    command(command: DesktopCommand): void;
    /** File → Open…: a native dialog for a diagram or a C4 workspace. */
    openFile(): void;
    openExternal(url: string): void;
    /** Help → About (Windows and Linux; macOS has its own About panel). */
    about(): void;
}

export const DOCS_URL = 'https://github.com/belkassaby/provenflow#readme';
export const ISSUES_URL = 'https://github.com/belkassaby/provenflow/issues';

export function menuTemplate(platform: NodeJS.Platform, appName: string, actions: MenuActions): MenuItemConstructorOptions[] {
    const send = (command: DesktopCommand) => () => actions.command(command);
    return [...(platform === 'darwin' ? [appMenu(appName, send)] : []), fileMenu(platform, actions, send), editMenu(), viewMenu(), verifyMenu(send), windowMenu(platform), helpMenu(platform, actions, send)];
}

type Send = (command: DesktopCommand) => () => void;

function appMenu(appName: string, send: Send): MenuItemConstructorOptions {
    return {
        label: appName,
        submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: send('llm-settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }]
    };
}

function fileMenu(platform: NodeJS.Platform, actions: MenuActions, send: Send): MenuItemConstructorOptions {
    // On macOS, Settings and Quit are in the app menu.
    const last: MenuItemConstructorOptions[] = platform === 'darwin' ? [{ role: 'close' }] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: send('llm-settings') }, { type: 'separator' }, { role: 'quit' }];
    return {
        label: '&File',
        submenu: [
            { label: 'New Diagram', accelerator: 'CmdOrCtrl+N', click: send('new-diagram') },
            { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => actions.openFile() },
            { type: 'separator' },
            { label: 'Import Code Base…', accelerator: 'CmdOrCtrl+Shift+I', click: send('import-code') },
            { label: 'C4 Architecture…', accelerator: 'CmdOrCtrl+Shift+A', click: send('c4') },
            { type: 'separator' },
            { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
            {
                label: 'Export',
                submenu: [
                    { label: 'Diagram as PNG', click: send('export-png') },
                    { label: 'Diagram as SVG', click: send('export-svg') },
                    { label: 'nuXmv Model (.smv)', click: send('export-smv') },
                    { type: 'separator' },
                    { label: 'Python Implementation (.py)', click: send('export-python') },
                    { label: 'Jupyter Notebook (.ipynb)', click: send('export-notebook') }
                ]
            },
            { type: 'separator' },
            ...last
        ]
    };
}

function editMenu(): MenuItemConstructorOptions {
    return { label: '&Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] };
}

function viewMenu(): MenuItemConstructorOptions {
    return { label: '&View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] };
}

function verifyMenu(send: Send): MenuItemConstructorOptions {
    return { label: '&Verify', submenu: [{ label: 'Check Properties', accelerator: 'F5', click: send('check') }, { label: 'Simulate the Diagram', accelerator: 'Shift+F5', click: send('simulate') }] };
}

function windowMenu(platform: NodeJS.Platform): MenuItemConstructorOptions {
    return { label: '&Window', submenu: platform === 'darwin' ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [{ role: 'minimize' }, { role: 'close' }] };
}

function helpMenu(platform: NodeJS.Platform, actions: MenuActions, send: Send): MenuItemConstructorOptions {
    // macOS has its own About panel, in the app menu.
    const about: MenuItemConstructorOptions[] = platform === 'darwin' ? [] : [{ type: 'separator' }, { label: 'About ProvenFlow', click: () => actions.about() }];
    return {
        role: 'help',
        label: '&Help',
        submenu: [
            { label: 'Using the Editor', click: send('help-guide') },
            { label: 'Walkthroughs', click: send('help-walkthroughs') },
            { type: 'separator' },
            { label: 'Documentation', click: () => actions.openExternal(DOCS_URL) },
            { label: 'Report an Issue', click: () => actions.openExternal(ISSUES_URL) },
            ...about
        ]
    };
}
