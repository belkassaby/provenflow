import { facingSide, orthogonalRoute, segmentsOf, sidePoint, type Box, type Point } from './c4-ends';

/** Where Cytoscape puts a bend (`edge-distances: endpoints`): along the line between the ends, then across it. */
function bendAt(a: Point, b: Point, weight: number, distance: number): Point {
    const v = { x: b.x - a.x, y: b.y - a.y };
    const length = Math.hypot(v.x, v.y);
    return { x: a.x + v.x * weight - (v.y / length) * distance, y: a.y + v.y * weight + (v.x / length) * distance };
}

describe('right-angled lines between sides of boxes', () => {
    const app: Box = { x: 600, y: 140, w: 240, h: 80 };
    const extensions: Box = { x: 160, y: 310, w: 240, h: 100 };

    it('leaves the side chosen and comes into the side chosen, straight, turning at right angles', () => {
        // The case of the bug: from the bottom of one box to the right side of a box below and to the left.
        const route = orthogonalRoute(app, 'bottom', extensions, 'right');
        expect(route[0]).toEqual(sidePoint(app, 'bottom'));
        expect(route[route.length - 1]).toEqual(sidePoint(extensions, 'right'));
        expect(route).toEqual([
            { x: 600, y: 180 },
            { x: 600, y: 310 },
            { x: 280, y: 310 }
        ]);
        // Every stretch is horizontal or vertical, and the last one comes in from the right.
        for (let i = 1; i < route.length; i++) expect(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y).toBe(true);
        expect(route[route.length - 2].x).toBeGreaterThan(route[route.length - 1].x);
    });

    it('goes round the boxes when the sides face away from each other', () => {
        // Facing each other (the left side of app, the right side of the box to its left): half way.
        const route = orthogonalRoute(app, 'left', extensions, 'right');
        expect(route.map(p => [p.x, p.y])).toEqual([
            [480, 140],
            [380, 140],
            [380, 310],
            [280, 310]
        ]);
        // Facing away (the target is behind the source's side): round, between the boxes.
        const behind = orthogonalRoute(app, 'right', extensions, 'left');
        expect(behind.map(p => [p.x, p.y])).toEqual([
            [720, 140],
            [744, 140],
            [744, 225],
            [16, 225],
            [16, 310],
            [40, 310]
        ]);
    });

    it('goes round when both sides face the same way', () => {
        const route = orthogonalRoute(app, 'right', extensions, 'right');
        expect(route.map(p => [p.x, p.y])).toEqual([
            [720, 140],
            [744, 140],
            [744, 310],
            [280, 310]
        ]);
    });

    it('gives Cytoscape the bends as weights and distances that it turns back into the same points', () => {
        for (const [from, to] of [['bottom', 'right'], ['right', 'top'], ['left', 'left'], ['top', 'bottom']] as const) {
            const route = orthogonalRoute(app, from, extensions, to);
            const { weights, distances } = segmentsOf(route);
            const [a, b] = [route[0], route[route.length - 1]];
            const bends = weights.map((w, i) => bendAt(a, b, w, distances[i]));
            bends.forEach((p, i) => {
                expect(p.x).toBeCloseTo(route[i + 1].x, 6);
                expect(p.y).toBeCloseTo(route[i + 1].y, 6);
            });
        }
    });

    it('takes the side facing the other box for an end with no side chosen', () => {
        const left: Box = { x: 100, y: 160, w: 240, h: 100 };
        expect(facingSide(app, left)).toBe('left');
        expect(facingSide(left, app)).toBe('right');
        expect(facingSide(app, { x: 600, y: 400, w: 240, h: 80 })).toBe('bottom');
    });
});
