import type { Core, EdgeSingular, NodeSingular, Position } from 'cytoscape';

/**
 * Renders the current Cytoscape drawing as a standalone SVG document, from the
 * geometry Cytoscape computed (node boxes, edge endpoints and bezier control
 * points, label positions) and the resolved style of every element, so the
 * file matches what is on screen, including trace highlighting.
 */
export function cytoscapeToSvg(cy: Core, background: string, nodeRenderer: (node: NodeSingular) => string = renderNode): string {
    const elements = cy.elements();
    if (elements.length === 0) return svgDocument({ x1: 0, y1: 0, w: 200, h: 100 }, background, '');
    const bb = elements.boundingBox({ includeLabels: true, includeOverlays: false });
    const pad = 24;
    const box = { x1: bb.x1 - pad, y1: bb.y1 - pad, w: bb.w + 2 * pad, h: bb.h + 2 * pad };

    const parts: string[] = [];
    cy.edges().forEach(edge => {
        parts.push(renderEdge(edge));
    });
    cy.nodes().forEach(node => {
        parts.push(nodeRenderer(node));
    });
    // Edge labels on top, so that nodes never hide them.
    cy.edges().forEach(edge => {
        parts.push(renderEdgeLabel(edge));
    });
    return svgDocument(box, background, parts.join('\n'));
}

function svgDocument(box: { x1: number; y1: number; w: number; h: number }, background: string, body: string): string {
    const r = (n: number) => Math.round(n * 100) / 100;
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(box.x1)} ${r(box.y1)} ${r(box.w)} ${r(box.h)}" width="${r(box.w)}" height="${r(box.h)}" font-family="Inter, system-ui, -apple-system, 'Segoe UI', sans-serif">`,
        `<rect x="${r(box.x1)}" y="${r(box.y1)}" width="${r(box.w)}" height="${r(box.h)}" fill="${attr(background)}"/>`,
        body,
        '</svg>',
        ''
    ].join('\n');
}

function renderNode(node: NodeSingular): string {
    const p = node.position();
    const w = node.width();
    const h = node.height();
    const fill = node.style('background-color') as string;
    const stroke = node.style('border-color') as string;
    const bw = node.numericStyle('border-width') as number;
    const borderStyle = node.style('border-style') as string;
    const opacity = node.effectiveOpacity();
    const g: string[] = [`<g opacity="${num(opacity)}">`];

    if (borderStyle === 'double') {
        // Two thin rings, like Cytoscape's double border.
        const t = Math.max(1, bw / 3);
        g.push(ellipse(p, w / 2, h / 2, fill, stroke, t));
        g.push(ellipse(p, w / 2 - 2 * t, h / 2 - 2 * t, 'none', stroke, t));
    } else {
        const dash = borderStyle === 'dashed' ? ` stroke-dasharray="${num(bw * 3)} ${num(bw * 2)}"` : borderStyle === 'dotted' ? ` stroke-dasharray="${num(bw)} ${num(bw * 1.5)}"` : '';
        g.push(ellipse(p, w / 2, h / 2, fill, stroke, bw, dash));
    }

    const label = String(node.style('label') ?? '');
    if (label) {
        const size = node.numericStyle('font-size') as number;
        const lines = label.split('\n');
        const lineHeight = size * 1.2;
        const top = p.y - ((lines.length - 1) * lineHeight) / 2;
        const color = node.style('color') as string;
        const weight = node.style('font-weight') as string;
        const tspans = lines.map((line, i) => `<tspan x="${num(p.x)}" y="${num(top + i * lineHeight)}">${text(line)}</tspan>`).join('');
        g.push(`<text text-anchor="middle" dominant-baseline="central" font-size="${num(size)}" font-weight="${attr(weight)}" fill="${attr(color)}">${tspans}</text>`);
    }
    g.push('</g>');
    return g.join('');
}

function renderEdge(edge: EdgeSingular): string {
    const src = edge.sourceEndpoint();
    const tgt = edge.targetEndpoint();
    if (!isFinitePoint(src) || !isFinitePoint(tgt)) return '';
    const width = edge.numericStyle('width') as number;
    const color = edge.style('line-color') as string;
    const arrowColor = edge.style('target-arrow-color') as string;
    const dashed = edge.style('line-style') === 'dashed';
    const { d, from } = edgePath(edge, src, tgt);
    const arrow = triangle(from, tgt, width);
    const dash = dashed ? ` stroke-dasharray="${num(width * 3)} ${num(width * 2)}"` : '';
    return (
        `<g opacity="${num(edge.effectiveOpacity())}">` +
        `<path d="${d}" fill="none" stroke="${attr(color)}" stroke-width="${num(width)}"${dash}/>` +
        (arrow ? `<polygon points="${arrow}" fill="${attr(arrowColor)}"/>` : '') +
        '</g>'
    );
}

/** The line of an edge: straight, through its bends (right-angled and segment edges), or curved through its control points. */
function edgePath(edge: EdgeSingular, src: Position, tgt: Position): { d: string; from: Position } {
    const curve = String(edge.style('curve-style'));
    if (/^(round-)?(taxi|segments)$/.test(curve)) {
        const bends = (edge.segmentPoints() ?? []).filter(isFinitePoint);
        const radius = curve === 'round-taxi' ? Number(edge.numericStyle('taxi-radius')) || 0 : curve === 'round-segments' ? parseFloat(String(edge.style('segment-radii'))) || 0 : 0;
        return { d: polyline([src, ...bends, tgt], radius), from: bends[bends.length - 1] ?? src };
    }
    // Cytoscape draws a bezier edge with n control points as n chained
    // quadratic curves meeting at the midpoints between control points.
    const cps = (edge.controlPoints() ?? []).filter(isFinitePoint);
    if (cps.length === 0) return { d: `M ${pt(src)} L ${pt(tgt)}`, from: src };
    const curves = cps.map((cp, i) => `Q ${pt(cp)} ${pt(i === cps.length - 1 ? tgt : mid(cp, cps[i + 1]))}`);
    return { d: `M ${pt(src)} ${curves.join(' ')}`, from: cps[cps.length - 1] };
}

/**
 * A line through points; with a radius, each corner is a curve that starts and ends that far from it
 * (less when the segments either side are short), as Cytoscape draws right-angled edges.
 */
function polyline(points: Position[], radius: number): string {
    const parts = [`M ${pt(points[0])}`];
    for (let i = 1; i < points.length - 1; i++) {
        const [before, corner, after] = [points[i - 1], points[i], points[i + 1]];
        const r = Math.min(radius, Math.hypot(corner.x - before.x, corner.y - before.y) / 2, Math.hypot(after.x - corner.x, after.y - corner.y) / 2);
        parts.push(r > 0 ? `L ${pt(towards(corner, before, r))} Q ${pt(corner)} ${pt(towards(corner, after, r))}` : `L ${pt(corner)}`);
    }
    parts.push(`L ${pt(points[points.length - 1])}`);
    return parts.join(' ');
}

/** The point `distance` away from `from`, on the way to `to`. */
function towards(from: Position, to: Position, distance: number): Position {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: from.x + ((to.x - from.x) * distance) / length, y: from.y + ((to.y - from.y) * distance) / length };
}

function renderEdgeLabel(edge: EdgeSingular): string {
    const label = String(edge.style('label') ?? '');
    const m = edge.midpoint();
    if (!label || !isFinitePoint(m)) return '';
    const size = edge.numericStyle('font-size') as number;
    const color = edge.style('color') as string;
    const bg = edge.style('text-background-color') as string;
    const bgOpacity = Number(edge.style('text-background-opacity') ?? 0);
    const lines = label.split('\n');
    const lineHeight = size * 1.25;
    const w = Math.max(...lines.map(l => l.length)) * size * 0.56 + 4;
    const h = lines.length * lineHeight + size * 0.05;
    const top = m.y - ((lines.length - 1) * lineHeight) / 2;
    const tspans = lines.map((line, i) => `<tspan x="${num(m.x)}" y="${num(top + i * lineHeight)}">${text(line)}</tspan>`).join('');
    return (
        `<g opacity="${num(edge.effectiveOpacity())}">` +
        (bgOpacity > 0 ? `<rect x="${num(m.x - w / 2)}" y="${num(m.y - h / 2)}" width="${num(w)}" height="${num(h)}" rx="2" fill="${attr(bg)}" fill-opacity="${num(bgOpacity)}"/>` : '') +
        `<text text-anchor="middle" dominant-baseline="central" font-size="${num(size)}" fill="${attr(color)}">${tspans}</text>` +
        '</g>'
    );
}

function ellipse(p: Position, rx: number, ry: number, fill: string, stroke: string, width: number, extra = ''): string {
    return `<ellipse cx="${num(p.x)}" cy="${num(p.y)}" rx="${num(Math.max(1, rx))}" ry="${num(Math.max(1, ry))}" fill="${attr(fill)}" stroke="${attr(stroke)}" stroke-width="${num(width)}"${extra}/>`;
}

/** Arrow head whose tip is at `tip`, pointing away from `from`. */
function triangle(from: Position, tip: Position, width: number): string | null {
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const ux = dx / len;
    const uy = dy / len;
    const length = 5 + width * 3;
    const half = length * 0.5;
    const bx = tip.x - ux * length;
    const by = tip.y - uy * length;
    return [
        `${num(tip.x)},${num(tip.y)}`,
        `${num(bx - uy * half)},${num(by + ux * half)}`,
        `${num(bx + uy * half)},${num(by - ux * half)}`
    ].join(' ');
}

function mid(a: Position, b: Position): Position {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function isFinitePoint(p: Position | undefined): p is Position {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function pt(p: Position): string {
    return `${num(p.x)} ${num(p.y)}`;
}

export function num(n: number): string {
    return String(Math.round(n * 100) / 100);
}

export function text(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function attr(s: string): string {
    return text(String(s)).replace(/"/g, '&quot;');
}
