import { afterNextRender, Component, computed, effect, HostListener, inject, Injector, OnInit, signal, viewChild } from '@angular/core';
import { EXAMPLES, importGraph, serializeDiagram } from '@provenflow/language';
import { AttributeTable } from './attribute-table/attribute-table';
import { CodeExport } from './code-export';
import { DiagramCanvas } from './diagram-canvas/diagram-canvas';
import { DiagramStore } from './diagram-store';
import { downloadText, pickFile } from './file-io';
import { CodeImport } from './code-import/code-import';
import { C4Page } from './c4/c4-page';
import { DesktopBridge, type DesktopFile } from './desktop-bridge';
import { CodeReportPage } from './code-import/code-report-page';
import { DocumentTabs } from './document-tabs/document-tabs';
import { LlmSettingsDialog } from './llm-settings/llm-settings-dialog';
import { DocumentTabsBar } from './document-tabs/document-tabs-bar';
import { HelpDialog, type HelpSection } from './help-dialog/help-dialog';
import { Inspector } from './inspector/inspector';
import { NuxmvApi } from './nuxmv-api';
import { OutputPanel } from './output-panel/output-panel';
import { ProblemsList } from './problems-list/problems-list';
import { PropertiesPanel } from './properties-panel/properties-panel';
import { Splitter } from './splitter/splitter';
import { TextEditor } from './text-editor/text-editor';
import { TracePanel } from './trace-panel/trace-panel';
import { ThemeService } from './theme';

type Tab = 'attributes' | 'properties' | 'trace' | 'model' | 'python' | 'console';

const SIZES_KEY = 'provenflow.pane-sizes';
const DEFAULT_SIZES = { text: 440, inspector: 280, bottom: 320 };
const MIN = { text: 220, inspector: 180, bottom: 120, canvasW: 320, canvasH: 200 };

function loadSizes(): typeof DEFAULT_SIZES {
    try {
        const saved = JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}') as Partial<typeof DEFAULT_SIZES>;
        return { ...DEFAULT_SIZES, ...saved };
    } catch {
        return { ...DEFAULT_SIZES };
    }
}

@Component({
    selector: 'app-root',
    imports: [AttributeTable, C4Page, CodeReportPage, DiagramCanvas, DocumentTabsBar, LlmSettingsDialog, HelpDialog, Inspector, OutputPanel, ProblemsList, PropertiesPanel, Splitter, TextEditor, TracePanel],
    templateUrl: './app.html',
    styleUrl: './app.css'
})
export class App implements OnInit {
    readonly store = inject(DiagramStore);
    readonly api = inject(NuxmvApi);
    readonly documents = inject(DocumentTabs);
    readonly codeReport = inject(CodeImport);
    readonly codeExport = inject(CodeExport);
    readonly theme = inject(ThemeService);
    private readonly injector = inject(Injector);
    readonly exampleGroups = [...new Set(EXAMPLES.map(e => e.group))].map(name => ({ name, examples: EXAMPLES.filter(e => e.group === name) }));
    readonly tab = signal<Tab>('properties');
    readonly openMenu = signal<string | null>(null);
    readonly showText = signal(true);
    readonly message = signal<string | null>(null);
    /** Pane sizes in pixels, set with the splitters. */
    readonly textW = signal(loadSizes().text);
    readonly inspectorW = signal(loadSizes().inspector);
    readonly bottomH = signal(loadSizes().bottom);
    /** The diagram fills the whole window. */
    readonly canvasMax = signal(false);
    private readonly editor = viewChild(TextEditor);
    private readonly canvas = viewChild(DiagramCanvas);
    private readonly help = viewChild.required(HelpDialog);
    private readonly c4 = viewChild(C4Page);
    private readonly llmSettings = viewChild.required(LlmSettingsDialog);

    readonly tabs = computed(() => {
        const v = this.store.verification();
        const failed = v?.results.filter(r => r?.verdict === 'false').length ?? 0;
        return [
            { id: 'attributes' as Tab, label: `Attributes (${this.store.model().attributes.length})` },
            { id: 'properties' as Tab, label: `Properties (${this.store.model().specs.length})`, badge: failed > 0 ? `${failed} ✗` : undefined },
            { id: 'trace' as Tab, label: this.store.live() ? 'Live' : this.store.simulation() ? 'Simulation' : 'Trace', dot: !!this.store.highlight() },
            { id: 'model' as Tab, label: 'nuXmv model' },
            { id: 'python' as Tab, label: 'Python' },
            { id: 'console' as Tab, label: 'nuXmv output' }
        ];
    });

    constructor() {
        // Opening a counterexample, or starting a simulation or a live session, brings its panel to
        // the front once (not on every step, so other tabs stay usable meanwhile).
        const active = computed(() => (this.store.live() ? 'live' : this.store.simulation() ? 'sim' : this.store.trace() ? 'trace' : ''));
        effect(() => {
            if (active()) this.tab.set('trace');
        });
        // In the desktop application: its native menus, and the files opened with it.
        const desktop = inject(DesktopBridge);
        afterNextRender(() =>
            desktop.connect(
                {
                    'new-diagram': () => this.newDiagram(),
                    save: () => this.save(),
                    'import-code': () => this.importCodeBase(),
                    c4: () => this.openC4(),
                    'export-png': () => this.exportPng(),
                    'export-svg': () => this.exportSvg(),
                    'export-smv': () => this.exportSmv(),
                    'export-python': () => this.codeExport.downloadPython(),
                    'export-notebook': () => this.codeExport.downloadNotebook(),
                    check: () => void this.check(),
                    simulate: () => this.simulate(),
                    'llm-settings': () => this.openLlmSettings(),
                    'help-guide': () => this.openHelp('guide'),
                    'help-walkthroughs': () => this.openHelp('walkthroughs'),
                    'toggle-theme': () => this.theme.toggle()
                },
                {
                    diagram: file => this.documents.open(file.text, file.name, 'file'),
                    model: file => void this.openCodeModel({ text: file.text, name: file.name, check: true }),
                    c4: file => this.openC4(file)
                },
                folder => this.openC4(folder)
            )
        );
    }

    ngOnInit(): void {
        void this.api.refreshStatus();
    }

    // ------------------------------------------------------------- panes

    resizeText(dx: number): void {
        const others = this.inspectorW() + MIN.canvasW;
        this.textW.set(clamp(this.textW() + dx, MIN.text, window.innerWidth - others));
    }

    resizeInspector(dx: number): void {
        const others = (this.showText() ? this.textW() : 28) + MIN.canvasW;
        this.inspectorW.set(clamp(this.inspectorW() - dx, MIN.inspector, window.innerWidth - others));
    }

    resizeBottom(dy: number): void {
        this.bottomH.set(clamp(this.bottomH() - dy, MIN.bottom, window.innerHeight - 60 - MIN.canvasH));
    }

    resetSize(pane: 'text' | 'inspector' | 'bottom'): void {
        if (pane === 'text') this.textW.set(DEFAULT_SIZES.text);
        if (pane === 'inspector') this.inspectorW.set(DEFAULT_SIZES.inspector);
        if (pane === 'bottom') this.bottomH.set(DEFAULT_SIZES.bottom);
        this.saveSizes();
    }

    saveSizes(): void {
        try {
            localStorage.setItem(SIZES_KEY, JSON.stringify({ text: this.textW(), inspector: this.inspectorW(), bottom: this.bottomH() }));
        } catch {
            // Storage unavailable: sizes last for this page only.
        }
    }

    toggleMenu(name: string, event: Event): void {
        event.stopPropagation();
        this.openMenu.set(this.openMenu() === name ? null : name);
    }

    @HostListener('document:click')
    closeMenus(): void {
        this.openMenu.set(null);
    }

    @HostListener('document:keydown', ['$event'])
    onKey(event: KeyboardEvent): void {
        if (event.key === 'Escape') this.openMenu.set(null);
        // A page (the code base report, C4) has its own keys: these act on the diagram.
        if (this.documents.page()) return;
        const target = event.target as HTMLElement;
        const typing = target.closest('input, textarea, select, .cm-editor, [contenteditable]');
        if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && this.store.selection()) {
            event.preventDefault();
            this.store.deleteSelection();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
            event.preventDefault();
            this.save();
        }
        if (event.key === 'Escape') {
            if (this.canvasMax() && !target.closest('dialog')) this.canvasMax.set(false);
            if (!typing) this.store.selection.set(null);
        }
    }

    @HostListener('window:beforeunload', ['$event'])
    beforeUnload(event: BeforeUnloadEvent): void {
        if (this.store.dirty()) event.preventDefault();
    }

    // ------------------------------------------------------------ File menu

    newDiagram(): void {
        this.documents.newDiagram();
    }

    async open(): Promise<void> {
        // .nxd is the extension used before ProvenFlow: still opened, saved as .pflow.
        const file = await pickFile('.pflow,.nxd,.txt');
        if (file) this.documents.open(file.text, file.name.replace(/\.nxd$/, '.pflow'), 'file');
    }

    /** File → Import code base…, in its tab: extracts and verifies models of a project (pflow extract). */
    importCodeBase(): void {
        if (!this.codeReport.running()) this.codeReport.clear();
        this.documents.openPage('report');
    }

    /** The last code-base report, in its tab: its findings and every model found, without importing again. */
    showCodeReport(): void {
        if (!this.codeReport.running()) this.codeReport.restore();
        this.documents.openPage('report');
    }

    /**
     * File → C4 architecture…, in its tab. With a folder (the code base report's System map), maps
     * its projects; with a workspace opened with the desktop application, shows it.
     */
    openC4(what?: string | DesktopFile): void {
        this.openMenu.set(null);
        this.documents.openPage('c4');
        if (typeof what === 'string') this.withC4(page => page.mapFolder(what));
        else if (what) this.withC4(page => page.openText(what.text, what.name));
    }

    /** Runs once the C4 page is there (it is created with its tab). */
    private withC4(action: (page: C4Page) => void): void {
        const page = this.c4();
        if (page) action(page);
        else
            afterNextRender(
                () => {
                    const created = this.c4();
                    if (created) action(created);
                },
                { injector: this.injector }
            );
    }

    /** Help → LLM settings: API keys and models for the LLM fixes of Import code base. */
    openLlmSettings(): void {
        void this.llmSettings().open();
    }

    /** Opens a model extracted from a code base in its own tab; checks it when it has false properties. */
    async openCodeModel(event: { text: string; name: string; check: boolean }): Promise<void> {
        this.documents.open(event.text, event.name, 'code');
        await this.store.settled();
        if (event.check && this.api.status().available) await this.check();
        else this.flash(`Opened ${event.name}: the comments at the top list the code behind each transition.`);
    }

    /** Imports an existing LangGraph / CrewAI / Mermaid / XState graph as a new diagram. */
    async importAgentGraph(): Promise<void> {
        const file = await pickFile('.json,.mmd,.mermaid,.md,.py,.ts,.js,.txt');
        if (!file) return;
        try {
            const result = importGraph(file.text);
            this.documents.open(serializeDiagram(result.model), file.name.replace(/\.[^.]+$/, '') + '.pflow', 'import');
            this.flash(`Imported ${file.name} (${result.format})${result.notes.length ? `: ${result.notes[0]}` : ''}`);
        } catch (error) {
            this.flash(`Could not import ${file.name}: ${(error as Error).message}`);
        }
    }

    save(): void {
        downloadText(this.store.fileName(), this.store.text());
        this.store.dirty.set(false);
        this.flash(`Saved ${this.store.fileName()}`);
    }

    exportSmv(): void {
        const g = this.store.generated();
        if (g.error) return this.flash(g.error);
        downloadText(this.store.fileName().replace(/\.(pflow|nxd)$/, '') + '.smv', g.text);
    }

    exportPng(): void {
        this.canvas()?.exportPng();
    }

    exportSvg(): void {
        this.canvas()?.exportSvg();
    }

    loadExample(id: string): void {
        this.documents.openExample(id);
    }

    // ----------------------------------------------------------- nuXmv menu

    async check(): Promise<void> {
        this.tab.set('properties');
        await this.api.verify();
        const v = this.store.verification();
        const firstTrace = v?.results.findIndex(r => r?.trace) ?? -1;
        if (v?.requestError || (v?.errors.length ?? 0) > 0) {
            // The check took a while: only move to the console if the user is still on the results.
            if (this.tab() === 'properties') this.tab.set('console');
        } else if (firstTrace >= 0) this.flash('Some properties are false: open a counterexample to replay it on the diagram.');
    }

    simulate(): void {
        this.store.startSimulation();
        this.tab.set('trace');
    }

    openHelp(section: HelpSection = 'guide'): void {
        this.help().open(section);
    }

    reveal(offset: number): void {
        this.showText.set(true);
        setTimeout(() => this.editor()?.reveal(offset));
    }

    private flash(text: string): void {
        this.message.set(text);
        setTimeout(() => this.message() === text && this.message.set(null), 4000);
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.round(Math.max(min, Math.min(Math.max(min, max), value)));
}
