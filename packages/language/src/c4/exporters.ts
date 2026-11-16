/**
 * A C4 view as C4-PlantUML (https://github.com/plantuml-stdlib/C4-PlantUML) or as a Mermaid C4
 * diagram (https://mermaid.js.org/syntax/c4.html): both use the same macros (Person, System,
 * Container, Component, their _Ext and Db forms, boundaries, Deployment_Node, Rel), drawn from
 * what viewContents() says the view shows.
 */
import { defaultRouting, elementStyle, type C4Element, type C4View, type C4Workspace } from './model.js';
import { viewContents, type C4ViewNode } from './views.js';

export type C4TextFormat = 'plantuml' | 'mermaid';

const PLANTUML_LIBRARY: Record<C4View['type'], string> = {
    systemLandscape: 'C4_Context',
    systemContext: 'C4_Context',
    container: 'C4_Container',
    component: 'C4_Component',
    dynamic: 'C4_Dynamic',
    deployment: 'C4_Deployment'
};

const MERMAID_DIAGRAM: Record<C4View['type'], string> = {
    systemLandscape: 'C4Context',
    systemContext: 'C4Context',
    container: 'C4Container',
    component: 'C4Component',
    dynamic: 'C4Dynamic',
    deployment: 'C4Deployment'
};

/** The view's direction, and right-angled lines when relationships are drawn so by default. */
function plantUmlLayout(ws: C4Workspace, view: C4View): string[] {
    return [...(view.autoLayout?.direction === 'lr' ? ['LAYOUT_LEFT_RIGHT()'] : []), ...(defaultRouting(ws) === 'Orthogonal' ? ['skinparam linetype ortho'] : [])];
}

export function c4ViewToText(ws: C4Workspace, view: C4View, format: C4TextFormat): string {
    const { nodes, edges } = viewContents(ws, view);
    const title = view.title ?? view.description ?? view.key;
    const out: string[] =
        format === 'plantuml'
            ? ['@startuml', `!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/${PLANTUML_LIBRARY[view.type]}.puml`, '', `title ${title}`, ...plantUmlLayout(ws, view), '']
            : [MERMAID_DIAGRAM[view.type], `    title ${title}`, ''];
    const children = new Map<string | undefined, C4ViewNode[]>();
    for (const n of nodes) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
    writeNodes(out, ws, children, undefined, 1);
    out.push('');
    for (const e of edges) {
        const label = e.order !== undefined ? `${e.order}. ${e.description ?? ''}` : (e.description ?? '');
        out.push(`    Rel(${alias(e.source)}, ${alias(e.target)}, ${quote(label)}${e.technology ? `, ${quote(e.technology)}` : ''})`);
    }
    if (format === 'plantuml') out.push('', 'SHOW_LEGEND()', '@enduml');
    return out.join('\n') + '\n';
}

function writeNodes(out: string[], ws: C4Workspace, children: Map<string | undefined, C4ViewNode[]>, parent: string | undefined, depth: number): void {
    const indent = '    '.repeat(depth);
    for (const n of children.get(parent) ?? []) {
        const inner = children.get(n.id);
        if (n.kind === 'element' && !inner) {
            out.push(indent + elementMacro(ws, n));
            continue;
        }
        out.push(`${indent}${boundaryMacro(n)} {`);
        writeNodes(out, ws, children, n.id, depth + 1);
        out.push(`${indent}}`);
    }
}

function elementMacro(ws: C4Workspace, n: C4ViewNode): string {
    const shown = n.base ?? n.element!;
    const external = [...shown.tags, ...(n.element?.tags ?? [])].some(t => /^external$/i.test(t)) ? '_Ext' : '';
    const shape = (elementStyle(ws, n.element!).shape ?? '').toLowerCase();
    const db = shape === 'cylinder' ? 'Db' : shape === 'pipe' ? 'Queue' : '';
    const desc = quote(n.description ?? '');
    switch (shown.type) {
        case 'person':
            return `Person${external}(${alias(n.id)}, ${quote(n.name)}, ${desc})`;
        case 'softwareSystem':
            return `System${db}${external}(${alias(n.id)}, ${quote(n.name)}, ${desc})`;
        case 'container':
        case 'component':
            return `${shown.type === 'container' ? 'Container' : 'Component'}${db}${external}(${alias(n.id)}, ${quote(n.name)}, ${quote(n.technology ?? '')}, ${desc})`;
        default:
            return `Node(${alias(n.id)}, ${quote(n.name)}, ${quote(n.technology ?? '')}, ${desc})`;
    }
}

function boundaryMacro(n: C4ViewNode): string {
    const e: C4Element | undefined = n.element;
    if (e?.type === 'deploymentNode') return `Deployment_Node(${alias(n.id)}, ${quote(n.name)}, ${quote(n.technology ?? '')}, ${quote(n.description ?? '')})`;
    if (e?.type === 'softwareSystem') return `System_Boundary(${alias(n.id)}, ${quote(n.name)})`;
    if (e?.type === 'container') return `Container_Boundary(${alias(n.id)}, ${quote(n.name)})`;
    return `Boundary(${alias(n.id)}, ${quote(n.name)})`;
}

/** An alias both languages accept: letters, digits and `_`. */
function alias(id: string): string {
    return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function quote(text: string): string {
    return `"${text.replace(/"/g, "'").replace(/\s*\n\s*/g, ' ')}"`;
}
