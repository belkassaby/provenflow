import { TestBed } from '@angular/core/testing';
import cytoscape from 'cytoscape';
import { packPositions } from './c4-pack';
import { wrap } from './c4-render';
import { C4Store } from './c4-store';

const DSL = `workspace "Shop" {
    model {
        customer = person "Customer"
        shop = softwareSystem "Shop" {
            web = container "Web" "" "Angular"
        }
        customer -> web "Uses"
    }
    views {
        systemContext shop "context" {
            include *
        }
        container shop "containers" {
            include *
        }
    }
}`;

describe('C4 store', () => {
    let store: C4Store;
    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({});
        store = TestBed.inject(C4Store);
    });

    it('opens DSL and shows its first view', () => {
        expect(store.open(DSL, 'shop.dsl')).toBe(true);
        expect(store.view()?.key).toBe('context');
        expect(store.contents().nodes.map(n => n.id).sort()).toEqual(['customer', 'shop']);
    });

    it('adds elements in the view, connects them, and undoes it', () => {
        store.open(DSL, 'shop.dsl');
        store.showView('containers');
        const id = store.addElement('container');
        expect(store.index().get(id)?.parent).toBe('shop');
        store.connect('web', id);
        expect(store.contents().edges.some(e => e.source === 'web' && e.target === id)).toBe(true);
        store.undo();
        store.undo();
        expect(store.index().has(id)).toBe(false);
        store.redo();
        expect(store.index().has(id)).toBe(true);
    });

    it('opens the next level of a system, and exports the workspace', () => {
        store.open(DSL, 'shop.dsl');
        store.drillDown('shop');
        expect(store.view()?.key).toBe('containers');
        store.drillDown('web');
        expect(store.view()?.type).toBe('component');
        expect(store.exportText('dsl')).toContain('web = container "Web" "" "Angular"');
        expect(JSON.parse(store.exportText('json')).views).toHaveLength(3);
        expect(store.open('{ "nope": 1 }', 'bad.json')).toBe(false);
    });
});

describe('C4 drawing helpers', () => {
    it('wraps text into lines, and cuts after the last one', () => {
        expect(wrap('one two three four', 9, 3)).toEqual(['one two', 'three', 'four']);
        expect(wrap('aaa bbb ccc ddd eee', 7, 2)).toEqual(['aaa bbb', 'ccc dd…']);
    });

    it('packs deployment nodes around their boxes without overlap', () => {
        const cy = cytoscape({ headless: true });
        cy.add([
            { data: { id: 'node' } },
            ...['a', 'b', 'c', 'd'].map(id => ({ data: { id, parent: 'node', w: 200, h: 100 } })),
            { data: { id: 'out', w: 200, h: 100 } }
        ]);
        const p = packPositions(cy);
        const boxes = Object.values(p);
        expect(boxes).toHaveLength(5);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(Math.abs(boxes[i].x - boxes[j].x) >= 200 || Math.abs(boxes[i].y - boxes[j].y) >= 100).toBe(true);
        cy.destroy();
    });
});
