/**
 * Writes a C4Workspace as Structurizr DSL: every element with its identifier (so relationships and
 * views can name it), nested as declared (containers in their system, components in their container,
 * groups kept), then the relationships, the deployment environments, the views and the styles.
 * Hand placement is not part of the DSL (its views lay out automatically): the JSON form keeps it.
 */
import type { C4Element, C4ElementStyle, C4RelationshipStyle, C4View, C4Workspace } from './model.js';

const KEYWORDS: Record<C4Element['type'], string> = {
    person: 'person',
    softwareSystem: 'softwareSystem',
    container: 'container',
    component: 'component',
    deploymentNode: 'deploymentNode',
    infrastructureNode: 'infrastructureNode',
    containerInstance: 'containerInstance',
    softwareSystemInstance: 'softwareSystemInstance'
};

/** A DSL string: quoted unless it is a plain word. */
export function dslString(text: string): string {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/** Arguments up to the last one given, the missing ones before it as "". */
function args(values: Array<string | undefined>): string {
    let last = values.length - 1;
    while (last >= 0 && !values[last]) last--;
    return values
        .slice(0, last + 1)
        .map(v => ` ${dslString(v ?? '')}`)
        .join('');
}

export function writeC4Dsl(ws: C4Workspace): string {
    const out: string[] = [`workspace${args([ws.name, ws.description])} {`, '', '    model {'];
    const children = childrenByParent(ws);
    writeChildren(out, children, undefined, (e: C4Element) => !e.environment, 2);
    if (ws.relationships.length) out.push('');
    for (const r of ws.relationships) out.push(`        ${r.id} = ${r.source} -> ${r.destination}${args([r.description, r.technology, r.tags.join(',')])}`);
    for (const env of ws.environments) {
        out.push('', `        ${env.id} = deploymentEnvironment ${dslString(env.name)} {`);
        for (const g of env.groups) out.push(`            ${g.id} = deploymentGroup ${dslString(g.name)}`);
        writeChildren(out, children, undefined, (e: C4Element) => e.environment === env.id, 3);
        out.push('        }');
    }
    out.push('    }', '', '    views {');
    for (const v of ws.views) writeView(out, v);
    writeStyles(out, ws.styles);
    out.push('    }', '}', '');
    return out.join('\n');
}

function childrenByParent(ws: C4Workspace): Map<string | undefined, C4Element[]> {
    const map = new Map<string | undefined, C4Element[]>();
    for (const e of ws.elements) {
        const list = map.get(e.parent) ?? [];
        list.push(e);
        map.set(e.parent, list);
    }
    return map;
}

/** The children of an element (or the top level), with consecutive members of a group inside a `group` block. */
function writeChildren(out: string[], children: Map<string | undefined, C4Element[]>, parent: string | undefined, keep: (e: C4Element) => boolean, depth: number): void {
    const list = (children.get(parent) ?? []).filter(keep);
    const groups = [...new Set(list.map(e => e.group))];
    for (const group of groups) {
        const members = list.filter(e => e.group === group);
        const indent = '    '.repeat(depth);
        if (group) out.push(`${indent}group ${dslString(group)} {`);
        for (const e of members) writeElement(out, children, e, depth + (group ? 1 : 0));
        if (group) out.push(`${indent}}`);
    }
}

function writeElement(out: string[], children: Map<string | undefined, C4Element[]>, e: C4Element, depth: number): void {
    const indent = '    '.repeat(depth);
    const head = `${indent}${e.id} = ${KEYWORDS[e.type]}${headArgs(e)}`;
    const body: string[] = [];
    if (e.url) body.push(`${indent}    url ${dslString(e.url)}`);
    const props = Object.entries(e.properties ?? {});
    if (props.length) body.push(`${indent}    properties {`, ...props.map(([k, v]) => `${indent}        ${dslString(k)} ${dslString(v)}`), `${indent}    }`);
    writeChildren(body, children, e.id, () => true, depth + 1);
    out.push(body.length ? `${head} {` : head, ...body, ...(body.length ? [`${indent}}`] : []));
}

function headArgs(e: C4Element): string {
    const tags = e.tags.join(',');
    switch (e.type) {
        case 'person':
        case 'softwareSystem':
            return args([e.name, e.description, tags]);
        case 'container':
        case 'component':
        case 'infrastructureNode':
            return args([e.name, e.description, e.technology, tags]);
        case 'deploymentNode':
            return args([e.name, e.description, e.technology, tags, e.instances]);
        default:
            return ` ${e.instanceOf ?? ''}${args([(e.deploymentGroups ?? []).join(','), tags])}`;
    }
}

const VIEW_KEYWORDS: Record<C4View['type'], string> = {
    systemLandscape: 'systemLandscape',
    systemContext: 'systemContext',
    container: 'container',
    component: 'component',
    dynamic: 'dynamic',
    deployment: 'deployment'
};

function writeView(out: string[], v: C4View): void {
    const scope = v.type === 'systemLandscape' ? '' : ` ${v.scope ?? '*'}`;
    const env = v.type === 'deployment' ? ` ${v.environment ?? ''}` : '';
    out.push(`        ${VIEW_KEYWORDS[v.type]}${scope}${env}${args([v.key, v.description])} {`);
    if (v.title) out.push(`            title ${dslString(v.title)}`);
    for (const s of v.steps ?? []) out.push(`            ${s.source} -> ${s.destination}${args([s.description, s.technology])}`);
    if (v.type !== 'dynamic') out.push(`            include ${v.include.length ? v.include.join(' ') : '*'}`);
    if (v.exclude.length) out.push(`            exclude ${v.exclude.join(' ')}`);
    const layout = v.autoLayout;
    if (layout) out.push(`            autoLayout ${layout.direction}${layout.rankSeparation !== undefined ? ` ${layout.rankSeparation}` : ''}${layout.nodeSeparation !== undefined ? ` ${layout.nodeSeparation}` : ''}`);
    out.push('        }', '');
}

function writeStyles(out: string[], styles: C4Workspace['styles']): void {
    if (!styles.elements.length && !styles.relationships.length) return;
    out.push('        styles {');
    for (const s of styles.elements) writeStyle(out, 'element', s);
    for (const s of styles.relationships) writeStyle(out, 'relationship', s);
    out.push('        }');
}

function writeStyle(out: string[], kind: string, s: C4ElementStyle | C4RelationshipStyle): void {
    out.push(`            ${kind} ${dslString(s.tag)} {`);
    for (const [k, v] of Object.entries(s)) if (k !== 'tag' && v !== undefined) out.push(`                ${k} ${String(v)}`);
    out.push('            }');
}
