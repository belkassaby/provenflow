import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandDocument, savePlan } from '../src/editor-documents';
import { commandOf, EDITOR_MENU, SUBMENUS } from '../src/editor-menu';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string }>; submenus: Array<{ id: string }>; menus: Record<string, Array<{ command?: string; submenu?: string; when?: string }>> };
};

describe('the ProvenFlow menu', () => {
    it('lists every item of the editor menu in package.json, as a command and in its submenu', () => {
        const declared = new Map(pkg.contributes.commands.map(c => [c.command, c.title]));
        for (const item of EDITOR_MENU) {
            expect(declared.get(commandOf(item))).toBe(item.title);
            const menu = item.submenu === 'examples' ? 'provenflow.menu' : `provenflow.menu.${item.submenu}`;
            expect(pkg.contributes.menus[menu].some(m => m.command === commandOf(item))).toBe(true);
        }
        expect(pkg.contributes.commands.filter(c => c.command.startsWith('provenflow.editor.')).length).toBe(EDITOR_MENU.length);
        expect(pkg.contributes.submenus.map(s => s.id)).toEqual(['provenflow.menu', ...Object.keys(SUBMENUS).filter(k => k !== 'examples').map(k => `provenflow.menu.${k}`)]);
        // In the title bar of a ProvenFlow tab.
        expect(pkg.contributes.menus['editor/title']).toContainEqual({ submenu: 'provenflow.menu', when: "activeWebviewPanelId == 'provenflow.editor'", group: 'navigation' });
    });

    it('saves over the file a tab shows when it saves that file, and asks otherwise', () => {
        const file = { key: 'file:/w/d/door.pflow', title: 'door.pflow', path: '/w/d/door.pflow' };
        expect(savePlan(file, 'door.pflow', '/w')).toEqual({ write: '/w/d/door.pflow' });
        expect(savePlan(file, 'door.smv', '/w')).toEqual({ ask: '/w/d/door.smv' });
        expect(savePlan({ key: 'c4:/w', title: 'C4 · w' }, 'w.dsl', '/w')).toEqual({ ask: '/w/w.dsl' });
        expect(commandDocument('example:door', 'Door', 'example:door').message).toEqual({ provenflow: 'command', command: 'example:door' });
    });
});
