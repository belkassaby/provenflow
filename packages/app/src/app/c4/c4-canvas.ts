import { afterNextRender, Component, effect, ElementRef, inject, input, OnDestroy, output, signal, untracked, viewChild } from '@angular/core';
import cytoscape, { type Core, type EdgeCollection, type EdgeSingular, type EventObject, type NodeSingular, type StylesheetJson } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import edgehandles from 'cytoscape-edgehandles';
import { downloadText } from '../file-io';
import { cytoscapeToSvg } from '../diagram-canvas/svg-export';
import { cytoscapeElements } from './c4-render';
import { packPositions } from './c4-pack';
import { renderC4Node } from './c4-svg';
import { C4Store } from './c4-store';
import { C4_SIDES } from '@provenflow/language';
import { boxAt, endsOf, ENDPOINTS, portFor, portsOf, routeEdge, type EndHandle, type Point, type Port } from './c4-ends';
import { followSize, themeColour, ThemeService } from '../theme';

cytoscape.use(dagre);
cytoscape.use(edgehandles);

interface EdgeHandles {
    enableDrawMode(): void;
    disableDrawMode(): void;
}

/** How round the corners of right-angled lines are (also in the SVG export, which reads it from the style). */
const CORNER_RADIUS = 24;

const STYLE: StylesheetJson = [
    {
        selector: 'node',
        style: {
            shape: 'data(cyShape)' as never,
            width: 'data(w)',
            height: 'data(h)',
            'background-color': 'data(bg)',
            'background-opacity': 'data(opacity)' as never,
            'border-color': 'data(stroke)',
            'border-width': 'data(borderWidth)' as never,
            'border-style': 'data(border)' as never,
            label: 'data(label)',
            color: 'data(fg)',
            'font-size': 11,
            'text-wrap': 'wrap',
            'text-max-width': '230px',
            'text-valign': 'center',
            'text-halign': 'center',
            'line-height': 1.3
        }
    },
    {
        selector: 'node:parent',
        style: {
            'background-opacity': 0.05,
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            color: () => themeColour('--text', '#3b4a52'),
            'font-size': 12,
            padding: '28px'
        }
    },
    { selector: 'node:selected', style: { 'border-color': '#f59e0b', 'border-width': 4 } },
    { selector: 'node.hl', style: { 'border-color': '#e8590c', 'border-width': 5, 'border-style': 'solid' } },
    {
        selector: 'edge',
        style: {
            width: 'data(width)' as never,
            'line-color': 'data(color)',
            'line-style': 'data(lineStyle)' as never,
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': 10,
            color: () => themeColour('--text', '#2c3e48'),
            'text-wrap': 'wrap',
            'text-background-color': () => themeColour('--canvas-bg', '#ffffff'),
            'text-background-opacity': 0.85,
            'text-background-padding': '2px'
        }
    },
    { selector: 'edge.implied', style: { opacity: 0.8 } },
    // Relationship routing: right angles turning half way, their corners curved; or a curve.
    { selector: 'edge.orthogonal', style: { 'curve-style': 'round-taxi', 'taxi-direction': 'vertical', 'taxi-turn': '50%', 'taxi-turn-min-distance': 16, 'taxi-radius': CORNER_RADIUS } as never },
    { selector: 'edge.orthogonal.horizontal', style: { 'taxi-direction': 'horizontal' } },
    { selector: 'edge.curved', style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': 48, 'control-point-weights': 0.5 } as never },
    // Ends attached to a side of their box (dragged there, or chosen in Properties).
    ...C4_SIDES.flatMap(side => [
        { selector: `edge.src-${side}`, style: { 'source-endpoint': ENDPOINTS[side] } },
        { selector: `edge.tgt-${side}`, style: { 'target-endpoint': ENDPOINTS[side] } }
    ] as StylesheetJson),
    { selector: 'edge:selected', style: { 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b', width: 3 } }
];

/**
 * The view of the C4 store drawn with Cytoscape: boxes in C4 style, boundaries as compound nodes,
 * laid out by dagre in the view's direction (or where they were dragged). Click selects, double
 * click opens the next level, dragging from a box to another in connect mode adds a relationship.
 * A selected relationship shows a handle at each end: dragged to one of the four connection points
 * of a box, the end moves to that side of its box, or to another box.
 */
@Component({
    selector: 'app-c4-canvas',
    template: `
        <div #cy class="c4-canvas" tabindex="0" (keydown)="key($event)" aria-label="C4 diagram"></div>
        @if (dragLine(); as l) {
            <svg class="c4-drag-line" aria-hidden="true"><line [attr.x1]="l.from.x" [attr.y1]="l.from.y" [attr.x2]="l.to.x" [attr.y2]="l.to.y" /></svg>
        }
        @for (p of ports(); track p.box + p.side) {
            <span class="c4-port" [class.near]="p.box === near()?.box && p.side === near()?.side" [style.left.px]="p.x" [style.top.px]="p.y" aria-hidden="true"></span>
        }
        @for (h of handles(); track h.end) {
            <span class="c4-end" [style.left.px]="h.x" [style.top.px]="h.y" (pointerdown)="grabEnd($event, h.end)" (pointermove)="dragEnd($event)" (pointerup)="dropEnd($event)" (pointercancel)="stopDragging()"
                [title]="(h.end === 'source' ? 'Start' : 'End') + ' of the relationship: drag it to a side of its box, or to another box'"></span>
        }
    `
})
export class C4Canvas implements OnDestroy {
    readonly store = inject(C4Store);
    readonly connectMode = input(false);
    /** Why a relationship's end could not be moved where it was dropped. */
    readonly notice = output<string>();
    /** The ends of the selected relationship, the connection points offered, and the one in reach. */
    readonly handles = signal<EndHandle[]>([]);
    readonly ports = signal<Port[]>([]);
    readonly near = signal<Port | undefined>(undefined);
    readonly dragLine = signal<{ from: Point; to: Point } | null>(null);
    private dragging?: { edge: string; end: EndHandle['end']; fixed: Point };
    private frame = 0;
    private readonly host = viewChild.required<ElementRef<HTMLElement>>('cy');
    private cy?: Core;
    private eh?: EdgeHandles;
    private resize?: ResizeObserver;
    private shownView = '';
    private readonly theme = inject(ThemeService);

    constructor() {
        afterNextRender(() => this.init());
        effect(() => {
            this.theme.dark();
            untracked(() => this.cy?.style().update());
        });
        effect(() => {
            const contents = this.store.contents();
            const highlight = this.store.highlight();
            const view = this.store.view();
            untracked(() => this.sync(contents, highlight, view?.key ?? ''));
        });
        effect(() => {
            const sel = this.store.selection();
            untracked(() => {
                this.cy?.elements().unselect();
                if (sel) this.cy?.getElementById(sel.id).select();
                this.showHandles();
            });
        });
        effect(() => {
            const on = this.connectMode();
            untracked(() => (on ? this.eh?.enableDrawMode() : this.eh?.disableDrawMode()));
        });
        effect(() => {
            if (this.store.layoutRequests() > 0) untracked(() => this.layout({ animate: true }));
        });
    }

    private init(): void {
        const cy = cytoscape({ container: this.host().nativeElement, style: STYLE, minZoom: 0.05, maxZoom: 3, selectionType: 'single' });
        this.cy = cy;
        this.resize = followSize(cy, this.host().nativeElement);
        this.eh = (cy as unknown as { edgehandles(o: object): EdgeHandles }).edgehandles({ canConnect: (s: NodeSingular, t: NodeSingular) => s.id() !== t.id() && !s.isParent() && !t.isParent(), hoverDelay: 80, snap: false, disableBrowserGestures: true });
        cy.on('ehcomplete', ((_e: EventObject, source: NodeSingular, target: NodeSingular, added: EdgeSingular) => {
            added.remove();
            this.store.connect(source.id(), target.id());
        }) as unknown as cytoscape.EventHandler);
        cy.on('tap', event => {
            if (event.target === cy) this.store.selection.set(null);
        });
        cy.on('tap', 'node', event => {
            const n = event.target as NodeSingular;
            if (!n.id().startsWith('group:')) this.store.selection.set({ kind: 'element', id: n.id() });
        });
        cy.on('tap', 'edge', event => this.store.selection.set({ kind: 'relationship', id: (event.target as EdgeSingular).id() }));
        cy.on('dbltap', 'node', event => this.store.drillDown((event.target as NodeSingular).id()));
        cy.on('dragfree', 'node', () => this.savePositions());
        // Right-angled lines with an end on a chosen side follow the boxes they join.
        cy.on('position', 'node', event => this.routeAnchored((event.target as NodeSingular).connectedEdges()));
        // The handles follow the line when the view pans, zooms or a box moves.
        cy.on('render', () => {
            cancelAnimationFrame(this.frame);
            this.frame = requestAnimationFrame(() => this.showHandles());
        });
        this.sync(this.store.contents(), this.store.highlight(), this.store.view()?.key ?? '');
    }

    private sync(contents: ReturnType<C4Store['contents']>, highlight: ReadonlySet<string>, viewKey: string): void {
        const cy = this.cy;
        if (!cy) return;
        const ws = this.store.workspace();
        const elements = cytoscapeElements(ws, this.store.view(), contents, this.store.index(), highlight);
        const same = viewKey === this.shownView && elements.filter(e => e.group === 'nodes').every(e => cy.getElementById(String(e.data.id)).nonempty());
        const kept = same ? new Map(cy.nodes().map(n => [n.id(), { ...n.position() }])) : new Map<string, { x: number; y: number }>();
        cy.batch(() => {
            cy.elements().remove();
            cy.add(elements);
        });
        const positions = this.store.view()?.positions;
        const leaves = cy.nodes().filter(n => !n.isParent()).toArray() as NodeSingular[];
        if (positions && leaves.every(n => !!positions[n.id()])) leaves.forEach(n => void n.position(positions[n.id()]));
        else if (same && leaves.every(n => kept.has(n.id()))) leaves.forEach(n => void n.position(kept.get(n.id())!));
        else this.layout();
        this.routeAnchored(cy.edges());
        if (viewKey !== this.shownView) cy.fit(undefined, 40);
        // The elements were drawn again: what is selected stays selected.
        const sel = this.store.selection();
        if (sel) cy.getElementById(sel.id).select();
        this.shownView = viewKey;
    }

    /** Lays the view out with dagre, in the direction its autoLayout gives. */
    layout({ animate } = { animate: false }): void {
        const cy = this.cy;
        if (!cy || cy.nodes().length === 0) return;
        const view = this.store.view();
        const auto = view?.autoLayout;
        // Deployment nodes hold many boxes with no relationship between them, which dagre stacks in one
        // long line: they are packed inside their nodes instead.
        if (view?.type === 'deployment') {
            const positions = packPositions(cy);
            cy.layout({ name: 'preset', positions: (n: NodeSingular) => positions[n.id()] ?? n.position(), fit: true, padding: 40, animate, animationDuration: 300 } as unknown as cytoscape.LayoutOptions).run();
            return;
        }
        const rankDir = (auto?.direction ?? 'tb').toUpperCase();
        cy.layout({ name: 'dagre', rankDir, nodeSep: auto?.nodeSeparation ? auto.nodeSeparation / 4 : 60, rankSep: auto?.rankSeparation ? auto.rankSeparation / 4 : 90, edgeSep: 20, fit: true, padding: 40, animate, animationDuration: 300 } as unknown as cytoscape.LayoutOptions).run();
    }

    private savePositions(): void {
        const cy = this.cy;
        if (!cy) return;
        const positions: Record<string, { x: number; y: number }> = {};
        cy.nodes()
            .filter(n => !n.isParent())
            .forEach(n => {
                const p = n.position();
                positions[n.id()] = { x: Math.round(p.x), y: Math.round(p.y) };
            });
        this.store.setPositions(positions);
    }

    key(event: KeyboardEvent): void {
        if ((event.key === 'Delete' || event.key === 'Backspace') && this.store.selection()) {
            event.preventDefault();
            this.store.removeSelected();
        }
    }

    /** The centre of what is shown, in model coordinates (where a new element goes). */
    centre(): { x: number; y: number } | undefined {
        const cy = this.cy;
        if (!cy) return undefined;
        const pan = cy.pan();
        return { x: Math.round((cy.width() / 2 - pan.x) / cy.zoom()), y: Math.round((cy.height() / 2 - pan.y) / cy.zoom()) };
    }

    fit(): void {
        this.cy?.fit(undefined, 40);
    }

    zoomBy(factor: number): void {
        const cy = this.cy;
        cy?.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    }

    exportSvg(name: string): void {
        if (this.cy) downloadText(`${name}.svg`, cytoscapeToSvg(this.cy, themeColour('--canvas-bg', '#ffffff'), renderC4Node), 'image/svg+xml');
    }

    exportPng(name: string): void {
        if (!this.cy) return;
        const a = document.createElement('a');
        a.href = this.cy.png({ full: true, scale: 2, bg: themeColour('--canvas-bg', '#ffffff') });
        a.download = `${name}.png`;
        a.click();
    }

    /** Routes the right-angled lines among these whose ends are attached to sides (see routeEdge). */
    private routeAnchored(edges: EdgeCollection): void {
        const anchors = this.store.view()?.anchors ?? {};
        edges.filter('.orthogonal').forEach(edge => {
            const a = anchors[edge.id()];
            if (a?.source || a?.target) routeEdge(edge, a, CORNER_RADIUS);
        });
    }

    /** The handles of the selected relationship's ends, and the connection points of its two boxes. */
    private showHandles(): void {
        if (this.dragging) return;
        const sel = this.store.selection();
        const edge = sel?.kind === 'relationship' ? this.cy?.getElementById(sel.id) : undefined;
        if (!edge?.nonempty() || !edge.isEdge()) {
            if (this.handles().length) this.handles.set([]);
            if (this.ports().length) this.ports.set([]);
            return;
        }
        this.handles.set(endsOf(edge));
        this.ports.set([...portsOf(edge.source()), ...portsOf(edge.target())]);
    }

    grabEnd(event: PointerEvent, end: EndHandle['end']): void {
        const sel = this.store.selection();
        const other = this.handles().find(h => h.end !== end);
        if (sel?.kind !== 'relationship' || !other) return;
        event.preventDefault();
        (event.target as Element).setPointerCapture(event.pointerId);
        this.dragging = { edge: sel.id, end, fixed: other };
    }

    /** While dragging: the end follows the pointer; the box under it offers its connection points. */
    dragEnd(event: PointerEvent): void {
        const d = this.dragging;
        if (!d || !this.cy) return;
        const p = this.local(event);
        const box = boxAt(this.cy, p);
        const ports = box ? portsOf(box) : [];
        this.ports.set(ports);
        this.near.set(portFor(box, p));
        this.handles.update(hs => hs.map(h => (h.end === d.end ? { ...h, ...p } : h)));
        this.dragLine.set(d.end === 'source' ? { from: p, to: d.fixed } : { from: d.fixed, to: p });
    }

    /** Dropped on a connection point: the end moves there (another side, or another box). */
    dropEnd(event: PointerEvent): void {
        const d = this.dragging;
        if (!d) return;
        this.dragEnd(event);
        const port = this.near();
        this.stopDragging();
        if (!port) return;
        const why = this.store.moveEnd(d.edge, d.end, port.box, port.side);
        if (why) this.notice.emit(why);
    }

    stopDragging(): void {
        this.dragging = undefined;
        this.near.set(undefined);
        this.dragLine.set(null);
        this.showHandles();
    }

    private local(event: PointerEvent): Point {
        const r = this.host().nativeElement.getBoundingClientRect();
        return { x: event.clientX - r.left, y: event.clientY - r.top };
    }

    ngOnDestroy(): void {
        cancelAnimationFrame(this.frame);
        this.resize?.disconnect();
        this.cy?.destroy();
    }
}
