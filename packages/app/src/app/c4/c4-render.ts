import type { ElementDefinition } from 'cytoscape';
import { elementStyle, relationshipStyle, type C4Element, type C4ElementType, type C4ViewContents, type C4ViewEdge, type C4ViewNode, type C4Workspace } from '@provenflow/language';

/** C4's own colours (c4model.com), for elements no style of the workspace covers. */
const DEFAULT_FILL: Record<C4ElementType, [string, string]> = {
    person: ['#08427b', '#ffffff'],
    softwareSystem: ['#1168bd', '#ffffff'],
    container: ['#438dd5', '#ffffff'],
    component: ['#85bbf0', '#000000'],
    deploymentNode: ['#ffffff', '#111111'],
    infrastructureNode: ['#ffffff', '#111111'],
    containerInstance: ['#438dd5', '#ffffff'],
    softwareSystemInstance: ['#1168bd', '#ffffff']
};
const EXTERNAL: [string, string] = ['#999999', '#ffffff'];

const WIDTH = 240;
const CHARS = 34;
const DESCRIPTION_LINES = 4;

/** Words wrapped to lines of at most `width` characters, cut with … after `max` lines. */
export function wrap(text: string, width: number, max: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > width) {
            lines.push(line);
            line = '';
        }
        line = line ? `${line} ${word}` : word.length > width ? `${word.slice(0, width - 1)}…` : word;
    }
    if (line) lines.push(line);
    return lines.length > max ? [...lines.slice(0, max - 1), `${lines[max - 1].slice(0, width - 1)}…`] : lines;
}

/** The lines drawn in a box: its name, `[type: technology]`, then the description. */
export function nodeLines(n: C4ViewNode): { title: string[]; kind: string; description: string[] } {
    return { title: wrap(n.name, CHARS - 6, 2), kind: `[${n.typeLabel}]`, description: n.kind === 'element' ? wrap(n.description ?? '', CHARS, DESCRIPTION_LINES) : [] };
}

function colours(ws: C4Workspace, n: C4ViewNode, index: Map<string, C4Element>): { bg: string; fg: string; stroke: string; shape: string; border: string; borderWidth: number; opacity: number } {
    const e = n.element;
    const style = e ? elementStyle(ws, e, index) : {};
    const shown = n.base ?? e;
    const external = [...(shown?.tags ?? []), ...(e?.tags ?? [])].some(t => /^external$/i.test(t));
    const [bg, fg] = external ? EXTERNAL : DEFAULT_FILL[shown?.type ?? 'deploymentNode'];
    return {
        bg: style.background ?? bg,
        fg: style.color ?? fg,
        stroke: style.stroke ?? (n.kind === 'element' ? shade(style.background ?? bg) : '#8a979e'),
        shape: (style.shape ?? (shown?.type === 'person' ? 'Person' : 'RoundedBox')).toLowerCase(),
        border: style.border ?? (n.kind === 'element' ? 'solid' : 'dashed'),
        borderWidth: style.strokeWidth ?? (n.kind === 'element' ? 2 : 1.5),
        opacity: (style.opacity ?? 100) / 100
    };
}

/** A darker version of a colour, for borders. */
function shade(hex: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return '#333333';
    const n = parseInt(m[1], 16);
    const c = (shift: number) => Math.round(((n >> shift) & 255) * 0.75);
    return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

const SHAPES: Record<string, string> = { cylinder: 'barrel', pipe: 'barrel', person: 'round-rectangle', box: 'rectangle', roundedbox: 'round-rectangle', ellipse: 'ellipse', circle: 'ellipse', hexagon: 'hexagon', component: 'rectangle', folder: 'rectangle', webbrowser: 'round-rectangle', mobiledeviceportrait: 'round-rectangle', mobiledevicelandscape: 'round-rectangle', robot: 'round-rectangle' };

/** The Cytoscape elements of a view: boxes (with C4 labels and the workspace's styles), boundaries, and relationships. */
export function cytoscapeElements(ws: C4Workspace, contents: C4ViewContents, index: Map<string, C4Element>, highlight: ReadonlySet<string>): ElementDefinition[] {
    return [...contents.nodes.map(n => nodeElement(ws, n, index, highlight)), ...contents.edges.map(e => edgeElement(ws, e))];
}

function nodeElement(ws: C4Workspace, n: C4ViewNode, index: Map<string, C4Element>, highlight: ReadonlySet<string>): ElementDefinition {
    const lines = nodeLines(n);
    const c = colours(ws, n, index);
    const description = lines.description.length ? ['', ...lines.description] : [];
    const label = n.kind === 'element' ? [...lines.title, lines.kind, ...description].join('\n') : `${n.name}\n${lines.kind}`;
    const height = 26 + (lines.title.length + 1 + description.length) * 15;
    const person = c.shape === 'person';
    const highlighted = highlight.has(n.id) || (!!n.base && highlight.has(n.base.id));
    return {
        group: 'nodes',
        data: { id: n.id, parent: n.parent, label, kind: n.kind, title: lines.title, typeLine: lines.kind, description: lines.description, w: WIDTH, h: person ? height + 10 : height, ...c, cyShape: SHAPES[c.shape] ?? 'round-rectangle', radius: person ? 28 : 8 },
        classes: highlighted ? `${n.kind} hl` : n.kind
    };
}

function edgeElement(ws: C4Workspace, e: C4ViewEdge): ElementDefinition {
    const style = relationshipStyle(ws, e);
    const description = e.order !== undefined ? `${e.order}. ${e.description ?? ''}` : (e.description ?? '');
    const text = [description, ...(e.technology ? [`[${e.technology}]`] : [])].map(l => wrap(l, 36, 2).join('\n')).filter(Boolean).join('\n');
    // Structurizr draws relationships dashed unless a style says otherwise.
    const lineStyle = style.style ?? (style.dashed === false ? 'solid' : 'dashed');
    return {
        group: 'edges',
        data: { id: e.id, source: e.source, target: e.target, label: text, color: style.color ?? '#707070', width: style.thickness ?? 1.5, lineStyle, implied: !!e.implied },
        classes: e.implied ? 'implied' : ''
    };
}
