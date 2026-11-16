/**
 * A C4 model (Simon Brown, https://c4model.com): people, software systems, containers and
 * components, the relationships between them, deployment environments, and the views that show
 * them at each level. It is the model behind the Structurizr DSL (`workspace.dsl`), which this
 * package reads and writes (see dsl-parse.ts and dsl-write.ts).
 */

export type C4ElementType =
    | 'person'
    | 'softwareSystem'
    | 'container'
    | 'component'
    | 'deploymentNode'
    | 'infrastructureNode'
    | 'softwareSystemInstance'
    | 'containerInstance';

export interface C4Element {
    /** The DSL identifier, unique in the workspace. */
    id: string;
    type: C4ElementType;
    name: string;
    description?: string;
    technology?: string;
    /** The element's own tags (the type's default tags, such as "Container", are implied). */
    tags: string[];
    /** The enclosing element: the software system of a container, the container of a component, the deployment node of a node or instance. */
    parent?: string;
    /** The group the element was declared in (`group "..." { }`). */
    group?: string;
    /** For deployment elements: the deployment environment's identifier. */
    environment?: string;
    /** For an instance: the container or software system it is an instance of. */
    instanceOf?: string;
    /** For an instance: the deployment groups it belongs to (identifiers). */
    deploymentGroups?: string[];
    /** For a deployment node: how many instances ("4", "1..N"). */
    instances?: string;
    url?: string;
    properties?: Record<string, string>;
}

export interface C4Relationship {
    id: string;
    source: string;
    destination: string;
    description?: string;
    technology?: string;
    tags: string[];
}

export interface C4DeploymentEnvironment {
    id: string;
    name: string;
    groups: Array<{ id: string; name: string }>;
}

export type C4ViewType = 'systemLandscape' | 'systemContext' | 'container' | 'component' | 'dynamic' | 'deployment';
export type C4Direction = 'tb' | 'bt' | 'lr' | 'rl';

export interface C4DynamicStep {
    source: string;
    destination: string;
    description?: string;
    technology?: string;
}

export interface C4View {
    type: C4ViewType;
    key: string;
    /** The element in scope: the software system (context, container), the container (component); `*` or a system for dynamic and deployment views. */
    scope?: string;
    /** For a deployment view: the environment's identifier. */
    environment?: string;
    title?: string;
    description?: string;
    /** `*`, or element identifiers. Empty means `*`. */
    include: string[];
    exclude: string[];
    autoLayout?: { direction: C4Direction; rankSeparation?: number; nodeSeparation?: number };
    /** For a dynamic view: the interactions, in order. */
    steps?: C4DynamicStep[];
    /** Where each element was placed by hand (ProvenFlow keeps these in its JSON form; the DSL lays views out automatically). */
    positions?: Record<string, { x: number; y: number }>;
    /** How a relationship of this view is drawn, by its id in the view, when it differs from its style (JSON form only, as in Structurizr's). */
    routing?: Record<string, C4Routing>;
    /** The side of its box each end of a relationship is attached to, by its id in the view (JSON form only; by default the line takes the shortest way). */
    anchors?: Record<string, C4Anchors>;
}

/** A side of a box: where a relationship's line can leave or reach it. */
export type C4Side = 'top' | 'right' | 'bottom' | 'left';
export const C4_SIDES: C4Side[] = ['top', 'right', 'bottom', 'left'];

/** The sides a relationship's line is attached to, at its source and at its target. */
export interface C4Anchors {
    source?: C4Side;
    target?: C4Side;
}

/** A view with one end of a relationship attached to a side (`undefined`: wherever is shortest). */
export function withAnchor(view: C4View, edgeId: string, end: keyof C4Anchors, side: C4Side | undefined): C4View {
    const { [edgeId]: current, ...others } = view.anchors ?? {};
    const next: C4Anchors = { ...current, [end]: side };
    const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as C4Anchors;
    const anchors = Object.keys(kept).length ? { ...others, [edgeId]: kept } : others;
    return { ...view, anchors: Object.keys(anchors).length ? anchors : undefined };
}

/** How a relationship's line is drawn (Structurizr's `routing`): straight, with right angles (drawn with rounded corners), or curved. */
export type C4Routing = 'Direct' | 'Orthogonal' | 'Curved';

export const C4_ROUTINGS: C4Routing[] = ['Direct', 'Orthogonal', 'Curved'];
export const C4_ROUTING_LABELS: Record<C4Routing, string> = { Direct: 'Straight', Orthogonal: 'Rounded angles', Curved: 'Curved' };

export interface C4ElementStyle {
    tag: string;
    background?: string;
    color?: string;
    stroke?: string;
    shape?: string;
    border?: 'solid' | 'dashed' | 'dotted';
    strokeWidth?: number;
    fontSize?: number;
    opacity?: number;
    width?: number;
    height?: number;
}

export interface C4RelationshipStyle {
    tag: string;
    color?: string;
    dashed?: boolean;
    style?: 'solid' | 'dashed' | 'dotted';
    thickness?: number;
    fontSize?: number;
    routing?: C4Routing;
}

export interface C4Workspace {
    name: string;
    description?: string;
    elements: C4Element[];
    relationships: C4Relationship[];
    environments: C4DeploymentEnvironment[];
    views: C4View[];
    styles: { elements: C4ElementStyle[]; relationships: C4RelationshipStyle[] };
}

/** The tags every element of a type has, in Structurizr's order (most general first). */
export const C4_TYPE_TAGS: Record<C4ElementType, string[]> = {
    person: ['Element', 'Person'],
    softwareSystem: ['Element', 'Software System'],
    container: ['Element', 'Container'],
    component: ['Element', 'Component'],
    deploymentNode: ['Element', 'Deployment Node'],
    infrastructureNode: ['Element', 'Infrastructure Node'],
    softwareSystemInstance: ['Software System Instance'],
    containerInstance: ['Container Instance']
};

export const C4_TYPE_LABELS: Record<C4ElementType, string> = {
    person: 'Person',
    softwareSystem: 'Software System',
    container: 'Container',
    component: 'Component',
    deploymentNode: 'Deployment Node',
    infrastructureNode: 'Infrastructure Node',
    softwareSystemInstance: 'Software System Instance',
    containerInstance: 'Container Instance'
};

export const C4_VIEW_LABELS: Record<C4ViewType, string> = {
    systemLandscape: 'System landscape',
    systemContext: 'System context',
    container: 'Containers',
    component: 'Components',
    dynamic: 'Dynamic',
    deployment: 'Deployment'
};

export function emptyWorkspace(name = 'Workspace'): C4Workspace {
    return { name, elements: [], relationships: [], environments: [], views: [], styles: { elements: [], relationships: [] } };
}

/** The elements of a workspace by identifier. */
export function elementIndex(ws: C4Workspace): Map<string, C4Element> {
    return new Map(ws.elements.map(e => [e.id, e]));
}

/** The element and its ancestors, innermost first. */
export function ancestry(index: Map<string, C4Element>, id: string): C4Element[] {
    const out: C4Element[] = [];
    const seen = new Set<string>();
    for (let e = index.get(id); e && !seen.has(e.id); e = e.parent ? index.get(e.parent) : undefined) {
        seen.add(e.id);
        out.push(e);
    }
    return out;
}

/** The element's tags, the type's default tags first: the order styles apply in. */
export function tagsOf(e: { type: C4ElementType; tags: string[] }): string[] {
    return [...C4_TYPE_TAGS[e.type], ...e.tags.filter(t => !C4_TYPE_TAGS[e.type].includes(t))];
}

/** The style of an element: the styles of its tags merged in order, the last one winning. */
export function elementStyle(ws: C4Workspace, e: C4Element, index?: Map<string, C4Element>): Omit<C4ElementStyle, 'tag'> {
    // An instance looks like the element it is an instance of, plus its own tags.
    const base = e.instanceOf ? (index ?? elementIndex(ws)).get(e.instanceOf) : undefined;
    const tags = base ? [...tagsOf(base), ...tagsOf(e)] : tagsOf(e);
    const out: Omit<C4ElementStyle, 'tag'> = {};
    for (const tag of tags) {
        for (const s of ws.styles.elements) if (s.tag === tag) Object.assign(out, withoutTag(s));
    }
    return out;
}

export function relationshipStyle(ws: C4Workspace, r: { tags: string[] }): Omit<C4RelationshipStyle, 'tag'> {
    const out: Omit<C4RelationshipStyle, 'tag'> = {};
    for (const tag of ['Relationship', ...r.tags]) {
        for (const s of ws.styles.relationships) if (s.tag === tag) Object.assign(out, withoutTag(s));
    }
    return out;
}

/** How a relationship is drawn in a view: as chosen for it in the view, else as its style says (straight by default). */
export function routingOf(ws: C4Workspace, view: C4View | undefined, edge: { id: string; tags: string[] }): C4Routing {
    return view?.routing?.[edge.id] ?? relationshipStyle(ws, edge).routing ?? 'Direct';
}

/** How relationships are drawn unless a style or a view says otherwise: the style of the `Relationship` tag. */
export function defaultRouting(ws: C4Workspace): C4Routing {
    return ws.styles.relationships.find(s => s.tag === 'Relationship')?.routing ?? 'Direct';
}

/** The workspace with every relationship drawn this way by default (in the `Relationship` style, so the DSL keeps it). */
export function withDefaultRouting(ws: C4Workspace, routing: C4Routing): C4Workspace {
    const routed = routing === 'Direct' ? undefined : routing;
    const relationships = ws.styles.relationships.some(s => s.tag === 'Relationship')
        ? ws.styles.relationships.map(s => (s.tag === 'Relationship' ? { ...s, routing: routed } : s))
        : [...ws.styles.relationships, { tag: 'Relationship', routing: routed }];
    // A style left with nothing but its tag is dropped.
    const kept = relationships.filter(s => Object.entries(s).some(([k, v]) => k !== 'tag' && v !== undefined));
    return { ...ws, styles: { ...ws.styles, relationships: kept } };
}

/** A routing written in the DSL, in any case (`orthogonal`, `Orthogonal`). */
export function parseRouting(text: string): C4Routing | undefined {
    return C4_ROUTINGS.find(r => r.toLowerCase() === text.toLowerCase());
}

function withoutTag<T extends { tag: string }>(s: T): Omit<T, 'tag'> {
    const { tag: _tag, ...rest } = s;
    return rest;
}

/** A DSL identifier made from a name (camelCase letters and digits), not yet used in `taken`. */
export function identifierFor(name: string, taken: { has(id: string): boolean }): string {
    const words = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    let base = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('') || 'element';
    if (/^[0-9]/.test(base)) base = `e${base}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
    return id;
}

/** Which element types may be declared inside which (Structurizr's nesting rules). */
export function allowedParents(type: C4ElementType): C4ElementType[] {
    switch (type) {
        case 'container':
            return ['softwareSystem'];
        case 'component':
            return ['container'];
        case 'deploymentNode':
        case 'infrastructureNode':
        case 'softwareSystemInstance':
        case 'containerInstance':
            return ['deploymentNode'];
        default:
            return [];
    }
}

/** Removes an element, its descendants, and every relationship and view position that refers to them. */
export function removeElement(ws: C4Workspace, id: string): C4Workspace {
    const gone = new Set([id]);
    for (let grew = true; grew; ) {
        grew = false;
        for (const e of ws.elements) {
            if (!gone.has(e.id) && ((e.parent && gone.has(e.parent)) || (e.instanceOf && gone.has(e.instanceOf)))) {
                gone.add(e.id);
                grew = true;
            }
        }
    }
    return {
        ...ws,
        elements: ws.elements.filter(e => !gone.has(e.id)),
        relationships: ws.relationships.filter(r => !gone.has(r.source) && !gone.has(r.destination)),
        views: ws.views
            .filter(v => !v.scope || !gone.has(v.scope))
            .map(v => ({ ...v, include: v.include.filter(i => !gone.has(i)), exclude: v.exclude.filter(i => !gone.has(i)), steps: v.steps?.filter(s => !gone.has(s.source) && !gone.has(s.destination)), positions: v.positions && Object.fromEntries(Object.entries(v.positions).filter(([k]) => !gone.has(k))) }))
    };
}
