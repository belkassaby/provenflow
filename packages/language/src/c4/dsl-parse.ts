/**
 * Reads a Structurizr DSL workspace (https://docs.structurizr.com/dsl/language) into a C4Workspace:
 * people, software systems, containers and components (with groups and tags), relationships,
 * deployment environments (nodes, infrastructure nodes, instances, deployment groups), the views
 * (landscape, context, container, component, dynamic, deployment) and their element and
 * relationship styles. What the model has no place for (themes, branding, documentation,
 * `!include`) is skipped with a warning, so a workspace written for Structurizr still opens.
 */
import { eachInBlock, lexDsl, skipBlock, type C4Diagnostic, type C4Statement, type C4Token, type StatementCursor } from './dsl-lex.js';
import { emptyWorkspace, identifierFor, type C4Direction, type C4Element, type C4ElementType, type C4View, type C4ViewType, type C4Workspace } from './model.js';
import { parseStyles } from './dsl-styles.js';

export type { C4Diagnostic } from './dsl-lex.js';

export interface C4ParseResult {
    workspace: C4Workspace;
    diagnostics: C4Diagnostic[];
}

/** A relationship or view as written, before its identifiers are resolved. */
interface RawRelationship {
    id?: string;
    source: string;
    destination: string;
    description?: string;
    technology?: string;
    tags: string[];
    line: number;
}

interface ParseState {
    stmts: C4Statement[];
    i: number;
    ws: C4Workspace;
    diagnostics: C4Diagnostic[];
    /** Every name an element can be referred to by (its identifier, and `parent.child`) → its identifier. */
    aliases: Map<string, string>;
    taken: Set<string>;
    relationships: RawRelationship[];
    views: Array<{ view: C4View; line: number }>;
}

const KEYWORD_TYPES: Record<string, C4ElementType> = {
    person: 'person',
    softwaresystem: 'softwareSystem',
    container: 'container',
    component: 'component',
    deploymentnode: 'deploymentNode',
    infrastructurenode: 'infrastructureNode',
    containerinstance: 'containerInstance',
    softwaresysteminstance: 'softwareSystemInstance'
};

/** Which elements each kind of block may declare. */
const CHILDREN: Record<string, C4ElementType[]> = {
    model: ['person', 'softwareSystem'],
    person: [],
    softwareSystem: ['container'],
    container: ['component'],
    component: [],
    environment: ['deploymentNode'],
    deploymentNode: ['deploymentNode', 'infrastructureNode', 'containerInstance', 'softwareSystemInstance'],
    infrastructureNode: [],
    containerInstance: [],
    softwareSystemInstance: []
};

/** Element arguments after the name, in order. */
const ARGUMENTS: Record<C4ElementType, Array<'description' | 'technology' | 'tags' | 'instances' | 'deploymentGroups'>> = {
    person: ['description', 'tags'],
    softwareSystem: ['description', 'tags'],
    container: ['description', 'technology', 'tags'],
    component: ['description', 'technology', 'tags'],
    deploymentNode: ['description', 'technology', 'tags', 'instances'],
    infrastructureNode: ['description', 'technology', 'tags'],
    containerInstance: ['deploymentGroups', 'tags'],
    softwareSystemInstance: ['deploymentGroups', 'tags']
};

export function parseC4Dsl(text: string): C4ParseResult {
    const diagnostics: C4Diagnostic[] = [];
    const st: ParseState = { stmts: lexDsl(text, diagnostics), i: 0, ws: emptyWorkspace(), diagnostics, aliases: new Map(), taken: new Set(), relationships: [], views: [] };
    while (st.i < st.stmts.length) {
        const s = st.stmts[st.i++];
        if (s.close) warn(st, s.line, 'Unexpected }.');
        else if (word(s, 0) === 'workspace' && s.open) workspaceBlock(st, s);
        else unknown(st, s, 'Expected `workspace { ... }`.');
    }
    resolveRelationships(st);
    resolveViews(st);
    return { workspace: st.ws, diagnostics };
}

/** The lower-cased keyword at a position (undefined for a quoted string). */
function word(s: C4Statement, n: number): string | undefined {
    const w = s.words[n];
    return w && !w.quoted ? w.text.toLowerCase() : undefined;
}

function warn(st: ParseState, line: number, message: string, severity: C4Diagnostic['severity'] = 'warning'): void {
    st.diagnostics.push({ line, severity, message });
}

/** Skips a statement the reader does not know (and its block). */
function unknown(st: ParseState, s: C4Statement, message: string): void {
    warn(st, s.line, message);
    if (s.open) skipBlock(st);
}

function workspaceBlock(st: ParseState, header: C4Statement): void {
    if (word(header, 1) === 'extends') warn(st, header.line, '`workspace extends` is not followed: only this file is read.');
    else {
        st.ws.name = header.words[1]?.text ?? st.ws.name;
        st.ws.description = header.words[2]?.text;
    }
    eachInBlock(st, s => {
        const key = word(s, 0);
        if (key === 'name' || key === 'description') st.ws[key] = s.words[1]?.text ?? '';
        else if (key === 'model' && s.open) eachInBlock(st, m => modelStatement(st, m, { block: 'model' }));
        else if (key === 'views' && s.open) viewsBlock(st);
        else if (key === '!identifiers' || key === '!impliedrelationships' || key === '!docs' || key === '!adrs' || key === '!decisions') return;
        else if (key === 'configuration' || key === 'properties') skipBlock(st);
        else unknown(st, s, `Unknown statement in workspace: ${s.words[0]?.text ?? '{'}.`);
    });
}

/** Where a model statement is: the kind of block, the element it belongs to, its group and deployment environment. */
interface Scope {
    block: string;
    current?: C4Element;
    group?: string;
    environment?: string;
}

/** A statement with its `id =` taken off. */
interface Assigned {
    s: C4Statement;
    words: C4Token[];
    id?: string;
    key?: string;
}

function assigned(s: C4Statement): Assigned {
    const named = s.words[1]?.text === '=' && !s.words[1].quoted && !s.words[0].quoted;
    const words = named ? s.words.slice(2) : s.words;
    return { s, words, id: named ? s.words[0].text : undefined, key: words[0] && !words[0].quoted ? words[0].text.toLowerCase() : undefined };
}

const hasArrow = (words: C4Token[]) => words.some(w => !w.quoted && w.text === '->');
const IGNORED = new Set(['!docs', '!adrs', '!decisions', '!impliedrelationships', '!identifiers']);

/**
 * One statement inside the model or an element (or a group, or a deployment environment):
 * a nested element, a group, a relationship, or one of the element's own properties.
 */
function modelStatement(st: ParseState, s: C4Statement, scope: Scope): void {
    const a = assigned(s);
    const type = a.key ? KEYWORD_TYPES[a.key] : undefined;
    if (hasArrow(a.words)) return relationship(st, a, scope.current);
    if (type && CHILDREN[scope.block]?.includes(type)) return declare(st, a, type, scope);
    if (blockStatement(st, a, scope)) return;
    if (scope.current && elementProperty(st, s, a.key, a.words, scope.current)) return;
    if (IGNORED.has(a.key ?? '')) return;
    unknown(st, s, type ? `A ${a.words[0].text} cannot be declared here.` : `Unknown statement: ${a.words[0]?.text ?? '{'}.`);
}

/** `group`, `deploymentEnvironment`, `deploymentGroup`, `enterprise` and `!element` blocks. */
function blockStatement(st: ParseState, a: Assigned, scope: Scope): boolean {
    const { s, key, words } = a;
    const inModel = scope.block === 'model';
    if (key === 'group' && s.open) eachInBlock(st, x => modelStatement(st, x, { ...scope, group: words[1]?.text }));
    else if (key === 'deploymentenvironment' && s.open && inModel) environmentBlock(st, words, a.id);
    else if (key === 'deploymentgroup' && scope.block === 'environment') deploymentGroup(st, words, a.id, scope.environment);
    else if (key === 'enterprise' && s.open && inModel) eachInBlock(st, x => modelStatement(st, x, scope));
    else if ((key === '!element' || key === '!extend') && s.open) extendElement(st, s, words);
    else return false;
    return true;
}

/** `tags`, `description`, `technology`, `url`, `instances`, `properties { }`, `perspectives { }` of the current element. */
function elementProperty(st: ParseState, s: C4Statement, key: string | undefined, words: C4Token[], current: C4Element): boolean {
    const value = words[1]?.text;
    if ((key === 'tags' || key === 'tag') && !s.open) current.tags.push(...words.slice(1).flatMap(w => splitList(w.text)).filter(t => !current.tags.includes(t)));
    else if ((key === 'description' || key === 'technology' || key === 'url' || key === 'instances') && value !== undefined && !s.open) current[key] = value;
    else if (key === 'properties' && s.open) current.properties = { ...current.properties, ...readProperties(st) };
    else if (key === 'perspectives' && s.open) skipBlock(st);
    else return false;
    return true;
}

export function readProperties(st: StatementCursor): Record<string, string> {
    const out: Record<string, string> = {};
    eachInBlock(st, p => {
        if (p.words.length >= 2) out[p.words[0].text] = p.words[1].text;
        if (p.open) skipBlock(st);
    });
    return out;
}

export function splitList(text: string): string[] {
    return text.split(',').map(t => t.trim()).filter(Boolean);
}

/** An element from its keyword's arguments: name (or, for an instance, what it is an instance of), then the type's own. */
function elementOf(type: C4ElementType, words: C4Token[]): C4Element {
    const instance = type === 'containerInstance' || type === 'softwareSystemInstance';
    const e: C4Element = { id: '', type, name: instance ? '' : (words[1]?.text ?? ''), tags: [], ...(instance ? { instanceOf: words[1]?.text } : {}) };
    ARGUMENTS[type].forEach((arg, n) => {
        const value = words[n + 2]?.text;
        if (!value) return;
        if (arg === 'tags' || arg === 'deploymentGroups') e[arg] = splitList(value);
        else e[arg] = value;
    });
    return e;
}

function declare(st: ParseState, a: Assigned, type: C4ElementType, scope: Scope): void {
    const e = elementOf(type, a.words);
    if (!e.instanceOf && !e.name) warn(st, a.s.line, `This ${a.words[0].text} has no name.`, 'error');
    if (scope.current) e.parent = scope.current.id;
    if (scope.group) e.group = scope.group;
    if (scope.environment) e.environment = scope.environment;
    e.id = register(st, e, a.id, scope.current);
    st.ws.elements.push(e);
    if (a.s.open) eachInBlock(st, x => modelStatement(st, x, { block: type, current: e, environment: scope.environment }));
}

/** Gives the element a unique identifier, and records the names it can be referred to by. */
function register(st: ParseState, e: C4Element, written: string | undefined, parent: C4Element | undefined): string {
    const base = written ?? (e.type.endsWith('Instance') ? `${e.instanceOf ?? 'instance'}Instance` : identifierFor(e.name, st.taken));
    const id = st.taken.has(base) ? identifierFor(base, st.taken) : base;
    st.taken.add(id);
    if (written) {
        if (!st.aliases.has(written)) st.aliases.set(written, id);
        const parentAlias = parent && [...st.aliases.entries()].find(([, v]) => v === parent.id)?.[0];
        if (parentAlias) st.aliases.set(`${parentAlias}.${written}`, id);
    }
    st.aliases.set(id, id);
    return id;
}

/** `a -> b`, `-> b` (from the current element), `this -> b`, with description, technology and tags. */
function relationship(st: ParseState, a: Assigned, current: C4Element | undefined): void {
    const { s, words } = a;
    const arrow = words.findIndex(w => !w.quoted && w.text === '->');
    const source = arrow === 0 || words[0].text === 'this' ? current?.id : words[0].text;
    const rest = words.slice(arrow + 1);
    if (!source || !rest[0]) {
        warn(st, s.line, 'A relationship needs a source and a destination.', 'error');
        if (s.open) skipBlock(st);
        return;
    }
    const destination = rest[0].text === 'this' ? (current?.id ?? 'this') : rest[0].text;
    const r: RawRelationship = { id: a.id, source, destination, description: rest[1]?.text || undefined, technology: rest[2]?.text || undefined, tags: splitList(rest[3]?.text ?? ''), line: s.line };
    st.relationships.push(r);
    if (s.open) eachInBlock(st, x => relationshipProperty(st, x, r));
}

function relationshipProperty(st: ParseState, x: C4Statement, r: RawRelationship): void {
    const key = word(x, 0);
    if (key === 'tags' || key === 'tag') r.tags.push(...x.words.slice(1).flatMap(w => splitList(w.text)));
    else if ((key === 'description' || key === 'technology') && x.words[1]) r[key] = x.words[1].text;
    else if (x.open) skipBlock(st);
}

function environmentBlock(st: ParseState, words: C4Token[], id: string | undefined): void {
    const name = words[1]?.text ?? 'Default';
    const envId = id ?? identifierFor(name, st.taken);
    st.taken.add(envId);
    st.ws.environments.push({ id: envId, name, groups: [] });
    eachInBlock(st, x => modelStatement(st, x, { block: 'environment', environment: envId }));
}

function deploymentGroup(st: ParseState, words: C4Token[], id: string | undefined, environment: string | undefined): void {
    const env = st.ws.environments.find(e => e.id === environment);
    const name = words[1]?.text ?? '';
    env?.groups.push({ id: id ?? name, name });
}

function extendElement(st: ParseState, s: C4Statement, words: C4Token[]): void {
    const target = st.aliases.get(words[1]?.text ?? '');
    const e = st.ws.elements.find(x => x.id === target);
    if (!e) return unknown(st, s, `${words[0].text}: no element ${words[1]?.text ?? ''}.`);
    eachInBlock(st, x => modelStatement(st, x, { block: e.type, current: e, environment: e.environment }));
}

/** The written identifier when it is free, else the next free `relN`. */
function relationshipId(st: ParseState, written: string | undefined): string {
    let id = written && !st.taken.has(written) ? written : undefined;
    for (let n = st.taken.size; !id; n++) if (!st.taken.has(`rel${n}`)) id = `rel${n}`;
    st.taken.add(id);
    return id;
}

function resolveRelationships(st: ParseState): void {
    for (const r of st.relationships) {
        const source = st.aliases.get(r.source);
        const destination = st.aliases.get(r.destination);
        if (source && destination) st.ws.relationships.push({ id: relationshipId(st, r.id), source, destination, description: r.description, technology: r.technology, tags: r.tags });
        else warn(st, r.line, `Relationship ${r.source} -> ${r.destination}: no element ${source ? r.destination : r.source}.`, 'error');
    }
    for (const e of st.ws.elements.filter(x => x.instanceOf)) {
        e.instanceOf = st.aliases.get(e.instanceOf!) ?? e.instanceOf;
        if (!e.name) e.name = st.ws.elements.find(x => x.id === e.instanceOf)?.name ?? e.instanceOf ?? '';
    }
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

const VIEW_KEYWORDS: Record<string, C4ViewType> = {
    systemlandscape: 'systemLandscape',
    systemcontext: 'systemContext',
    container: 'container',
    component: 'component',
    dynamic: 'dynamic',
    deployment: 'deployment'
};

function viewsBlock(st: ParseState): void {
    eachInBlock(st, s => {
        const key = word(s, 0) ?? '';
        const type = VIEW_KEYWORDS[key];
        if (type && s.open) viewBlock(st, s, type);
        else if (key === 'styles' && s.open) addStyles(st.ws, parseStyles(st, (line, message) => warn(st, line, message)));
        else if (key === 'theme' || key === 'themes') return;
        else if (['branding', 'terminology', 'properties', 'configuration'].includes(key) && s.open) skipBlock(st);
        else if (key === 'filtered' || key === 'image' || key === 'custom') unknown(st, s, `${s.words[0].text} views are not shown: they are skipped.`);
        else unknown(st, s, `Unknown statement in views: ${s.words[0]?.text ?? '{'}.`);
    });
}

function addStyles(ws: C4Workspace, styles: C4Workspace['styles']): void {
    ws.styles = { elements: [...ws.styles.elements, ...styles.elements], relationships: [...ws.styles.relationships, ...styles.relationships] };
}

function viewBlock(st: ParseState, s: C4Statement, type: C4ViewType): void {
    const args = s.words.slice(1).map(w => w.text);
    const scoped = type !== 'systemLandscape';
    const view: C4View = { type, key: '', include: [], exclude: [] };
    if (scoped) view.scope = args.shift();
    if (type === 'deployment') view.environment = args.shift();
    view.key = args[0] || `${type}-${String(st.views.length + 1).padStart(3, '0')}`;
    if (args[1]) view.description = args[1];
    st.views.push({ view, line: s.line });
    eachInBlock(st, x => viewStatement(st, x, view));
}

function viewStatement(st: ParseState, s: C4Statement, view: C4View): void {
    const key = word(s, 0);
    const args = s.words.slice(1).map(w => w.text);
    if (key === 'include' || key === 'exclude') view[key].push(...args);
    else if (key === 'autolayout') view.autoLayout = autoLayoutOf(args);
    else if ((key === 'title' || key === 'description') && args[0] !== undefined) view[key] = args[0];
    else if (!dynamicStatement(st, s, view) && key !== 'default') otherViewStatement(st, s, key);
}

function autoLayoutOf(args: string[]): NonNullable<C4View['autoLayout']> {
    const direction = (['tb', 'bt', 'lr', 'rl'].includes(args[0]) ? args[0] : 'tb') as C4Direction;
    return { direction, ...(args[1] ? { rankSeparation: Number(args[1]) } : {}), ...(args[2] ? { nodeSeparation: Number(args[2]) } : {}) };
}

/** A step of a dynamic view, or a `{ }` of parallel steps. */
function dynamicStatement(st: ParseState, s: C4Statement, view: C4View): boolean {
    if (view.type !== 'dynamic') return false;
    if (hasArrow(s.words)) dynamicStep(st, s, view);
    else if (s.open && s.words.length === 0) eachInBlock(st, x => viewStatement(st, x, view));
    else return false;
    return true;
}

function otherViewStatement(st: ParseState, s: C4Statement, key: string | undefined): void {
    if (s.open) skipBlock(st);
    else if (key !== 'animation') warn(st, s.line, `Unknown statement in a view: ${s.words[0]?.text ?? ''}.`);
}

function dynamicStep(st: ParseState, s: C4Statement, view: C4View): void {
    const words = s.words[1]?.text === '=' ? s.words.slice(2) : s.words;
    const arrow = words.findIndex(w => !w.quoted && w.text === '->');
    const step = { source: words[arrow - 1]?.text ?? '', destination: words[arrow + 1]?.text ?? '', description: words[arrow + 2]?.text || undefined, technology: words[arrow + 3]?.text || undefined };
    (view.steps ??= []).push(step);
    if (s.open) skipBlock(st);
}

function resolveViews(st: ParseState): void {
    const resolve = (ref: string | undefined) => (ref === undefined || ref === '*' ? ref : st.aliases.get(ref));
    for (const { view, line } of st.views) {
        if (view.scope !== undefined && view.scope !== '*') {
            const scope = resolve(view.scope);
            if (!scope) {
                warn(st, line, `View ${view.key}: no element ${view.scope}.`, 'error');
                continue;
            }
            view.scope = scope;
        }
        if (view.environment) view.environment = st.ws.environments.find(e => e.id === view.environment || e.name === view.environment)?.id ?? view.environment;
        view.include = view.include.map(i => resolve(i) ?? i);
        view.exclude = view.exclude.map(i => resolve(i) ?? i);
        view.steps = view.steps?.filter(step => {
            const source = resolve(step.source);
            const destination = resolve(step.destination);
            if (!source || !destination) warn(st, line, `View ${view.key}: step ${step.source} -> ${step.destination} names no element.`, 'error');
            return !!(source && destination && Object.assign(step, { source, destination }));
        });
        st.ws.views.push(view);
    }
}
