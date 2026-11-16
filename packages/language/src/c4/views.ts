/**
 * What a view shows, as Structurizr draws it: the elements at the view's level (`include *`, plus
 * and minus the identifiers it includes and excludes), the boundaries around them (the system of a
 * container view, the container of a component view, groups, deployment nodes), and the
 * relationships between them, the relationships of nested elements shown on their visible ancestor
 * (implied relationships). Every renderer (the editor, SVG, PlantUML, Mermaid) draws from this.
 */
import { C4_TYPE_LABELS, elementIndex, type C4Element, type C4View, type C4Workspace } from './model.js';

export interface C4ViewNode {
    id: string;
    kind: 'element' | 'boundary' | 'group';
    /** The element (absent for a group). For an instance, the instance; `base` is what it is an instance of. */
    element?: C4Element;
    base?: C4Element;
    name: string;
    /** "Container: Angular", "Person", "Deployment Node: Kubernetes". */
    typeLabel: string;
    description?: string;
    technology?: string;
    /** The boundary or group this node is drawn in. */
    parent?: string;
}

export interface C4ViewEdge {
    id: string;
    source: string;
    target: string;
    description?: string;
    technology?: string;
    tags: string[];
    /** The relationship it shows (for an implied one, the nested relationship it comes from). */
    relationship?: string;
    /** Shown on an ancestor of its source or destination rather than between them. */
    implied?: boolean;
    /** The step number in a dynamic view. */
    order?: number;
}

export interface C4ViewContents {
    nodes: C4ViewNode[];
    edges: C4ViewEdge[];
}

type Index = Map<string, C4Element>;

export function viewContents(ws: C4Workspace, view: C4View): C4ViewContents {
    const index = elementIndex(ws);
    if (view.type === 'dynamic') return dynamicContents(ws, view, index);
    if (view.type === 'deployment') return deploymentContents(ws, view, index);
    return staticContents(ws, view, index);
}

/** The node of an element: its labels, from the element it is an instance of when it is an instance. */
export function nodeOf(e: C4Element, index: Index, kind: C4ViewNode['kind'] = 'element', parent?: string): C4ViewNode {
    const base = e.instanceOf ? index.get(e.instanceOf) : undefined;
    const shown = base ?? e;
    const technology = e.technology ?? shown.technology;
    const typeLabel = C4_TYPE_LABELS[shown.type] + (technology && shown.type !== 'person' && shown.type !== 'softwareSystem' ? `: ${technology}` : '');
    return { id: e.id, kind, element: e, base, name: shown.name, typeLabel, description: e.description ?? shown.description, technology, ...(parent ? { parent } : {}) };
}

function topLevel(index: Index, id: string): C4Element | undefined {
    let e = index.get(id);
    // Deployment elements belong to deployment views only.
    if (e?.environment) return undefined;
    while (e?.parent && index.get(e.parent)) e = index.get(e.parent);
    return e;
}

/** The ancestor of an element (or the element) whose parent is `parent`. */
function childOf(index: Index, id: string, parent: string): C4Element | undefined {
    for (let e = index.get(id); e; e = e.parent ? index.get(e.parent) : undefined) if (e.parent === parent) return e;
    return undefined;
}

/** For a static view: the element that represents `id` at the view's level. */
function projector(view: C4View, index: Index): (id: string) => string | undefined {
    const scope = view.scope ? index.get(view.scope) : undefined;
    if (view.type === 'container' && scope) return id => childOf(index, id, scope.id)?.id ?? (id === scope.id ? scope.id : topLevel(index, id)?.id);
    if (view.type === 'component' && scope) {
        const system = scope.parent;
        return id => childOf(index, id, scope.id)?.id ?? (id === scope.id ? scope.id : (system && childOf(index, id, system)?.id) || topLevel(index, id)?.id);
    }
    return id => topLevel(index, id)?.id;
}

function staticContents(ws: C4Workspace, view: C4View, index: Index): C4ViewContents {
    const project = projector(view, index);
    const boundary = view.type === 'container' || view.type === 'component' ? view.scope : undefined;
    const shown = staticElements(ws, view, index, project, boundary);
    const nodes: C4ViewNode[] = [];
    if (boundary && index.get(boundary)) nodes.push(nodeOf(index.get(boundary)!, index, 'boundary'));
    for (const id of shown) nodes.push(nodeOf(index.get(id)!, index, 'element', boundary && index.get(id)!.parent === boundary ? boundary : undefined));
    return { nodes: withGroups(nodes), edges: projectedEdges(ws, view, project, shown) };
}

function staticElements(ws: C4Workspace, view: C4View, index: Index, project: (id: string) => string | undefined, boundary: string | undefined): Set<string> {
    const star = view.include.length === 0 || view.include.includes('*');
    const shown = new Set<string>(star ? starElements(ws, view, project, boundary) : view.type === 'systemContext' && view.scope ? [view.scope] : []);
    for (const id of view.include) if (index.has(id) && id !== boundary) shown.add(id);
    for (const id of view.exclude) shown.delete(id);
    return shown;
}

/** What `include *` shows: the view's own elements, and (below the landscape) those connected to them. */
function starElements(ws: C4Workspace, view: C4View, project: (id: string) => string | undefined, boundary: string | undefined): string[] {
    if (view.type === 'systemLandscape') return ws.elements.filter(e => (e.type === 'person' || e.type === 'softwareSystem') && !e.parent).map(e => e.id);
    const core = boundary ? ws.elements.filter(e => e.parent === boundary).map(e => e.id) : view.scope ? [view.scope] : [];
    return [...core, ...connectedTo(ws, project, new Set(core))];
}

/** The elements (at the view's level) with a relationship to or from one of `core`. */
function connectedTo(ws: C4Workspace, project: (id: string) => string | undefined, core: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const r of ws.relationships) {
        const s = project(r.source);
        const d = project(r.destination);
        if (!s || !d || s === d) continue;
        if (core.has(s) && !core.has(d)) out.add(d);
        if (core.has(d) && !core.has(s)) out.add(s);
    }
    for (const id of core) out.delete(id);
    return out;
}

/** One edge per pair of shown elements: the relationship between them when there is one, else the first implied one. */
function projectedEdges(ws: C4Workspace, view: C4View, project: (id: string) => string | undefined, shown: Set<string>): C4ViewEdge[] {
    const edges = new Map<string, C4ViewEdge>();
    for (const r of ws.relationships) {
        if (view.exclude.includes(r.id)) continue;
        const s = project(r.source);
        const d = project(r.destination);
        if (!s || !d || s === d || !shown.has(s) || !shown.has(d)) continue;
        const key = `${s}>${d}`;
        const direct = r.source === s && r.destination === d;
        const existing = edges.get(key);
        if (existing && (existing.implied === false || !direct)) continue;
        edges.set(key, { id: direct ? r.id : `${r.id}@${s}>${d}`, source: s, target: d, description: r.description, technology: r.technology, tags: r.tags, relationship: r.id, implied: !direct });
    }
    return [...edges.values()];
}

/** Puts the elements declared in a `group` inside a group node (within their boundary, if any). */
function withGroups(nodes: C4ViewNode[]): C4ViewNode[] {
    const groups = new Map<string, C4ViewNode>();
    const out = nodes.map(n => {
        const group = n.kind === 'element' ? n.element?.group : undefined;
        if (!group) return n;
        const id = `group:${n.parent ?? ''}:${group}`;
        if (!groups.has(id)) groups.set(id, { id, kind: 'group', name: group, typeLabel: 'Group', ...(n.parent ? { parent: n.parent } : {}) });
        return { ...n, parent: id };
    });
    // Parents first, so compound nodes exist before their children.
    return [...out.filter(n => n.kind === 'boundary'), ...groups.values(), ...out.filter(n => n.kind !== 'boundary')];
}

function dynamicContents(ws: C4Workspace, view: C4View, index: Index): C4ViewContents {
    const scope = view.scope && view.scope !== '*' ? index.get(view.scope) : undefined;
    const ids = [...new Set((view.steps ?? []).flatMap(s => [s.source, s.destination]))].filter(id => index.has(id));
    const nodes: C4ViewNode[] = scope ? [nodeOf(scope, index, 'boundary')] : [];
    for (const id of ids) if (id !== scope?.id) nodes.push(nodeOf(index.get(id)!, index, 'element', scope && index.get(id)!.parent === scope.id ? scope.id : undefined));
    const edges = (view.steps ?? []).map((s, i) => {
        const r = ws.relationships.find(x => x.source === s.source && x.destination === s.destination);
        return { id: `step${i + 1}`, source: s.source, target: s.destination, description: s.description ?? r?.description, technology: s.technology ?? r?.technology, tags: r?.tags ?? [], relationship: r?.id, order: i + 1 };
    });
    return { nodes, edges: edges.filter(e => e.source !== scope?.id && e.target !== scope?.id) };
}

function deploymentContents(ws: C4Workspace, view: C4View, index: Index): C4ViewContents {
    const inEnv = ws.elements.filter(e => e.environment === view.environment);
    const scope = view.scope && view.scope !== '*' ? view.scope : undefined;
    const wanted = (e: C4Element) => e.type === 'infrastructureNode' || e.type === 'softwareSystemInstance' || (e.type === 'containerInstance' && (!scope || index.get(e.instanceOf ?? '')?.parent === scope));
    const leaves = inEnv.filter(e => wanted(e) && !view.exclude.includes(e.id));
    const kept = new Set<string>();
    for (const leaf of leaves) for (let e: C4Element | undefined = leaf; e && !kept.has(e.id); e = e.parent ? index.get(e.parent) : undefined) kept.add(e.id);
    const nodes = inEnv.filter(e => kept.has(e.id)).map(e => nodeOf(e, index, e.type === 'deploymentNode' ? 'boundary' : 'element', e.parent));
    const order = (n: C4ViewNode) => depth(index, n.id);
    return { nodes: nodes.sort((a, b) => order(a) - order(b)), edges: instanceEdges(ws, index, leaves) };
}

function depth(index: Index, id: string): number {
    let n = 0;
    for (let e = index.get(id); e?.parent; e = index.get(e.parent)) n++;
    return n;
}

/** The relationships between deployed elements: their own, and those of the containers they are instances of. */
function instanceEdges(ws: C4Workspace, index: Index, leaves: C4Element[]): C4ViewEdge[] {
    const shown = new Set(leaves.map(e => e.id));
    const byBase = new Map<string, C4Element[]>();
    for (const e of leaves) if (e.instanceOf) byBase.set(e.instanceOf, [...(byBase.get(e.instanceOf) ?? []), e]);
    const edges = new Map<string, C4ViewEdge>();
    // Shown on its own ends, or on instances of what it connects (implied).
    const add = (s: string, d: string, r: (typeof ws.relationships)[number]) => {
        const key = `${s}>${d}`;
        const implied = !(shown.has(r.source) && shown.has(r.destination));
        if (s !== d && !edges.has(key)) edges.set(key, { id: implied ? `${r.id}@${s}>${d}` : r.id, source: s, target: d, description: r.description, technology: r.technology, tags: r.tags, relationship: r.id, implied });
    };
    // An end that is shown is itself; a container (or a component's container) is each of its instances.
    const ends = (id: string) => (shown.has(id) ? [index.get(id)!] : (byBase.get(deployable(index, id)) ?? []));
    for (const r of ws.relationships) for (const a of ends(r.source)) for (const b of ends(r.destination)) if (sameGroup(a, b)) add(a.id, b.id, r);
    return [...edges.values()];
}

/** The container (for a component) or the element itself: what instances are made of. */
function deployable(index: Index, id: string): string {
    const e = index.get(id);
    return e?.type === 'component' && e.parent ? e.parent : id;
}

function sameGroup(a: C4Element, b: C4Element): boolean {
    const ga = a.deploymentGroups ?? [];
    const gb = b.deploymentGroups ?? [];
    return ga.length === 0 || gb.length === 0 || ga.some(g => gb.includes(g));
}
