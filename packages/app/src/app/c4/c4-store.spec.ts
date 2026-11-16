import { TestBed } from '@angular/core/testing';
import cytoscape from 'cytoscape';
import { packPositions } from './c4-pack';
import { cytoscapeElements, wrap } from './c4-render';
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

    it('draws relationships straight, at right angles or curved, for all of them or one in a view', () => {
        store.open(DSL, 'shop.dsl');
        const classes = () => cytoscapeElements(store.workspace(), store.view(), store.contents(), store.index(), new Set()).filter(e => e.group === 'edges').map(e => e.classes);
        const edge = store.contents().edges[0].id;
        expect(store.routing()).toBe('Direct');
        expect(classes()).toEqual(['implied']);
        store.setDefaultRouting('Orthogonal');
        expect(store.exportText('dsl')).toContain('routing Orthogonal');
        expect(classes()).toEqual(['implied orthogonal vertical']);
        store.setRouting(edge, 'Curved');
        expect(classes()).toEqual(['implied curved']);
        // The other view keeps the default.
        store.showView('containers');
        expect(classes()).toEqual(['orthogonal vertical']);
        store.showView('context');
        store.setRouting(edge, undefined);
        expect(store.view()?.routing).toBeUndefined();
        store.undo();
        expect(store.view()?.routing).toEqual({ [edge]: 'Curved' });
    });

    it('moves the ends of a relationship to a side of its box, or to another box', () => {
        const shop = DSL.replace('web = container "Web" "" "Angular"', 'web = container "Web" "" "Angular"\n            api = container "API" "" "Node.js"');
        store.open(shop, 'shop.dsl');
        store.showView('containers');
        const uses = store.contents().edges.find(e => e.source === 'customer')!;
        // Another side of the same box: only the view changes.
        expect(store.moveEnd(uses.id, 'target', 'web', 'left')).toBeNull();
        expect(store.view()?.anchors).toEqual({ [uses.id]: { target: 'left' } });
        // Another box: the relationship now goes there, attached to the side it was dropped on.
        expect(store.moveEnd(uses.id, 'target', 'api', 'top')).toBeNull();
        expect(store.workspace().relationships.find(r => r.id === uses.relationship)?.destination).toBe('api');
        expect(store.view()?.anchors).toEqual({ [uses.id]: { target: 'top' } });
        expect(store.moveEnd(uses.id, 'target', 'customer', 'top')).toBe('A relationship joins two different elements.');
        // One step to undo.
        store.undo();
        expect(store.workspace().relationships.find(r => r.id === uses.relationship)?.destination).toBe('web');
        expect(store.view()?.anchors).toEqual({ [uses.id]: { target: 'left' } });
        // A line standing for a relationship of an element inside a box (customer → web, shown on shop).
        store.showView('context');
        const implied = store.contents().edges[0];
        expect(store.moveEnd(implied.id, 'target', 'shop', 'bottom')).toBeNull();
        expect(cytoscapeElements(store.workspace(), store.view(), store.contents(), store.index(), new Set()).find(e => e.group === 'edges')?.classes).toBe('implied tgt-bottom');
        // Dropped on the box itself as source: customer stays, the line is the relationship's own now, still selected.
        store.addElement('person', { x: 0, y: 0 });
        const admin = store.workspace().elements.find(e => e.type === 'person' && e.id !== 'customer')!.id;
        expect(store.moveEnd(implied.id, 'source', admin, 'right')).toBeNull();
        const moved = store.workspace().relationships.find(r => r.id === implied.relationship)!;
        expect([moved.source, moved.destination]).toEqual([admin, 'web']);
        expect(store.selection()).toEqual({ kind: 'relationship', id: `${moved.id}@${admin}>shop` });
        // The end that stayed keeps its side.
        expect(store.view()?.anchors).toEqual({ [`${moved.id}@${admin}>shop`]: { source: 'right', target: 'bottom' } });
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
