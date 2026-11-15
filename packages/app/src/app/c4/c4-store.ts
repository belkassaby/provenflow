import { computed, Injectable, signal } from '@angular/core';
import {
    c4ViewToText,
    elementIndex,
    emptyWorkspace,
    identifierFor,
    parseC4Dsl,
    removeElement,
    viewContents,
    writeC4Dsl,
    type C4Diagnostic,
    type C4Element,
    type C4ElementType,
    type C4Relationship,
    type C4View,
    type C4ViewType,
    type C4Workspace
} from '@provenflow/language';

export type C4Selection = { kind: 'element'; id: string } | { kind: 'relationship'; id: string };
export type C4ExportFormat = 'dsl' | 'json' | 'plantuml' | 'mermaid';

/** The workspace open in the C4 editor, kept in this browser across reloads. */
const STORAGE_KEY = 'provenflow.c4';
const MAX_UNDO = 100;

/** Which elements each kind of view can add, and where they go. */
const ADDABLE: Record<C4ViewType, C4ElementType[]> = {
    systemLandscape: ['person', 'softwareSystem'],
    systemContext: ['person', 'softwareSystem'],
    container: ['person', 'softwareSystem', 'container'],
    component: ['person', 'softwareSystem', 'container', 'component'],
    dynamic: [],
    deployment: ['deploymentNode', 'infrastructureNode']
};

interface Stored {
    workspace: C4Workspace;
    name: string;
    view: string;
}

function loadStored(): Stored | null {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Stored | null;
        return stored?.workspace?.elements ? stored : null;
    } catch {
        return null;
    }
}

/**
 * The C4 model being viewed and edited: the workspace (Structurizr DSL or ProvenFlow's JSON), the
 * view shown, the selection, and every edit as a new workspace (so undo and redo are a stack).
 */
@Injectable({ providedIn: 'root' })
export class C4Store {
    private readonly stored = loadStored();
    readonly workspace = signal<C4Workspace>(this.stored?.workspace ?? emptyWorkspace('Architecture'));
    readonly fileName = signal(this.stored?.name ?? 'workspace.dsl');
    readonly viewKey = signal(this.stored?.view ?? '');
    readonly selection = signal<C4Selection | null>(null);
    readonly diagnostics = signal<C4Diagnostic[]>([]);
    readonly dirty = signal(false);
    /** Elements to point out (the projects a suggestion is about). */
    readonly highlight = signal<ReadonlySet<string>>(new Set());
    /** Bumped to ask the canvas to lay the view out again. */
    readonly layoutRequests = signal(0);
    private readonly undoStack = signal<C4Workspace[]>([]);
    private readonly redoStack = signal<C4Workspace[]>([]);
    readonly canUndo = computed(() => this.undoStack().length > 0);
    readonly canRedo = computed(() => this.redoStack().length > 0);

    readonly view = computed<C4View | undefined>(() => {
        const views = this.workspace().views;
        return views.find(v => v.key === this.viewKey()) ?? views[0];
    });
    readonly contents = computed(() => {
        const view = this.view();
        return view ? viewContents(this.workspace(), view) : { nodes: [], edges: [] };
    });
    readonly index = computed(() => elementIndex(this.workspace()));
    readonly addable = computed(() => ADDABLE[this.view()?.type ?? 'systemLandscape']);

    /** Opens a Structurizr DSL file, or ProvenFlow's JSON form of a workspace. Errors leave the current one open. */
    open(text: string, name: string): boolean {
        if (name.endsWith('.json') || text.trimStart().startsWith('{')) {
            try {
                const ws = JSON.parse(text) as C4Workspace;
                if (!Array.isArray(ws.elements) || !Array.isArray(ws.views)) throw new Error('not a C4 workspace');
                this.diagnostics.set([]);
                this.replace({ ...emptyWorkspace(), ...ws }, name);
                return true;
            } catch (error) {
                this.diagnostics.set([{ line: 1, severity: 'error', message: `${name}: ${(error as Error).message}` }]);
                return false;
            }
        }
        const { workspace, diagnostics } = parseC4Dsl(text);
        this.diagnostics.set(diagnostics);
        if (diagnostics.some(d => d.severity === 'error') && workspace.elements.length === 0) return false;
        this.replace(workspace, name);
        return true;
    }

    /** Shows another workspace (a discovered one, an opened file), keeping the current one for undo. */
    replace(ws: C4Workspace, name = this.fileName()): void {
        this.edit(() => ws);
        this.fileName.set(name);
        this.viewKey.set(ws.views[0]?.key ?? '');
        this.selection.set(null);
        this.highlight.set(new Set());
        this.dirty.set(false);
        this.persist();
    }

    /** Applies an edit, as one step of undo. */
    edit(change: (ws: C4Workspace) => C4Workspace): void {
        const before = this.workspace();
        const after = change(structuredClone(before));
        this.undoStack.set([...this.undoStack(), before].slice(-MAX_UNDO));
        this.redoStack.set([]);
        this.workspace.set(after);
        this.dirty.set(true);
        this.persist();
    }

    undo(): void {
        this.step(this.undoStack, this.redoStack);
    }

    redo(): void {
        this.step(this.redoStack, this.undoStack);
    }

    private step(from: ReturnType<typeof signal<C4Workspace[]>>, to: ReturnType<typeof signal<C4Workspace[]>>): void {
        const list = from();
        const previous = list[list.length - 1];
        if (!previous) return;
        from.set(list.slice(0, -1));
        to.set([...to(), this.workspace()]);
        this.workspace.set(previous);
        this.selection.set(null);
        this.persist();
    }

    showView(key: string): void {
        this.viewKey.set(key);
        this.selection.set(null);
        this.persist();
    }

    /** Adds an element where the view shows it: in the view's system or container, or the selected deployment node. */
    addElement(type: C4ElementType, near?: { x: number; y: number }): string {
        const view = this.view();
        const index = this.index();
        const id = identifierFor(`new ${type}`, index);
        const element: C4Element = { id, type, name: `New ${type.replace(/([A-Z])/g, ' $1').toLowerCase()}`, tags: [], ...this.placement(type, view) };
        this.edit(ws => {
            ws.elements.push(element);
            if (!view) ws.views.push({ type: 'systemLandscape', key: 'landscape', include: ['*'], exclude: [], autoLayout: { direction: 'tb' } });
            const v = ws.views.find(x => x.key === (view?.key ?? 'landscape'));
            if (v && v.include.length && !v.include.includes(id)) v.include.push(id);
            if (v?.positions && near) v.positions[id] = near;
            return ws;
        });
        if (!view) this.viewKey.set('landscape');
        this.selection.set({ kind: 'element', id });
        return id;
    }

    private placement(type: C4ElementType, view: C4View | undefined): Partial<C4Element> {
        const scope = view?.scope ? this.index().get(view.scope) : undefined;
        switch (type) {
            case 'container':
                // In the view's system, or in the system of the view's container.
                return scope?.type === 'softwareSystem' ? { parent: scope.id } : scope?.parent ? { parent: scope.parent } : {};
            case 'component':
                return scope?.type === 'container' ? { parent: scope.id } : {};
            case 'deploymentNode':
            case 'infrastructureNode':
                return { environment: view?.environment, ...this.selectedDeploymentNode() };
            default:
                return {};
        }
    }

    /** The selected deployment node, as the parent of what is added in a deployment view. */
    private selectedDeploymentNode(): { parent?: string } {
        const sel = this.selection();
        const node = sel?.kind === 'element' ? this.index().get(sel.id) : undefined;
        return node?.type === 'deploymentNode' ? { parent: node.id } : {};
    }

    updateElement(id: string, patch: Partial<C4Element>): void {
        this.edit(ws => ({ ...ws, elements: ws.elements.map(e => (e.id === id ? { ...e, ...patch } : e)) }));
    }

    /** A relationship from one element to another (in a dynamic view, also the next step). */
    connect(source: string, destination: string): void {
        const view = this.view();
        const ids = new Set([...this.index().keys(), ...this.workspace().relationships.map(r => r.id)]);
        const rel: C4Relationship = { id: identifierFor(`rel ${source} ${destination}`, ids), source, destination, description: 'Uses', tags: [] };
        this.edit(ws => {
            if (!ws.relationships.some(r => r.source === source && r.destination === destination)) ws.relationships.push(rel);
            const v = ws.views.find(x => x.key === view?.key);
            if (v?.type === 'dynamic') (v.steps ??= []).push({ source, destination, description: 'Uses' });
            return ws;
        });
        this.selection.set({ kind: 'relationship', id: rel.id });
    }

    updateRelationship(id: string, patch: Partial<C4Relationship>): void {
        this.edit(ws => ({ ...ws, relationships: ws.relationships.map(r => (r.id === id ? { ...r, ...patch } : r)) }));
    }

    removeSelected(): void {
        const sel = this.selection();
        if (!sel) return;
        if (sel.kind === 'element') this.edit(ws => removeElement(ws, sel.id));
        else this.edit(ws => ({ ...ws, relationships: ws.relationships.filter(r => r.id !== sel.id.split('@')[0]) }));
        this.selection.set(null);
    }

    /** Positions dragged by hand in the current view (the view then keeps its layout). */
    setPositions(positions: Record<string, { x: number; y: number }>): void {
        const key = this.view()?.key;
        if (!key) return;
        this.edit(ws => ({ ...ws, views: ws.views.map(v => (v.key === key ? { ...v, positions } : v)) }));
    }

    updateView(key: string, patch: Partial<C4View>): void {
        this.edit(ws => ({ ...ws, views: ws.views.map(v => (v.key === key ? { ...v, ...patch } : v)) }));
        if (patch.key) this.viewKey.set(patch.key);
    }

    /** Forgets the hand placement of the current view and lays it out again. */
    relayout(): void {
        const view = this.view();
        if (view?.positions) this.updateView(view.key, { positions: undefined });
        this.layoutRequests.update(n => n + 1);
    }

    /**
     * Opens the next level down for an element: the containers of a system, the components of a
     * container (creating the view when the workspace has none), or the context of a person.
     */
    drillDown(id: string): void {
        const e = this.index().get(id);
        const type: C4ViewType | undefined = e?.type === 'softwareSystem' ? (this.workspace().elements.some(x => x.parent === id) ? 'container' : 'systemContext') : e?.type === 'container' ? 'component' : undefined;
        if (!e || !type) return;
        this.openView(type, id);
    }

    openView(type: C4ViewType, scope?: string): void {
        const existing = this.workspace().views.find(v => v.type === type && v.scope === scope);
        if (existing) return this.showView(existing.key);
        const name = scope ? (this.index().get(scope)?.name ?? scope) : 'landscape';
        const key = identifierFor(`${type} ${name}`, new Set(this.workspace().views.map(v => v.key)));
        this.edit(ws => ({ ...ws, views: [...ws.views, { type, key, ...(scope ? { scope } : {}), include: ['*'], exclude: [], autoLayout: { direction: type === 'container' || type === 'component' ? 'lr' : 'tb' } }] }));
        this.showView(key);
    }

    removeView(key: string): void {
        this.edit(ws => ({ ...ws, views: ws.views.filter(v => v.key !== key) }));
        this.viewKey.set(this.workspace().views[0]?.key ?? '');
    }

    /** The workspace (or the current view) in a text format. */
    exportText(format: C4ExportFormat): string {
        const ws = this.workspace();
        const view = this.view();
        if (format === 'dsl') return writeC4Dsl(ws);
        if (format === 'json') return `${JSON.stringify(ws, null, 2)}\n`;
        return view ? c4ViewToText(ws, view, format) : '';
    }

    markSaved(name?: string): void {
        if (name) this.fileName.set(name);
        this.dirty.set(false);
        this.persist();
    }

    private persist(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ workspace: this.workspace(), name: this.fileName(), view: this.viewKey() } satisfies Stored));
        } catch {
            // Storage full or blocked: the workspace lasts for this page only.
        }
    }
}
