/**
 * False positives reported by ProvenFlow reviews of a real Angular code base, and real findings of
 * the same reviews, as small fixtures: each false alarm must stay quiet and each real defect must
 * stay found. The patterns come from the replies to the review comments (see bench/labels/).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractProject, type ExtractionResult, type Finding } from '../src/index.js';

/** Stand-ins for @angular/core and RxJS (no node_modules in the temporary project). */
const ANGULAR = `export declare function Component(options: object): ClassDecorator;
export declare function Injectable(options?: object): ClassDecorator;
export interface Subscription { unsubscribe(): void }
export interface Observable<T> { subscribe(next: (value: T) => void): Subscription; pipe(...ops: unknown[]): Observable<T> }
`;

async function analyse(files: Record<string, string>): Promise<ExtractionResult> {
    const dir = mkdtempSync(join(tmpdir(), 'provenflow-precision-'));
    try {
        for (const [path, text] of Object.entries({ 'angular.ts': ANGULAR, ...files })) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), text);
        }
        return await extractProject(dir, { analyzers: false, config: {} });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const findings = async (files: Record<string, string>): Promise<Finding[]> => (await analyse(files)).findings;

const of = (list: Finding[], rules: string[], subject: string) => list.filter(f => rules.includes(f.rule) && f.subject.includes(subject)).map(f => `${f.rule}: ${f.message}`);

const STATE_RULES = ['unreachable-state', 'stuck-state', 'cannot-settle'];
const LEAK_RULES = ['resource-leak'];

describe('state machines: values set from outside the class', () => {
    it('a public setter can set every value of its parameter type', async () => {
        const list = await findings({
            'overlay.ts': `export type ToolMode = 'select' | 'draw' | 'erase';
export class RegionOverlay {
    mode: ToolMode = 'select';
    setMode(mode: ToolMode): void {
        this.mode = mode;
    }
    get erasing(): boolean {
        return this.mode === 'erase';
    }
}
`
        });
        expect(of(list, STATE_RULES, 'RegionOverlay.mode')).toEqual([]);
    });

    it('a public method called with one literal can still be called with the others', async () => {
        const list = await findings({
            'plot.ts': `type Kind = 'heatmap' | 'rgb' | 'multichannel';
export class Recolor {
    kind: Kind = 'heatmap';
    plot(kind: Kind): void {
        this.kind = kind;
    }
    reset(): void {
        this.plot('heatmap');
    }
    isRgb(): boolean {
        return this.kind === 'rgb';
    }
}
`
        });
        expect(of(list, STATE_RULES, 'Recolor.kind')).toEqual([]);
    });

    it('a value read from another typed field can be any value of its type', async () => {
        const list = await findings({
            'cells.ts': `type CellsMode = 'outlines' | 'filled' | 'hidden';
interface View { cells3d: CellsMode }
export class Cells3d {
    cells3dMode: CellsMode = 'outlines';
    private view: View = { cells3d: 'outlines' };
    update(view: View): void {
        this.view = view;
        this.cells3dMode = this.view.cells3d;
    }
    hidden(): boolean {
        return this.cells3dMode === 'hidden';
    }
}
`
        });
        expect(of(list, STATE_RULES, 'Cells3d.cells3dMode')).toEqual([]);
    });

    it('a private method takes the values its callers pass, typed or literal', async () => {
        const list = await findings({
            'scope.ts': `type Layout = 'combined' | 'per-slice-file';
export class RegionScopeCache {
    layout: Layout = 'combined';
    enterStackMode(saveLayout: Layout): void {
        this.enterStack(saveLayout);
    }
    private enterStack(layout: Layout): void {
        this.layout = layout;
    }
    perSlice(): boolean {
        return this.layout === 'per-slice-file';
    }
}
`
        });
        expect(of(list, STATE_RULES, 'RegionScopeCache.layout')).toEqual([]);
    });

    it('a two-way template binding writes the field', async () => {
        const result = await analyse({
            'editor.ts': `import { Component } from './angular';
type MaskMode = 'binary' | 'multiclass';
@Component({
    selector: 'app-editor',
    template: \`<app-save-mask [(mode)]="maskMode"></app-save-mask>
        <p *ngIf="maskMode === 'multiclass'">One value per region</p>\`
})
export class RegionEditor {
    maskMode: MaskMode = 'binary';
    openSaveMaskDialog(): void {
        this.maskMode = 'binary';
    }
}
`
        });
        expect(of(result.findings, STATE_RULES, 'RegionEditor.maskMode')).toEqual([]);
        const model = result.models.find(m => m.subject === 'RegionEditor.maskMode')!;
        expect(model.evidence['binary->multiclass']?.[0].event).toBe('RegionEditor.template [(mode)]');
    });

    it('an object given to an update call writes the fields it names', async () => {
        const list = await findings({
            'view.ts': `type ColorMode = 'group' | 'gene' | 'single';
export interface SpatialViewState {
    cellColorMode: ColorMode;
}
export const DEFAULT_VIEW: SpatialViewState = { cellColorMode: 'group' };
export class ViewStore {
    private view: SpatialViewState = DEFAULT_VIEW;
    setViewState(patch: Partial<SpatialViewState>): void {
        this.view = { ...this.view, ...patch };
    }
    onGene(): void {
        this.setViewState({ cellColorMode: 'gene' });
    }
    onSingle(): void {
        this.setViewState({ cellColorMode: 'single' });
    }
    onGroup(): void {
        const patch: Partial<SpatialViewState> = { cellColorMode: 'group' };
        this.setViewState(patch);
    }
}
`
        });
        expect(of(list, STATE_RULES, 'SpatialViewState.cellColorMode')).toEqual([]);
    });

    it('a field declared without a value need not come back to having none', async () => {
        const list = await findings({
            'shape.ts': `export class Shape {
    type!: 'rect' | 'line';
    static rect(): Shape {
        const s = new Shape();
        s.type = 'rect';
        return s;
    }
    toLine(): void {
        this.type = 'line';
    }
}
`
        });
        expect(of(list, ['cannot-settle'], 'Shape.type')).toEqual([]);
    });

    it('still finds a value no code can set (all writes known)', async () => {
        const list = await findings({
            'door.ts': `type DoorState = 'open' | 'closed' | 'locked';
export class Door {
    state: DoorState = 'closed';
    private move(to: DoorState): void {
        this.state = to;
    }
    open(): void {
        this.move('open');
    }
    close(): void {
        this.move('closed');
    }
    isLocked(): boolean {
        return this.state === 'locked';
    }
}
`
        });
        expect(of(list, ['unreachable-state'], 'Door.state').join('\n')).toContain("'locked'");
    });

    it('a template that only reads a value still makes it dead code', async () => {
        const list = await findings({
            'tabs.ts': `import { Component } from './angular';
type Tab = 'home' | 'settings' | 'about';
@Component({
    selector: 'app-tabs',
    template: \`<button (click)="show('settings')">Settings</button>
        <p *ngIf="tab === 'about'">About</p>\`
})
export class Tabs {
    tab: Tab = 'home';
    private show(tab: Tab): void {
        this.tab = tab;
    }
    reset(): void {
        this.show('home');
    }
}
`
        });
        expect(of(list, ['unreachable-state'], 'Tabs.tab').join('\n')).toContain("'about'");
    });
});

describe('resource lifecycles: what the framework and the code guarantee', () => {
    it('Angular runs ngOnInit once per instance', async () => {
        const list = await findings({
            'resize.ts': `import { Component, type Observable, type Subscription } from './angular';
@Component({ selector: 'app-panel', template: '' })
export class Panel {
    private sizes!: Observable<number>;
    private sizeSub?: Subscription;
    ngOnInit(): void {
        this.sizeSub = this.sizes.subscribe(() => undefined);
    }
    ngOnDestroy(): void {
        this.sizeSub?.unsubscribe();
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'Panel')).toEqual([]);
    });

    it('an early return on a field set in the same method guards every acquisition after it', async () => {
        const list = await findings({
            'plotly.ts': `import { Injectable, type Observable, type Subscription } from './angular';
@Injectable({ providedIn: 'root' })
export class PlotlyBackend {
    private cached!: Observable<boolean>;
    private channels!: Observable<number>;
    private cachedSub?: Subscription;
    private channelSub?: Subscription;
    load(): void {
        this.ensureSubscriptions();
    }
    private ensureSubscriptions(): void {
        if (this.channelSub) return;
        this.cachedSub = this.cached.subscribe(() => undefined);
        this.channelSub = this.channels.subscribe(() => undefined);
    }
    unsubscribe(): void {
        this.cachedSub?.unsubscribe();
        this.channelSub?.unsubscribe();
        this.cachedSub = undefined;
        this.channelSub = undefined;
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'PlotlyBackend')).toEqual([]);
    });

    it('a busy flag set before the acquisition guards it', async () => {
        const list = await findings({
            'mask.ts': `import { Component, type Observable, type Subscription } from './angular';
@Component({ selector: 'app-mask', template: '' })
export class MaskExport {
    private exports!: Observable<Blob>;
    private maskJob?: Subscription;
    private maskBusy = false;
    confirmSaveMask(): void {
        if (this.maskBusy) return;
        this.maskBusy = true;
        this.maskJob = this.exports.subscribe(() => this.finish());
    }
    private finish(): void {
        this.maskBusy = false;
        this.maskJob = undefined;
    }
    ngOnDestroy(): void {
        this.maskJob?.unsubscribe();
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'MaskExport')).toEqual([]);
    });

    it('unsubscribe() is a dispose method', async () => {
        const list = await findings({
            'recolor.ts': `import { type Observable, type Subscription } from './angular';
export class TileRecolorer {
    private changes!: Observable<number>;
    private sub?: Subscription;
    ensureSubscription(): void {
        if (this.sub) return;
        this.sub = this.changes.subscribe(() => undefined);
    }
    unsubscribe(): void {
        this.sub?.unsubscribe();
        this.sub = undefined;
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'TileRecolorer')).toEqual([]);
    });

    it('a one-shot timeout cleared before it is set again is not lost when its owner is', async () => {
        const list = await findings({
            'history.ts': `export class RegionHistory {
    private burstOpen = false;
    private burstTimer?: ReturnType<typeof setTimeout>;
    record(): void {
        this.armBurst();
    }
    private armBurst(): void {
        clearTimeout(this.burstTimer);
        this.burstOpen = true;
        this.burstTimer = setTimeout(() => (this.burstOpen = false), 250);
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'RegionHistory')).toEqual([]);
    });

    it('a release kept in a closure field counts where the field is called', async () => {
        const list = await findings({
            'drag.ts': `export class FloatingDrag {
    private end: (() => void) | null = null;
    onMouseDown(): void {
        this.end?.();
        const move = () => undefined;
        const up = () => this.end?.();
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        this.end = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            this.end = null;
        };
    }
    ngOnDestroy(): void {
        this.end?.();
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'FloatingDrag')).toEqual([]);
    });

    it('an acquisition inside a check that none is held is guarded', async () => {
        const list = await findings({
            'histogram.ts': `export class Histogram {
    private resizeObserver?: ResizeObserver;
    ngAfterViewChecked(): void {
        const el = document.body;
        if (el && !this.resizeObserver && typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => undefined);
            this.resizeObserver.observe(el);
        }
    }
    ngOnDestroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'Histogram')).toEqual([]);
    });

    it('listeners kept in a collection are all removed by detach()', async () => {
        const list = await findings({
            'shortcuts.ts': `export class ViewerShortcuts {
    private readonly listeners: [string, EventListener][] = [];
    attach(): void {
        this.listen('keydown', () => undefined);
        this.listen('wheel', () => undefined);
    }
    detach(): void {
        for (const [type, listener] of this.listeners.splice(0)) window.removeEventListener(type, listener);
    }
    private listen(type: string, listener: EventListener): void {
        window.addEventListener(type, listener);
        this.listeners.push([type, listener]);
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'ViewerShortcuts')).toEqual([]);
    });

    it('still finds a subscription replaced while the previous one runs', async () => {
        const list = await findings({
            'stack.ts': `import { Component, type Observable, type Subscription } from './angular';
@Component({ selector: 'app-stack', template: '' })
export class StackSaver {
    private writes!: Observable<number>;
    private saveSub?: Subscription;
    private busy = false;
    saveStackSlices(): void {
        this.saveSub = this.writes.subscribe(() => undefined);
    }
    ngOnDestroy(): void {
        this.saveSub?.unsubscribe();
    }
}
`
        });
        expect(of(list, LEAK_RULES, 'StackSaver')).toHaveLength(1);
    });
});

describe('patterns: contracts kept by the code', () => {
    it('a listener removed when its own call settles can be unsubscribed', async () => {
        const list = await findings({
            'cellpose.ts': `type Progress = (loaded: number) => void;
export class CellposeSegmenter {
    private readonly progressListeners = new Set<Progress>();
    private loading: Promise<void> | null = null;
    loadModel(onProgress?: Progress): Promise<void> {
        if (onProgress) this.progressListeners.add(onProgress);
        this.loading ??= this.fetch();
        return this.loading.finally(() => {
            if (onProgress) this.progressListeners.delete(onProgress);
        });
    }
    private async fetch(): Promise<void> {
        for (const l of this.progressListeners) l(1);
    }
}
`
        });
        expect(of(list, ['observer-cannot-unsubscribe'], 'CellposeSegmenter')).toEqual([]);
    });

    it('a listener added in try and removed in finally can be unsubscribed', async () => {
        const list = await findings({
            'sam.ts': `type Progress = (loaded: number) => void;
export class SamSession {
    private readonly progressListeners = new Set<Progress>();
    async acquire(onProgress: Progress): Promise<void> {
        this.progressListeners.add(onProgress);
        try {
            await this.load();
        } finally {
            this.progressListeners.delete(onProgress);
        }
    }
    private async load(): Promise<void> {
        this.progressListeners.forEach(l => l(1));
    }
}
`
        });
        expect(of(list, ['observer-cannot-unsubscribe'], 'SamSession')).toEqual([]);
    });

    it('still finds a listener that can never be removed', async () => {
        const list = await findings({
            'bus.ts': `type Handler = (event: string) => void;
export class Bus {
    private readonly handlers: Handler[] = [];
    on(handler: Handler): void {
        this.handlers.push(handler);
    }
    emit(event: string): void {
        for (const h of this.handlers) h(event);
    }
}
`
        });
        expect(of(list, ['observer-cannot-unsubscribe'], 'Bus')).toHaveLength(1);
    });

    it('a default argument of an injected constructor is not a second instance', async () => {
        const list = await findings({
            'sam-session.ts': `import { Injectable } from './angular';
@Injectable({ providedIn: 'root' })
export class SamSessionService {
    readonly ready = false;
}
`,
            'wand.ts': `import { Injectable } from './angular';
import { SamSessionService } from './sam-session';
@Injectable({ providedIn: 'root' })
export class WandTool {
    constructor(private readonly session: SamSessionService = new SamSessionService()) {}
}
`
        });
        expect(of(list, ['singleton-bypassed'], 'SamSessionService')).toEqual([]);
    });
});
