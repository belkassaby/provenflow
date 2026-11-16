import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { filesFromArgv, kindOf, readOpenable } from '../src/files.js';
import { DOCS_URL, menuTemplate, type DesktopCommand } from '../src/menu.js';
import { mergePath, parseShellPath } from '../src/shell-path.js';
import { loadWindowState, saveWindowState, themeOf, visibleBounds } from '../src/window-state.js';

function items(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
    const menu = template.find(m => m.label?.replace('&', '') === label);
    return (menu?.submenu as MenuItemConstructorOptions[]) ?? [];
}

function click(item: MenuItemConstructorOptions | undefined): void {
    (item?.click as unknown as () => void)();
}

describe('the application menu', () => {
    const sent: DesktopCommand[] = [];
    const opened: string[] = [];
    const actions = { command: (c: DesktopCommand) => sent.push(c), openFile: () => opened.push('dialog'), openExternal: (url: string) => opened.push(url), about: () => opened.push('about') };

    it('has the menus of a desktop editor, with the app menu on macOS only', () => {
        expect(menuTemplate('darwin', 'ProvenFlow', actions).map(m => m.label)).toEqual(['ProvenFlow', '&File', '&Edit', '&View', '&Verify', '&Window', '&Help']);
        expect(menuTemplate('win32', 'ProvenFlow', actions).map(m => m.label)).toEqual(['&File', '&Edit', '&View', '&Verify', '&Window', '&Help']);
    });

    it('sends the editor its commands, and opens files and links natively', () => {
        const template = menuTemplate('linux', 'ProvenFlow', actions);
        const file = items(template, 'File');
        click(file.find(i => i.label === 'C4 Architecture…'));
        click(file.find(i => i.label === 'Open…'));
        click(items(template, 'Verify')[0]);
        click(items(template, 'Help').find(i => i.label === 'Documentation'));
        click(items(template, 'Help').find(i => i.label === 'About ProvenFlow'));
        click(items(template, 'View').find(i => i.label === 'Toggle Dark Theme'));
        expect(sent).toEqual(['c4', 'check', 'toggle-theme']);
        expect(opened).toEqual(['dialog', DOCS_URL, 'about']);
        // Settings and Quit are in the File menu where there is no app menu.
        expect(file.some(i => i.role === 'quit')).toBe(true);
        expect(file.find(i => i.label === 'Settings…')?.accelerator).toBe('Ctrl+,');
    });

    it('gives every command item a distinct shortcut', () => {
        const all = menuTemplate('darwin', 'ProvenFlow', actions).flatMap(m => (m.submenu as MenuItemConstructorOptions[]) ?? []);
        const keys = all.map(i => i.accelerator).filter(Boolean);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('opening files', () => {
    it('opens diagrams and C4 workspaces, and nothing else', () => {
        expect(kindOf('a/b.pflow')).toBe('diagram');
        expect(kindOf('workspace.DSL')).toBe('c4');
        expect(kindOf('model.c4.json')).toBe('c4');
        expect(kindOf('notes.txt')).toBeUndefined();
    });

    it('reads the files named on the command line, and says why it cannot open one', () => {
        const dir = mkdtempSync(join(tmpdir(), 'pflow-desktop-'));
        try {
            writeFileSync(join(dir, 'm.pflow'), 'diagram m {}');
            writeFileSync(join(dir, 'w.json'), '{}');
            expect(filesFromArgv(['ProvenFlow', '--inspect', 'm.pflow', 'readme.md'], dir)).toEqual([join(dir, 'm.pflow')]);
            expect(readOpenable(join(dir, 'm.pflow'))).toMatchObject({ name: 'm.pflow', kind: 'diagram', text: 'diagram m {}' });
            // A .json is only taken as a C4 workspace when chosen in the Open dialog.
            expect(readOpenable(join(dir, 'w.json'))).toHaveProperty('error');
            expect(readOpenable(join(dir, 'w.json'), true)).toMatchObject({ kind: 'c4' });
            expect(readOpenable(join(dir, 'gone.pflow'))).toHaveProperty('error');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the window and the environment', () => {
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };

    it('reopens the window where it was, unless that screen is gone', () => {
        expect(visibleBounds({ x: 100, y: 100, width: 1200, height: 800 }, [screen])).toEqual({ x: 100, y: 100, width: 1200, height: 800 });
        expect(visibleBounds({ x: 2500, y: 100, width: 1200, height: 800 }, [screen])).toBeUndefined();
        expect(visibleBounds({ x: 2500, y: 100, width: 1200, height: 800 }, [screen, { x: 1920, y: 0, width: 2560, height: 1440 }])).toBeDefined();
        expect(visibleBounds(undefined, [screen])).toBeUndefined();
    });

    it('keeps the theme chosen in the editor with the window state, and nothing else the page sends', () => {
        const dir = mkdtempSync(join(tmpdir(), 'pflow-desktop-'));
        try {
            const file = join(dir, 'window-state.json');
            saveWindowState(file, { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: false });
            saveWindowState(file, { theme: 'dark' });
            saveWindowState(file, { maximized: true });
            expect(loadWindowState(file)).toEqual({ bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: true, theme: 'dark' });
            expect(themeOf('light')).toBe('light');
            expect(themeOf('system')).toBeUndefined();
            expect(themeOf({ theme: 'dark' })).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('takes the PATH of the login shell, before its own', () => {
        expect(parseShellPath('motd\n__PROVENFLOW_PATH__/opt/nuxmv/bin:/usr/bin__PROVENFLOW_PATH__')).toBe('/opt/nuxmv/bin:/usr/bin');
        expect(parseShellPath('no marker')).toBeUndefined();
        expect(mergePath(['/usr/bin', '/bin'].join(delimiter), ['/opt/tools', '/usr/bin'].join(delimiter))).toBe(['/opt/tools', '/usr/bin', '/bin'].join(delimiter));
    });
});
