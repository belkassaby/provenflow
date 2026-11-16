import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { EXAMPLES, emptyDiagram, serializeDiagram } from '@provenflow/language';
import { DiagramStore, type Verification } from '../diagram-store';

/** A tab that is not a diagram: the code base report, the C4 architecture editor. */
export type PageKind = 'report' | 'c4';

/** Where a document comes from, for its icon and tooltip; or the page a tab shows. */
export type DocumentKind = 'file' | 'example' | 'new' | 'code' | 'import' | PageKind;

const PAGE_TITLES: Record<PageKind, string> = { report: 'Code base report', c4: 'C4 architecture' };

export function isPage(kind: DocumentKind): kind is PageKind {
    return kind in PAGE_TITLES;
}

/**
 * An open tab. A diagram's text, results and trace live in the DiagramStore while it is the one
 * loaded there, and in its tab otherwise. A page tab keeps nothing: its page has its own state.
 */
export interface DocumentTab {
    id: number;
    fileName: string;
    kind: DocumentKind;
    text: string;
    dirty: boolean;
    /** Kept while the tab is in the background (not saved across reloads). */
    verification: Verification | null;
    trace: ReturnType<DiagramStore['trace']>;
    traceStep: number;
}

const STORAGE_KEY = 'provenflow.tabs';

/** Saved across reloads: which documents were open and their text. */
interface SavedTabs {
    active: number;
    /** The diagram loaded in the store (the active tab, unless that is a page). */
    loaded?: number;
    tabs: Array<Pick<DocumentTab, 'id' | 'fileName' | 'kind' | 'text' | 'dirty'>>;
}

/**
 * The tabs open in the editor: documents (files, examples, new diagrams, imported agent graphs
 * and models found by Import code base) and pages (the code base report, the C4 architecture).
 * Switching tabs keeps each document's text, unsaved state, verification results and replayed trace.
 */
@Injectable({ providedIn: 'root' })
export class DocumentTabs {
    private readonly store = inject(DiagramStore);
    readonly tabs = signal<DocumentTab[]>([]);
    readonly active = signal(0);
    /** The page the active tab shows, or null for a diagram. */
    readonly page = computed(() => {
        const kind = this.tabs().find(t => t.id === this.active())?.kind;
        return kind && isPage(kind) ? kind : null;
    });
    /** The pages that have a tab (shown or not). */
    readonly pages = computed(() => new Set(this.tabs().flatMap(t => (isPage(t.kind) ? [t.kind] : []))));
    private nextId = 1;
    /** The diagram in the store: the active tab, or the last diagram shown before a page. */
    private loaded = 0;

    constructor() {
        const saved = readSaved();
        const diagrams = saved?.tabs.filter(t => !isPage(t.kind)) ?? [];
        if (saved && diagrams.length > 0) {
            this.tabs.set(saved.tabs.map(t => ({ ...t, verification: null, trace: null, traceStep: 0 })));
            this.nextId = Math.max(...saved.tabs.map(t => t.id)) + 1;
            const loaded = diagrams.find(t => t.id === (saved.loaded ?? saved.active)) ?? diagrams[0];
            this.loaded = loaded.id;
            this.active.set(saved.tabs.some(t => t.id === saved.active) ? saved.active : loaded.id);
            this.restore(this.tabs().find(t => t.id === loaded.id)!);
        } else {
            // The store starts with the first example: that is the first tab.
            const id = this.nextId++;
            this.tabs.set([{ id, fileName: this.store.fileName(), kind: 'example', text: this.store.text(), dirty: false, verification: null, trace: null, traceStep: 0 }]);
            this.active.set(id);
            this.loaded = id;
        }
        // The loaded diagram's tab follows the store's name and unsaved state; everything is saved for the next visit.
        effect(() => {
            const fileName = this.store.fileName();
            const dirty = this.store.dirty();
            const text = this.store.text();
            untracked(() => {
                this.tabs.update(tabs => tabs.map(t => (t.id === this.loaded ? { ...t, fileName, dirty, text } : t)));
                this.save();
            });
        });
    }

    /** Shows a page in its tab, opening the tab the first time. */
    openPage(kind: PageKind): void {
        const tab = this.tabs().find(t => t.kind === kind);
        if (tab) return this.activate(tab.id);
        const id = this.nextId++;
        this.tabs.update(tabs => [...tabs, { id, fileName: PAGE_TITLES[kind], kind, text: '', dirty: false, verification: null, trace: null, traceStep: 0 }]);
        this.active.set(id);
        this.save();
    }

    /** Back to the diagram last shown (from a page). */
    showDiagram(): void {
        if (this.page()) this.activate(this.loaded);
    }

    /** Opens a document in a new tab, or shows the tab that already has exactly this document. */
    open(text: string, fileName: string, kind: DocumentKind): void {
        this.snapshot();
        const same = this.tabs().find(t => t.fileName === fileName && t.text === text);
        if (same) {
            this.activate(same.id);
            return;
        }
        const id = this.nextId++;
        this.tabs.update(tabs => [...tabs, { id, fileName, kind, text, dirty: false, verification: null, trace: null, traceStep: 0 }]);
        this.active.set(id);
        this.loaded = id;
        this.store.load(text, fileName);
        this.save();
    }

    newDiagram(): void {
        this.open(serializeDiagram(emptyDiagram('untitled')), this.freeName('untitled.pflow'), 'new');
    }

    openExample(id: string): void {
        const example = EXAMPLES.find(e => e.id === id) ?? EXAMPLES[0];
        this.open(example.source, `${example.id}.pflow`, 'example');
    }

    activate(id: number): void {
        if (id === this.active()) return;
        const target = this.tabs().find(t => t.id === id);
        if (!target) return;
        if (!isPage(target.kind) && id !== this.loaded) this.load(target);
        this.active.set(id);
        this.save();
    }

    /** Closes a tab (asking first if it has unsaved changes); the last diagram is replaced by a new one. */
    close(id: number): void {
        const tab = this.tabs().find(t => t.id === id);
        if (!tab) return;
        const dirty = id === this.loaded ? this.store.dirty() : tab.dirty;
        if (dirty && !confirm(`Close ${tab.fileName} without saving its changes?`)) return;
        const index = this.tabs().findIndex(t => t.id === id);
        const rest = this.tabs().filter(t => t.id !== id);
        this.tabs.set(rest);
        const diagrams = rest.filter(t => !isPage(t.kind));
        if (diagrams.length === 0) {
            this.loaded = 0;
            this.newDiagram();
            return;
        }
        // The store keeps the next diagram (the closed one's state is gone with its tab).
        if (id === this.loaded) this.load(rest.slice(index).find(t => !isPage(t.kind)) ?? diagrams[diagrams.length - 1]);
        if (id === this.active()) this.activate(rest[Math.min(index, rest.length - 1)].id);
        this.save();
    }

    /** Puts a diagram in the store, keeping the state of the one there in its tab. */
    private load(tab: DocumentTab): void {
        this.snapshot();
        this.loaded = tab.id;
        this.restore(tab);
    }

    /** Stores the loaded document's state in its tab before another one takes its place. */
    private snapshot(): void {
        const id = this.loaded;
        this.tabs.update(tabs =>
            tabs.map(t =>
                t.id === id
                    ? { ...t, fileName: this.store.fileName(), text: this.store.text(), dirty: this.store.dirty(), verification: this.store.verification(), trace: this.store.trace(), traceStep: this.store.traceStep() }
                    : t
            )
        );
    }

    private restore(tab: DocumentTab): void {
        this.store.load(tab.text, tab.fileName);
        this.store.dirty.set(tab.dirty);
        if (tab.verification && !tab.verification.running) this.store.verification.set(tab.verification);
        if (tab.trace) {
            this.store.trace.set(tab.trace);
            this.store.traceStep.set(tab.traceStep);
        }
    }

    private freeName(name: string): string {
        const taken = new Set(this.tabs().map(t => t.fileName));
        if (!taken.has(name)) return name;
        const base = name.replace(/\.pflow$/, '');
        for (let i = 2; ; i++) if (!taken.has(`${base}-${i}.pflow`)) return `${base}-${i}.pflow`;
    }

    private save(): void {
        try {
            const data: SavedTabs = { active: this.active(), loaded: this.loaded, tabs: this.tabs().map(({ id, fileName, kind, text, dirty }) => ({ id, fileName, kind, text, dirty })) };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch {
            // Storage full or unavailable: tabs simply do not survive a reload.
        }
    }
}

function readSaved(): SavedTabs | undefined {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const data = raw ? (JSON.parse(raw) as SavedTabs) : undefined;
        return data && Array.isArray(data.tabs) && data.tabs.every(t => typeof t.text === 'string' && typeof t.fileName === 'string') ? data : undefined;
    } catch {
        return undefined;
    }
}
