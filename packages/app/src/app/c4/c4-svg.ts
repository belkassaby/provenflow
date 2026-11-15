import type { NodeSingular } from 'cytoscape';
import { attr, num, text } from '../diagram-canvas/svg-export';

interface C4NodeData {
    kind: string;
    title: string[];
    typeLine: string;
    description: string[];
    bg: string;
    fg: string;
    stroke: string;
    border: string;
    borderWidth: number;
    cyShape: string;
    radius: number;
    opacity: number;
}

/**
 * A C4 box for the SVG export (the edges come from the shared exporter): the box in its shape
 * (rounded box, person, cylinder), its name in bold, `[type: technology]`, and the description;
 * a boundary as a dashed frame with its name below.
 */
export function renderC4Node(node: NodeSingular): string {
    const d = node.data() as C4NodeData;
    const dash = d.border === 'dashed' ? ' stroke-dasharray="6 4"' : d.border === 'dotted' ? ' stroke-dasharray="2 3"' : '';
    return node.isParent() ? boundary(node, d, dash) : box(node, d, dash);
}

/** A boundary: a dashed frame around its children, its name and type below. */
function boundary(node: NodeSingular, d: C4NodeData, dash: string): string {
    const bb = node.boundingBox({ includeLabels: false, includeOverlays: false });
    const lines = [d.title.join(' '), d.typeLine];
    const labels = lines.map((l, i) => `<text x="${num(bb.x1 + bb.w / 2)}" y="${num(bb.y2 + 16 + i * 14)}" text-anchor="middle" font-size="${i ? 10 : 12}" font-weight="${i ? 400 : 600}" fill="#3b4a52">${text(l)}</text>`);
    return `<g><rect x="${num(bb.x1)}" y="${num(bb.y1)}" width="${num(bb.w)}" height="${num(bb.h)}" rx="6" fill="${attr(d.bg)}" fill-opacity="0.06" stroke="${attr(d.stroke)}" stroke-width="${num(d.borderWidth)}"${dash}/>${labels.join('')}</g>`;
}

/** A box in its shape, with its name in bold, `[type: technology]` and the description, centred. */
function box(node: NodeSingular, d: C4NodeData, dash: string): string {
    const p = node.position();
    const w = node.width();
    const h = node.height();
    const x = p.x - w / 2;
    const y = p.y - h / 2;
    const fill = `fill="${attr(d.bg)}" stroke="${attr(d.stroke)}" stroke-width="${num(d.borderWidth)}"${dash}`;
    const shape = d.cyShape === 'barrel' ? cylinder(x, y, w, h, fill) : `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(d.cyShape === 'rectangle' ? 0 : d.radius)}" ${fill}/>`;
    const rows: Array<[string, number, number]> = [...d.title.map(t => [t, 13, 600] as [string, number, number]), [d.typeLine, 10.5, 400], ...(d.description.length ? [['', 6, 400] as [string, number, number]] : []), ...d.description.map(t => [t, 11, 400] as [string, number, number])];
    let cy = p.y - rows.reduce((s, [, size]) => s + size * 1.25, 0) / 2;
    const textRows = rows.map(([t, size, weight]) => {
        cy += size * 1.25;
        return t ? `<text x="${num(p.x)}" y="${num(cy - size * 0.3)}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${attr(d.fg)}">${text(t)}</text>` : '';
    });
    return `<g opacity="${num(d.opacity * node.effectiveOpacity())}">${shape}${textRows.join('')}</g>`;
}

function cylinder(x: number, y: number, w: number, h: number, fill: string): string {
    const ry = Math.min(12, h / 6);
    const body = `M ${num(x)} ${num(y + ry)} A ${num(w / 2)} ${num(ry)} 0 0 1 ${num(x + w)} ${num(y + ry)} L ${num(x + w)} ${num(y + h - ry)} A ${num(w / 2)} ${num(ry)} 0 0 1 ${num(x)} ${num(y + h - ry)} Z`;
    const rim = `M ${num(x)} ${num(y + ry)} A ${num(w / 2)} ${num(ry)} 0 0 0 ${num(x + w)} ${num(y + ry)}`;
    return `<path d="${body}" ${fill}/><path d="${rim}" fill="none" ${fill.replace(/fill="[^"]*"/, '')}/>`;
}
