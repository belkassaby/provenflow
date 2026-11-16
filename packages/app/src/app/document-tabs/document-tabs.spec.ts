import { TestBed } from '@angular/core/testing';
import { DiagramStore } from '../diagram-store';
import { DocumentTabs } from './document-tabs';

const settle = () => new Promise(resolve => setTimeout(resolve, 60));

describe('DocumentTabs', () => {
    let tabs: DocumentTabs;
    let store: DiagramStore;

    beforeEach(async () => {
        localStorage.removeItem('provenflow.tabs');
        TestBed.resetTestingModule();
        store = TestBed.inject(DiagramStore);
        tabs = TestBed.inject(DocumentTabs);
        await settle();
    });

    it('starts with the example the editor shows', () => {
        expect(tabs.tabs().length).toBe(1);
        expect(tabs.tabs()[0].fileName).toBe(store.fileName());
    });

    it('opens each document in its own tab and keeps its text, unsaved state and results', async () => {
        tabs.open('diagram A\ninitial state a\na -> a;\n', 'a.pflow', 'code');
        await settle();
        store.setText('diagram A\ninitial state a\nstate b\na -> b;\nb -> a;\n');
        await store.settled();
        store.dirty.set(true);
        store.verification.set({ running: false, model: store.generated().text, results: [], errors: [], warnings: [] } as never);
        tabs.open('diagram B\ninitial state x\nx -> x;\n', 'b.pflow', 'code');
        await settle();
        expect(tabs.tabs().map(t => t.fileName)).toEqual([tabs.tabs()[0].fileName, 'a.pflow', 'b.pflow']);
        expect(store.fileName()).toBe('b.pflow');
        expect(store.model().states.map(s => s.name)).toEqual(['x']);

        tabs.activate(tabs.tabs()[1].id);
        await settle();
        expect(store.fileName()).toBe('a.pflow');
        expect(store.model().states.map(s => s.name)).toEqual(['a', 'b']);
        expect(store.dirty()).toBe(true);
        expect(store.verification()?.stale).toBeFalsy();
        expect(store.verification()).not.toBeNull();
    });

    it('shows the existing tab when the same document is opened again', async () => {
        tabs.open('diagram A\ninitial state a\na -> a;\n', 'a.pflow', 'code');
        tabs.openExample('mutex');
        tabs.open('diagram A\ninitial state a\na -> a;\n', 'a.pflow', 'code');
        await settle();
        expect(tabs.tabs().filter(t => t.fileName === 'a.pflow').length).toBe(1);
        expect(store.fileName()).toBe('a.pflow');
    });

    it('closes tabs, and replaces the last one with a new diagram', async () => {
        const first = tabs.tabs()[0].id;
        tabs.close(first);
        await settle();
        expect(tabs.tabs().length).toBe(1);
        expect(tabs.tabs()[0].kind).toBe('new');
    });

    it('restores the open documents after a reload', async () => {
        tabs.open('diagram A\ninitial state a\na -> a;\n', 'a.pflow', 'code');
        await settle();
        const saved = JSON.parse(localStorage.getItem('provenflow.tabs')!);
        expect(saved.tabs.map((t: { fileName: string }) => t.fileName)).toContain('a.pflow');
        expect(saved.active).toBe(tabs.active());
    });

    it('shows the code base report and the C4 architecture in tabs of their own, keeping the diagram', async () => {
        const example = store.fileName();
        tabs.openPage('report');
        tabs.openPage('c4');
        tabs.openPage('report');
        expect(tabs.tabs().map(t => t.kind)).toEqual(['example', 'report', 'c4']);
        expect(tabs.page()).toBe('report');
        expect(store.fileName()).toBe(example);

        tabs.open('diagram A\ninitial state a\na -> a;\n', 'a.pflow', 'code');
        await settle();
        store.dirty.set(true);
        await settle();
        expect(tabs.page()).toBeNull();
        tabs.openPage('c4');
        await settle();
        // The diagram stays in the store behind the page, with its unsaved state.
        expect(store.fileName()).toBe('a.pflow');
        expect(tabs.tabs().find(t => t.fileName === 'a.pflow')?.dirty).toBe(true);
        tabs.showDiagram();
        expect(tabs.page()).toBeNull();
        expect(store.fileName()).toBe('a.pflow');
    });

    it('loads the next diagram when the one behind a page is closed, and keeps the page shown', async () => {
        const example = store.fileName();
        tabs.open('diagram A\ninitial state a\na -> a;\n', 'a.pflow', 'code');
        tabs.openPage('c4');
        await settle();
        tabs.close(tabs.tabs().find(t => t.fileName === 'a.pflow')!.id);
        await settle();
        expect(tabs.page()).toBe('c4');
        expect(store.fileName()).toBe(example);
        tabs.close(tabs.tabs().find(t => t.kind === 'c4')!.id);
        expect(tabs.page()).toBeNull();
        expect(tabs.tabs().map(t => t.fileName)).toEqual([example]);
    });

    it('reopens the pages after a reload, with the diagram that was behind them', async () => {
        tabs.open('diagram A\ninitial state a\na -> a;\n', 'a.pflow', 'code');
        tabs.openPage('report');
        await settle();
        TestBed.resetTestingModule();
        store = TestBed.inject(DiagramStore);
        tabs = TestBed.inject(DocumentTabs);
        await settle();
        expect(tabs.page()).toBe('report');
        expect(store.fileName()).toBe('a.pflow');
    });
});
