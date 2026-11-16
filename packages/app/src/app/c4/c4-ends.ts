import type { Core, EdgeSingular, NodeSingular } from 'cytoscape';
import type { C4Anchors, C4Side } from '@provenflow/language';

/** A point on screen, in the canvas's pixels (Cytoscape's rendered coordinates). */
export interface Point {
    x: number;
    y: number;
}

/** A connection point: the middle of one side of a box. */
export interface Port extends Point {
    box: string;
    side: C4Side;
}

/** One end of the selected relationship's line, where it can be grabbed. */
export interface EndHandle extends Point {
    end: keyof C4Anchors;
}

/** Where a relationship's end sits on a box, as a Cytoscape endpoint (from the centre, in % of the size). */
export const ENDPOINTS: Record<C4Side, string> = { top: '0% -50%', right: '50% 0%', bottom: '0% 50%', left: '-50% 0%' };

/** A box in the diagram's coordinates: its centre and size. */
export interface Box extends Point {
    w: number;
    h: number;
}

/** The way out of each side. */
const NORMAL: Record<C4Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
/** How far a right-angled line goes straight out of a side before it turns. */
const STUB = 24;

/** How close to a box the pointer must be to pick it, and to a connection point to snap to it. */
const BOX_MARGIN = 24;
const PORT_REACH = 36;

/** The four connection points of a box, on screen. */
export function portsOf(node: NodeSingular): Port[] {
    const b = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    const x = (b.x1 + b.x2) / 2;
    const y = (b.y1 + b.y2) / 2;
    const box = node.id();
    return [
        { box, side: 'top', x, y: b.y1 },
        { box, side: 'right', x: b.x2, y },
        { box, side: 'bottom', x, y: b.y2 },
        { box, side: 'left', x: b.x1, y }
    ];
}

/** The box under a point (or close to it): an element, not a boundary or a group; the nearest centre wins. */
export function boxAt(cy: Core, p: Point): NodeSingular | undefined {
    const near = (cy.nodes().toArray() as NodeSingular[]).filter(n => {
        if (n.isParent() || n.data('kind') !== 'element') return false;
        const b = n.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
        return p.x >= b.x1 - BOX_MARGIN && p.x <= b.x2 + BOX_MARGIN && p.y >= b.y1 - BOX_MARGIN && p.y <= b.y2 + BOX_MARGIN;
    });
    const centre = (n: NodeSingular) => n.renderedPosition();
    return near.sort((a, b) => distance(centre(a), p) - distance(centre(b), p))[0];
}

/**
 * The connection point of a box a point snaps to: the nearest one when the point is on the box,
 * else the nearest within reach.
 */
export function portFor(node: NodeSingular | undefined, p: Point): Port | undefined {
    if (!node) return undefined;
    const b = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    const on = p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2;
    return portsOf(node)
        .filter(q => on || distance(q, p) <= PORT_REACH)
        .sort((a, c) => distance(a, p) - distance(c, p))[0];
}

/** The two ends of a relationship's line, on screen. */
export function endsOf(edge: EdgeSingular): EndHandle[] {
    return [
        { end: 'source', ...edge.renderedSourceEndpoint() },
        { end: 'target', ...edge.renderedTargetEndpoint() }
    ];
}

/** The middle of a side of a box. */
export function sidePoint(b: Box, side: C4Side): Point {
    return { x: b.x + (NORMAL[side].x * b.w) / 2, y: b.y + (NORMAL[side].y * b.h) / 2 };
}

/** The side of a box that faces another one. */
export function facingSide(from: Box, to: Box): C4Side {
    const dx = (to.x - from.x) / (from.w + to.w);
    const dy = (to.y - from.y) / (from.h + to.h);
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'bottom' : 'top';
}

/**
 * A right-angled route from a side of one box to a side of another: straight out of the first side,
 * turning half way, and straight into the second side, so the arrow points at the side chosen.
 * Points that do not turn are left out.
 */
export function orthogonalRoute(a: Box, from: C4Side, b: Box, to: C4Side): Point[] {
    const s = sidePoint(a, from);
    const t = sidePoint(b, to);
    const s1 = { x: s.x + NORMAL[from].x * STUB, y: s.y + NORMAL[from].y * STUB };
    const t1 = { x: t.x + NORMAL[to].x * STUB, y: t.y + NORMAL[to].y * STUB };
    const vertical = (side: C4Side) => side === 'top' || side === 'bottom';
    if (vertical(from) !== vertical(to)) return turns([s, s1, vertical(from) ? { x: s1.x, y: t1.y } : { x: t1.x, y: s1.y }, t1, t]);
    // Both ends across the same axis: x across for left and right sides, y for top and bottom.
    const across = vertical(from) ? 'y' : 'x';
    const along = vertical(from) ? 'x' : 'y';
    const turn = crossing(s1[across], NORMAL[from][across], t1[across], NORMAL[to][across]);
    // Facing away from each other (or one behind the other): round, between the boxes on the other axis.
    const middle =
        turn === undefined
            ? [point(across, s1[across], along, (s1[along] + t1[along]) / 2), point(across, t1[across], along, (s1[along] + t1[along]) / 2)]
            : [point(across, turn, along, s1[along]), point(across, turn, along, t1[along])];
    return turns([s, s1, ...middle, t1, t]);
}

/**
 * Where a line between two parallel sides turns, on the axis across them: beyond both when the
 * sides face the same way, half way when they face each other; nothing when they face away.
 */
function crossing(s: number, sDir: number, t: number, tDir: number): number | undefined {
    if (sDir === tDir) return sDir > 0 ? Math.max(s, t) : Math.min(s, t);
    return (t - s) * sDir >= 0 ? (s + t) / 2 : undefined;
}

function point(a: 'x' | 'y', va: number, b: 'x' | 'y', vb: number): Point {
    return { [a]: va, [b]: vb } as unknown as Point;
}

/** The points of a line, without repeated points and without those where the line goes straight on. */
function turns(points: Point[]): Point[] {
    const distinct = points.filter((p, i) => i === 0 || distance(p, points[i - 1]) > 0.5);
    return distinct.filter((p, i) => {
        if (i === 0 || i === distinct.length - 1) return true;
        const [a, b] = [distinct[i - 1], distinct[i + 1]];
        return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 0.5;
    });
}

/**
 * The bends of a route as Cytoscape's segment weights and distances, measured on the line from its
 * first point to its last (`edge-distances: endpoints`): a weight along it, and a distance across it.
 */
export function segmentsOf(route: Point[]): { weights: number[]; distances: number[] } {
    const a = route[0];
    const b = route[route.length - 1];
    const v = { x: b.x - a.x, y: b.y - a.y };
    const length = Math.hypot(v.x, v.y);
    const bends = length > 0 ? route.slice(1, -1) : [];
    return {
        weights: bends.map(p => ((p.x - a.x) * v.x + (p.y - a.y) * v.y) / (length * length)),
        distances: bends.map(p => ((p.x - a.x) * -v.y + (p.y - a.y) * v.x) / length)
    };
}

/**
 * Draws a right-angled line with an end attached to a side along the route above. Cytoscape's own
 * right angles (`taxi`) turn as if the ends were at the boxes' centres, so with a side chosen the
 * line would end on another side, or come in at a slant.
 */
export function routeEdge(edge: EdgeSingular, anchors: C4Anchors, radius: number): void {
    const a = boxOf(edge.source());
    const b = boxOf(edge.target());
    const from = anchors.source ?? facingSide(a, b);
    const to = anchors.target ?? facingSide(b, a);
    const { weights, distances } = segmentsOf(orthogonalRoute(a, from, b, to));
    const bends = weights.length > 0;
    edge.style({
        'source-endpoint': ENDPOINTS[from],
        'target-endpoint': ENDPOINTS[to],
        'edge-distances': 'endpoints',
        'curve-style': bends ? 'round-segments' : 'straight',
        'segment-weights': bends ? weights : [0.5],
        'segment-distances': bends ? distances : [0],
        'segment-radii': radius
    });
}

/** A box as Cytoscape attaches endpoints to it: its centre and outer size. */
function boxOf(node: NodeSingular): Box {
    const p = node.position();
    return { x: p.x, y: p.y, w: node.outerWidth(), h: node.outerHeight() };
}

function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
