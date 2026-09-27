import { Component, computed, DestroyRef, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { CodeDiff } from './code-diff';
import { downloadText } from '../file-io';
import { HelpService } from '../help-dialog/help.service';
import { LlmSettings } from '../llm-settings/llm-settings';
import { changeKey, CodeImport, type CodeFinding, type CodeModel } from './code-import';

type View = 'findings' | 'changes' | 'change' | 'models' | 'model' | 'modelChange' | 'patterns' | 'paradigm' | 'tools';
type Severity = CodeFinding['severity'];

const CATEGORY_LABELS: Record<CodeFinding['category'], string> = {
    security: 'Security and dataflow',
    memory: 'Memory safety and arithmetic',
    heap: 'Heap (interprocedural)',
    build: 'Build and tests',
    'state-machine': 'State machines',
    lifecycle: 'Resource lifecycles',
    pattern: 'Design patterns',
    architecture: 'Architecture',
    paradigm: 'Paradigm and size'
};

function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

const PROOF_ORDER = { refuted: 0, unknown: 1, proved: 2 } as const;

const SOURCE_LABELS: Partial<Record<CodeFinding['source'], string>> = {
    semgrep: 'Semgrep',
    codeql: 'CodeQL',
    infer: 'Infer',
    esbmc: 'ESBMC',
    cbmc: 'CBMC',
    kani: 'Kani',
    sarif: 'SARIF',
    build: 'build'
};

/**
 * File → Import code base…: runs `pflow extract` on a folder (uploaded, or a path of the machine
 * running the server) and shows the findings; every extracted model opens in the editor.
 */
@Component({
    selector: 'app-code-import-dialog',
    imports: [CodeDiff],
    templateUrl: './code-import-dialog.html'
})
export class CodeImportDialog {
    readonly codeImport = inject(CodeImport);
    readonly help = inject(HelpService);
    /** A model to open in the editor: its .pflow text and a file name. */
    readonly openModel = output<{ text: string; name: string; check: boolean }>();
    /** Asks the app to open Help → LLM settings. */
    readonly llmSettings = output<void>();
    readonly llm = inject(LlmSettings);

    private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
    readonly path = signal('');
    readonly view = signal<View>('findings');
    readonly shown = signal<ReadonlySet<Severity>>(new Set<Severity>(['error', 'warning']));
    readonly categoryLabels = CATEGORY_LABELS;

    readonly report = this.codeImport.report;

    /** Ticks every second while an analysis runs, for the elapsed time. */
    private readonly now = signal(Date.now());
    readonly elapsed = computed(() => (this.codeImport.running() ? this.duration(this.now() - this.codeImport.startedAt()) : ''));

    constructor() {
        const timer = setInterval(() => {
            if (this.codeImport.running()) this.now.set(Date.now());
        }, 1000);
        inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }

    readonly duration = formatDuration;

    readonly groups = computed(() => {
        const r = this.report();
        if (!r) return [];
        const shown = this.shown();
        return (Object.keys(CATEGORY_LABELS) as Array<CodeFinding['category']>)
            .map(category => ({ category, label: CATEGORY_LABELS[category], findings: r.findings.filter(f => f.category === category && shown.has(f.severity)) }))
            .filter(g => g.findings.length > 0);
    });

    readonly properties = computed(() => this.report()?.verdicts.length ?? 0);

    /** Proofs about the code (ESBMC, CBMC, Kani), refuted first. */
    readonly proofs = computed(() => [...(this.report()?.proofs ?? [])].sort((a, b) => PROOF_ORDER[a.status] - PROOF_ORDER[b.status] || a.subject.localeCompare(b.subject)));
    /** Notes about analysers that are not installed. */
    readonly missingTools = computed(() => (this.report()?.notes ?? []).filter(n => /not installed/.test(n)));

    /** Who found a finding: ProvenFlow's model, or an external analyser. */
    sourceLabel(f: CodeFinding): string {
        return SOURCE_LABELS[f.source] ?? f.source;
    }

    /** Findings with a proposed code change. */
    readonly changes = computed(() => (this.report()?.findings ?? []).filter(f => f.suggestedPatch?.files?.length));
    /** The change being reviewed, and which of its files. */
    readonly reviewing = signal<CodeFinding | null>(null);
    readonly fileIndex = signal(0);
    readonly applyMessage = signal<{ ok: boolean; text: string } | null>(null);
    private readonly diff = viewChild(CodeDiff);
    private back: View = 'findings';
    private reviewBack: View = 'findings';

    /** The model whose properties are shown, and the model change being looked at. */
    readonly modelShown = signal<CodeModel | null>(null);
    readonly modelChange = signal<{ finding: CodeFinding; change: NonNullable<NonNullable<CodeFinding['suggestedPatch']>['models']>[number] } | null>(null);

    /** Each property of a model with its verdict and the finding it produced (when false). */
    readonly modelProperties = computed(() => {
        const m = this.modelShown();
        const r = this.report();
        if (!m || !r) return [];
        return r.verdicts
            .filter(v => v.model === m.id)
            .map(v => ({ ...v, finding: r.findings.find(f => f.model === m.id && f.spec?.startsWith(`${v.spec} :=`)) }));
    });

    /** Findings on a model that are not a property (graph checks: stuck states, unhandled cases). */
    readonly modelOtherFindings = computed(() => {
        const m = this.modelShown();
        return (this.report()?.findings ?? []).filter(f => f.model === m?.id && !f.spec);
    });

    showModel(m: CodeModel): void {
        if (this.view() !== 'model' && this.view() !== 'modelChange') this.back = this.view();
        this.modelShown.set(m);
        this.view.set('model');
    }

    showModelOf(f: CodeFinding): void {
        const m = this.modelOf(f.model);
        if (m) this.showModel(m);
    }

    /** The model re-extracted from the changed code, next to the current one. */
    showModelChange(f: CodeFinding): void {
        const m = this.modelShown() ?? this.modelOf(f.model);
        const change = f.suggestedPatch?.models?.find(c => c.id === m?.id) ?? f.suggestedPatch?.models?.[0];
        if (!change) return;
        if (m) this.modelShown.set(m);
        this.modelChange.set({ finding: f, change });
        this.view.set('modelChange');
    }

    /** Opens the changed model in a tab, as it would be extracted after applying the change. */
    openChangedModel(): void {
        const c = this.modelChange()?.change;
        if (c?.after) {
            this.openModel.emit({ text: c.after, name: `${c.id}-after-change.pflow`, check: true });
            this.close();
        }
    }

    backToModel(): void {
        this.view.set('model');
    }

    backFromModel(): void {
        this.view.set(this.back === 'model' || this.back === 'modelChange' ? 'models' : this.back);
    }

    review(f: CodeFinding): void {
        this.reviewBack = this.view() === 'change' ? this.reviewBack : this.view();
        this.reviewing.set(f);
        this.fileIndex.set(0);
        this.applyMessage.set(null);
        this.view.set('change');
    }

    closeReview(): void {
        this.view.set(this.reviewBack);
        this.reviewing.set(null);
    }

    /** Applies the right-hand text (with any edits) to the file in the analysed folder. */
    async applyChange(): Promise<void> {
        const f = this.reviewing();
        const file = f?.suggestedPatch?.files?.[this.fileIndex()];
        if (!file) return;
        const error = await this.codeImport.apply(file.file, file.before, this.diff()?.current() ?? file.after);
        if (!error && f && (f.suggestedPatch?.files?.length ?? 0) <= 1) this.codeImport.markApplied(f);
        this.applyMessage.set(error ? { ok: false, text: error } : { ok: true, text: `Applied to ${file.file}. Run the analysis again to check the whole project with the change (other proposals for this file are now out of date).` });
    }

    downloadChange(): void {
        const file = this.reviewing()?.suggestedPatch?.files?.[this.fileIndex()];
        if (file) downloadText(file.file.split('/').pop()!, this.diff()?.current() ?? file.after);
    }

    async copyChange(): Promise<void> {
        const file = this.reviewing()?.suggestedPatch?.files?.[this.fileIndex()];
        if (!file) return;
        await navigator.clipboard.writeText(this.diff()?.current() ?? file.after);
        this.applyMessage.set({ ok: true, text: 'Copied to the clipboard.' });
    }

    /** Analyses the same folder again: after applying changes, only what they can affect (`incremental`). */
    async rerun(incremental = true): Promise<void> {
        const r = this.report();
        if (r?.applicable) this.path.set(r.root);
        this.applyAllResults.set(null);
        await this.codeImport.reanalyse(incremental);
        this.view.set('findings');
    }

    /** Choose folder…: with write access where the browser allows it, otherwise an uploaded copy. */
    async chooseFolder(input: HTMLInputElement): Promise<void> {
        if (!(await this.codeImport.pickWritableFolder())) input.click();
        else this.view.set('findings');
    }

    /** Apply all: which changes, and what happened to each. */
    readonly includeUnverified = signal(false);
    readonly applyAllResults = signal<Awaited<ReturnType<CodeImport['applyAll']>> | null>(null);
    readonly applyingAll = signal(false);
    readonly toApply = computed(() => this.changes().filter(f => (this.includeUnverified() || f.suggestedPatch!.verified) && !this.codeImport.appliedChanges().has(changeKey(f))));

    isApplied(f: CodeFinding): boolean {
        return this.codeImport.appliedChanges().has(changeKey(f));
    }

    async applyAllChanges(): Promise<void> {
        const list = this.toApply();
        if (list.length === 0) return;
        const files = [...new Set(list.flatMap(f => f.suggestedPatch!.files!.map(pf => pf.file)))];
        if (!confirm(`Apply ${list.length} change(s) to ${files.length} file(s)?\n\n${files.join('\n')}`)) return;
        this.applyingAll.set(true);
        try {
            this.applyAllResults.set(await this.codeImport.applyAll(list));
        } finally {
            this.applyingAll.set(false);
        }
    }

    /** `fresh`: start a new analysis; otherwise show the last report (kept across reloads). */
    open(fresh = false): void {
        void this.codeImport.refresh();
        void this.llm.load();
        if (!this.codeImport.running()) {
            if (fresh) this.codeImport.clear();
            else this.codeImport.restore();
        }
        const dialog = this.dialog().nativeElement;
        if (!dialog.open) dialog.showModal();
    }

    close(): void {
        this.dialog().nativeElement.close();
    }

    /**
     * Closes when the backdrop (the dialog element itself) is clicked. Returns nothing: an Angular
     * handler returning false cancels the event, which would stop file pickers and links inside.
     */
    backdropClick(event: MouseEvent): void {
        if (event.target === this.dialog().nativeElement) this.close();
    }

    toggle(severity: Severity): void {
        const next = new Set(this.shown());
        if (next.has(severity)) next.delete(severity);
        else next.add(severity);
        this.shown.set(next);
    }

    async analysePath(): Promise<void> {
        if (!this.path().trim()) return;
        await this.codeImport.analysePath(this.path());
        this.view.set('findings');
    }

    async analyseFolder(files: FileList | null): Promise<void> {
        await this.codeImport.analyseFolder(files);
        this.view.set('findings');
    }

    modelOf(id: string | undefined): CodeModel | undefined {
        return id ? this.report()?.models.find(m => m.id === id) : undefined;
    }

    /** Opens a model in the editor; from a finding, also checks it so the counterexample is one click away. */
    show(model: CodeModel, check = model.failed.length > 0): void {
        this.openModel.emit({ text: model.pflow, name: `${model.id}.pflow`, check });
        this.close();
    }

    where(loc: { file: string; line: number } | undefined): string {
        return loc ? `${loc.file}:${loc.line}` : '';
    }

    downloadReport(): void {
        const r = this.report();
        if (r) downloadText('provenflow-code-report.md', r.markdown, 'text/markdown');
    }

    openLlmSettings(): void {
        this.close();
        this.llmSettings.emit();
    }

    /** Help → a walkthrough: the Code base review, or how to install the analysers ('analyzers'). */
    walkthrough(id = 'code'): void {
        this.close();
        this.help.walkthrough(id);
    }
}
