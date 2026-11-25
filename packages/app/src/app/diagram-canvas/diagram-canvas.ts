import { afterNextRender, Component, computed, effect, ElementRef, inject, input, OnDestroy, output, signal, untracked, viewChild } from '@angular/core';
import cytoscape, { type Core, type EdgeSingular, type ElementDefinition, type EventObject, type NodeSingular, type StylesheetJson } from 'cytoscape';
import edgehandles from 'cytoscape-edgehandles';
import type { DiagramModel } from '@provenflow/language';
import { DiagramStore, type Highlight, type Selection } from '../diagram-store';
import { LiveLink } from '../live-link';
import { downloadDataUrl, downloadText } from '../file-io';
import { computeLayout, LAYOUTS, type LayoutKind } from './layouts';
import { cytoscapeToSvg } from './svg-export';
import { followSize, themeColour, ThemeService } from '../theme';

const LAYOUT_KEY = 'provenflow.layout';

cytoscape.use(edgehandles);

export type CanvasMode = 'select' | 'add-state' | 'add-transition';

/**
 * Diagram editor built on Cytoscape.js — the counterpart of the JUNG based
 * editor of JungToNusmv (editing, picking and transforming modes).
 */
@Component({
    selector: 'app-diagram-canvas',
    templateUrl: './diagram-canvas.html',
    styleUrl: './diagram-canvas.css'
})
export class DiagramCanvas implements OnDestroy {
    readonly store = inject(DiagramStore);
    private readonly live = inject(LiveLink);
    private readonly host = viewChild.required<ElementRef<HTMLElement>>('cy');
    readonly mode = signal<CanvasMode>('select');
    readonly tooltip = signal<{ x: number; y: number; lines: string[] } | null>(null);
    readonly zoom = signal(1);
    readonly empty = computed(() => this.store.model().states.length === 0);
    readonly layouts = LAYOUTS;
    readonly layoutKind = signal<LayoutKind>(savedLayout());
    readonly layingOut = signal(false);
    readonly maximized = input(false);
    readonly toggleMaximize = output<void>();
    private resizeObserver?: ResizeObserver;

    private cy?: Core;
    private eh?: EdgeHandlesInstance;
    private fitPending = true;
    private readonly theme = inject(ThemeService);

    constructor() {
        afterNextRender(() => this.init());
        // The colours come from the theme's variables: drawn again when it changes.
        effect(() => {
            this.theme.dark();
            untracked(() => this.cy?.style().update());
        });

        effect(() => {
            const model = this.store.model();
            const deadEnds = this.store.deadEnds();
            untracked(() => this.sync(model, deadEnds));
        });
        effect(() => {
            const highlight = this.store.highlight();
            const sel = this.store.selection();
            untracked(() => {
                this.applyHighlight(highlight);
                this.applySelection(sel);
            });
        });
        effect(() => {
            if (this.store.layoutRequests() > 0) untracked(() => void this.autoLayout(true));
        });
        effect(() => {
            const locked = this.store.hasSyntaxErrors();
            untracked(() => this.cy?.autolock(locked));
        });
        effect(() => {
            this.store.loads();
            this.fitPending = true;
        });
        effect(() => {
            const mode = this.mode();
            untracked(() => {
                if (!this.eh) return;
                if (mode === 'add-transition') this.eh.enableDrawMode();
                else this.eh.disableDrawMode();
                this.cy?.autoungrabify(mode === 'add-transition');
            });
        });
    }

    private init(): void {
        const cy = cytoscape({
            container: this.host().nativeElement,
            style: STYLE,
            minZoom: 0.02,
            maxZoom: 4,
            boxSelectionEnabled: true,
            selectionType: 'single'
        });
        this.cy = cy;
        // Keep Cytoscape's viewport in step with the pane size (splitters, maximize, window).
        this.resizeObserver = followSize(cy, this.host().nativeElement);
        this.eh = (cy as unknown as { edgehandles(o: object): EdgeHandlesInstance }).edgehandles({
            canConnect: () => true,
            edgeParams: () => ({ data: { preview: true } }),
            hoverDelay: 100,
            snap: false,
            noEdgeEventsInDraw: true,
            disableBrowserGestures: true
        });

        cy.on('ehcomplete', ((_e: EventObject, source: NodeSingular, target: NodeSingular, added: EdgeSingular) => {
            added.remove();
            this.store.addTransition(source.id(), target.id());
        }) as unknown as cytoscape.EventHandler);

        cy.on('tap', event => {
            if (event.target === cy) {
                if (this.mode() === 'add-state') this.store.addState(event.position);
                else if (!this.store.simulation()) this.store.selection.set(null);
            }
        });
        cy.on('dbltap', event => {
            if (event.target === cy && this.mode() === 'select') this.store.addState(event.position);
        });
        cy.on('tap', 'node', event => {
            const name = (event.target as NodeSingular).id();
            if (this.store.live()) {
                const event = this.live.eventTo(name);
                if (event) void this.live.send(event);
            } else if (this.store.simulation()) this.store.simulateTo(name);
            else this.store.selection.set({ kind: 'state', name });
        });
        cy.on('tap', 'edge', event => {
            const index = (event.target as EdgeSingular).data('index') as number | undefined;
            if (index !== undefined) this.store.selection.set({ kind: 'transition', index });
        });
        cy.on('dragfree', 'node', () => this.savePositions());
        cy.on('zoom', () => this.zoom.set(cy.zoom()));
        cy.on('mouseover', 'node', event => this.showTooltip(event.target as NodeSingular));
        cy.on('mouseout', 'node', () => this.tooltip.set(null));
        cy.on('pan zoom drag', () => this.tooltip.set(null));

        this.sync(this.store.model(), this.store.deadEnds());
        this.applyHighlight(this.store.highlight());
    }

    /** Incrementally reconciles the Cytoscape graph with the model. */
    private sync(model: DiagramModel, deadEnds: Set<string>): void {
        const cy = this.cy;
        if (!cy) return;
        this.tooltip.set(null);
        const names = new Set(model.states.map(s => s.name));
        const unplaced: string[] = [];
        // A different diagram pasted or typed over the old one: fit it in view.
        const previous = cy.nodes().map(n => n.id());
        if (previous.length > 0 && names.size > 0 && !previous.some(id => names.has(id))) this.fitPending = true;

        cy.batch(() => {
            cy.nodes().forEach(n => {
                if (!names.has(n.id())) n.remove();
            });
            const extent = cy.nodes().length > 0 ? cy.nodes().boundingBox({}) : { x2: 60, y1: 60 };
            let offset = 0;
            for (const state of model.states) {
                const data = {
                    id: state.name,
                    display: state.label ? `${state.name}\n${state.label}` : state.name,
                    initial: state.initial ? 1 : 0,
                    deadEnd: deadEnds.has(state.name) ? 1 : 0
                };
                let node = cy.getElementById(state.name) as NodeSingular;
                if (node.empty()) {
                    const position = state.position ?? { x: extent.x2 + 90, y: extent.y1 + 40 + 90 * offset++ };
                    if (!state.position) unplaced.push(state.name);
                    node = cy.add({ group: 'nodes', data, position: { ...position } }) as unknown as NodeSingular;
                } else {
                    node.data(data);
                    if (state.position && !node.grabbed()) {
                        const p = node.position();
                        if (Math.round(p.x) !== state.position.x || Math.round(p.y) !== state.position.y) node.position({ ...state.position });
                    }
                }
            }

            cy.edges().remove();
            const edges: ElementDefinition[] = model.transitions
                .filter(t => names.has(t.source) && names.has(t.target))
                .map(t => ({
                    group: 'edges',
                    data: {
                        id: `t${model.transitions.indexOf(t)}`,
                        index: model.transitions.indexOf(t),
                        source: t.source,
                        target: t.target,
                        label: [
                            t.label ?? '',
                            t.guard ? `[${t.guard}]` : '',
                            t.updates?.length ? `/ ${t.updates.map(u => `${u.variable}:=${u.expression}`).join(', ')}` : '',
                            t.probability !== undefined ? `(${t.probability})` : ''
                        ]
                            .filter(Boolean)
                            .join(' ')
                    }
                }));
            cy.add(edges);
        });

        const allUnplaced = unplaced.length > 0 && unplaced.length === model.states.length;
        if (allUnplaced) {
            void this.autoLayout(false);
        } else if (this.fitPending && model.states.length > 0) {
            cy.fit(undefined, 40);
            if (cy.zoom() > 1.2) cy.zoom({ level: 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
        }
        if (this.fitPending && model.states.length === 0) cy.reset();
        this.fitPending = false;
        this.applyHighlight(this.store.highlight());
        this.applySelection(this.store.selection());
    }

    private applySelection(sel: Selection): void {
        const cy = this.cy;
        if (!cy) return;
        cy.elements().unselect();
        if (sel?.kind === 'state') cy.getElementById(sel.name).select();
        if (sel?.kind === 'transition') cy.getElementById(`t${sel.index}`).select();
    }

    private applyHighlight(h: Highlight | null): void {
        const cy = this.cy;
        if (!cy) return;
        cy.batch(() => {
            cy.elements().removeClass('dim visited current candidate on-path loop-edge');
            cy.nodes().forEach(n => {
                n.data('steps', '');
            });
            if (!h) return;
            cy.elements().addClass('dim');
            const steps = new Map<string, number[]>();
            h.path.slice(0, h.current + 1).forEach((state, i) => {
                const list = steps.get(state) ?? [];
                list.push(i + 1);
                steps.set(state, list);
                cy.getElementById(state).removeClass('dim').addClass('visited');
                if (i > 0) this.edgeBetween(h.path[i - 1], state)?.removeClass('dim').addClass('on-path');
            });
            // Show the whole lasso of a counterexample, including the edge closing the loop.
            if (h.loopStart !== undefined && h.current === h.path.length - 1) {
                this.edgeBetween(h.path[h.path.length - 1], h.path[h.loopStart])?.removeClass('dim').addClass('on-path loop-edge');
            }
            for (const [state, list] of steps) {
                const node = cy.getElementById(state);
                node.data('steps', list.length > 4 ? `#${list.slice(0, 3).join(',')}…` : `#${list.join(',')}`);
            }
            const current = h.path[h.current];
            if (current) cy.getElementById(current).removeClass('dim').addClass('current');
            for (const c of h.candidates ?? []) {
                cy.getElementById(c).removeClass('dim').addClass('candidate');
                if (current) this.edgeBetween(current, c)?.removeClass('dim');
            }
        });
    }

    private edgeBetween(source: string, target: string): EdgeSingular | undefined {
        const edges = this.cy?.edges(`[source = "${source}"][target = "${target}"]`);
        return edges && edges.length > 0 ? edges[0] : undefined;
    }

    private showTooltip(node: NodeSingular): void {
        const state = this.store.model().states.find(s => s.name === node.id());
        if (!state) return;
        const lines = [`${state.name}${state.initial ? ' (initial)' : ''}${state.label ? ` — ${state.label}` : ''}`];
        for (const a of this.store.model().attributes) lines.push(`${a.name} = ${state.values[a.name] ?? '(any)'}`);
        if (this.store.deadEnds().has(state.name)) lines.push('dead end: loops on itself');
        const p = node.renderedPosition();
        this.tooltip.set({ x: p.x + 30, y: p.y - 10, lines });
    }

    private savePositions(): void {
        const cy = this.cy;
        if (!cy) return;
        const positions: Record<string, { x: number; y: number }> = {};
        cy.nodes().forEach(n => {
            positions[n.id()] = { ...n.position() };
        });
        this.store.moveStates(positions);
    }

    /** Arranges the states with the selected layout; `save` writes the positions into the text. */
    async autoLayout(save: boolean): Promise<void> {
        const cy = this.cy;
        if (!cy || cy.nodes().length === 0 || this.layingOut()) return;
        this.layingOut.set(true);
        try {
            const positions = await computeLayout(cy, this.layoutKind(), STYLE, cy.width() / Math.max(1, cy.height()));
            const layout = cy.layout({
                name: 'preset',
                positions: (n: NodeSingular) => positions[n.id()] ?? n.position(),
                fit: true,
                padding: 40,
                animate: save,
                animationDuration: 350
            } as unknown as cytoscape.LayoutOptions);
            const done = layout.promiseOn('layoutstop');
            layout.run();
            await done;
            if (save) this.savePositions();
        } finally {
            this.layingOut.set(false);
        }
    }

    setLayout(kind: string): void {
        this.layoutKind.set(kind as LayoutKind);
        try {
            localStorage.setItem(LAYOUT_KEY, kind);
        } catch {
            // Storage unavailable (private mode): the choice lasts for this page only.
        }
        void this.autoLayout(true);
    }

    zoomBy(factor: number): void {
        const cy = this.cy;
        if (!cy) return;
        cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    }

    fit(): void {
        this.cy?.fit(undefined, 40);
    }

    exportPng(): void {
        const cy = this.cy;
        if (!cy) return;
        downloadDataUrl(this.baseName() + '.png', cy.png({ full: true, scale: 2, bg: this.background() }));
    }

    exportSvg(): void {
        const cy = this.cy;
        if (!cy) return;
        downloadText(this.baseName() + '.svg', cytoscapeToSvg(cy, this.background()), 'image/svg+xml');
    }

    private background(): string {
        return getComputedStyle(this.host().nativeElement).getPropertyValue('--canvas-bg').trim() || '#ffffff';
    }

    private baseName(): string {
        return this.store.fileName().replace(/\.(pflow|nxd)$/, '');
    }

    ngOnDestroy(): void {
        this.resizeObserver?.disconnect();
        this.eh?.destroy();
        this.cy?.destroy();
    }
}

function savedLayout(): LayoutKind {
    try {
        const saved = localStorage.getItem(LAYOUT_KEY);
        if (LAYOUTS.some(l => l.id === saved)) return saved as LayoutKind;
    } catch {
        // Storage unavailable: use the default.
    }
    return 'vertical';
}

interface EdgeHandlesInstance {
    enableDrawMode(): void;
    disableDrawMode(): void;
    destroy(): void;
}

function longestLine(text: unknown): number {
    return typeof text === 'string' ? Math.max(...text.split('\n').map(l => l.length)) : 0;
}

const css = themeColour;

export const STYLE: StylesheetJson = [
    {
        selector: 'node',
        style: {
            // Trace/simulation step numbers are appended below the name.
            label: (n: NodeSingular) => {
                const display = (n.data('display') as string | undefined) ?? '';
                return n.data('steps') ? `${display}\n${n.data('steps')}` : display;
            },
            'text-wrap': 'wrap',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': 13,
            'font-family': 'Inter, system-ui, sans-serif',
            'font-weight': 600,
            color: () => css('--node-text', '#1b2733'),
            'background-color': () => css('--node-bg', '#e8f1fb'),
            'border-width': 2,
            'border-color': () => css('--node-border', '#4a7fb5'),
            // Grow into an ellipse when the name or label is long.
            width: (n: NodeSingular) => Math.max(64, longestLine(n.data('display')) * 7.8 + 24),
            height: 64,
            'transition-property': 'background-color, border-color, opacity',
            'transition-duration': 150
        }
    },
    {
        selector: 'node[?initial]',
        style: { 'border-width': 5, 'border-style': 'double', 'border-color': () => css('--accent', '#2f6fdf') }
    },
    { selector: 'node[?deadEnd]', style: { 'border-style': 'dashed', 'border-color': () => css('--warning', '#c77700') } },
    { selector: 'node:selected', style: { 'overlay-color': () => css('--accent', '#2f6fdf'), 'overlay-opacity': 0.18, 'overlay-padding': 6 } },
    {
        selector: 'edge',
        style: {
            width: 2,
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 1.2,
            'line-color': () => css('--edge', '#7d8fa3'),
            'target-arrow-color': () => css('--edge', '#7d8fa3'),
            label: (e: EdgeSingular) => (e.data('label') as string | undefined) ?? '',
            'font-size': 11,
            color: () => css('--muted', '#5b6b7c'),
            'text-background-color': () => css('--canvas-bg', '#ffffff'),
            'text-background-opacity': 0.85,
            'text-background-padding': '2px',
            'loop-direction': '-45deg',
            'loop-sweep': '-60deg',
            'control-point-step-size': 50
        }
    },
    // Self-loops must clear the node, which widens with long labels.
    { selector: 'edge:loop', style: { 'control-point-step-size': (e: EdgeSingular) => Math.max(50, e.source().width() * 0.4) } },
    { selector: 'edge:selected', style: { width: 3.5, 'line-color': () => css('--accent', '#2f6fdf'), 'target-arrow-color': () => css('--accent', '#2f6fdf') } },
    { selector: '.dim', style: { opacity: 0.25 } },
    { selector: 'node.visited', style: { 'background-color': () => css('--trace-visited', '#fde9c9') } },
    {
        selector: 'node.current',
        style: { 'background-color': () => css('--trace-current', '#f59f00'), 'border-color': () => css('--trace-border', '#b35c00'), 'border-width': 4 }
    },
    { selector: 'node.candidate', style: { 'border-color': () => css('--success', '#2b8a3e'), 'border-width': 4, 'border-style': 'dotted' } },
    {
        selector: 'edge.on-path',
        style: { width: 4, 'line-color': () => css('--trace-current', '#f59f00'), 'target-arrow-color': () => css('--trace-current', '#f59f00') }
    },
    { selector: 'edge.loop-edge', style: { 'line-style': 'dashed' } },
    { selector: '.eh-preview, .eh-ghost-edge', style: { 'line-color': () => css('--accent', '#2f6fdf'), 'target-arrow-color': () => css('--accent', '#2f6fdf'), 'line-style': 'dashed' } },
    { selector: '.eh-ghost-edge.eh-preview-active', style: { opacity: 0 } },
    { selector: '.eh-source, .eh-target', style: { 'border-color': () => css('--accent', '#2f6fdf'), 'border-width': 4 } }
];
