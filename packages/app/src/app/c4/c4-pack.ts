import type { Core, NodeSingular } from 'cytoscape';

interface Block {
    w: number;
    h: number;
    /** Leaf positions relative to the block's top-left corner. */
    leaves: Map<string, { x: number; y: number }>;
}

const GAP = 40;
/** Room a compound node takes around its children: padding, and its label below. */
const PAD = 30;
const LABEL = 36;

/**
 * Nested packing, for deployment views: every deployment node lays its children out in rows
 * (wrapping near a square shape), nested nodes as blocks of their own; the top-level nodes the same
 * way. Relationships play no part: deployment nodes are mostly containment.
 */
export function packPositions(cy: Core): Record<string, { x: number; y: number }> {
    const roots = cy.nodes().filter(n => n.parent().empty()).toArray() as NodeSingular[];
    const block = arrange(roots.map(blockOf));
    return Object.fromEntries(block.leaves);
}

function blockOf(node: NodeSingular): Block {
    const children = node.children().toArray() as NodeSingular[];
    if (!children.length) {
        const w = Number(node.data('w')) || node.width();
        const h = Number(node.data('h')) || node.height();
        return { w, h, leaves: new Map([[node.id(), { x: w / 2, y: h / 2 }]]) };
    }
    const inner = arrange(children.map(blockOf));
    const leaves = new Map([...inner.leaves].map(([id, p]) => [id, { x: p.x + PAD, y: p.y + PAD }]));
    return { w: inner.w + 2 * PAD, h: inner.h + 2 * PAD + LABEL, leaves };
}

/** Rows of blocks, wrapped at about the width that makes the whole roughly square. */
function arrange(blocks: Block[]): Block {
    const area = blocks.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
    const target = Math.max(Math.sqrt(area) * 1.3, ...blocks.map(b => b.w));
    const leaves = new Map<string, { x: number; y: number }>();
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let width = 0;
    for (const b of blocks) {
        if (x > 0 && x + b.w > target) {
            x = 0;
            y += rowHeight + GAP;
            rowHeight = 0;
        }
        for (const [id, p] of b.leaves) leaves.set(id, { x: x + p.x, y: y + p.y });
        x += b.w + GAP;
        width = Math.max(width, x - GAP);
        rowHeight = Math.max(rowHeight, b.h);
    }
    return { w: width, h: y + rowHeight, leaves };
}
