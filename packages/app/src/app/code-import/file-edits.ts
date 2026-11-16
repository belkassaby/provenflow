import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { downloadText } from '../file-io';
import { ChangeActivity } from './change-activity';
import { CodeChange } from './code-change';
import { CodeDiff } from './code-diff';
import { combine, editsByFile, type FileChange } from './code-edits';
import { changeKey, CodeImport, type CodeFinding } from './code-import';
import { PracticeDetail } from './practice-detail';
import { PracticeCatalogue } from './practice-catalogue';

/**
 * Edits by file: every file with proposed changes, the changes combined into one before/after view
 * (each with its explanation and the practice behind it, and a checkbox to leave it out), and the
 * findings of the file that have no change yet, with buttons to propose one.
 */
@Component({
    selector: 'app-file-edits',
    imports: [CodeDiff, PracticeDetail, ChangeActivity],
    templateUrl: './file-edits.html'
})
export class FileEdits {
    /** The LLM for "LLM edit" (`anthropic:<model>`...), '' when none is configured. */
    readonly llmSpec = input('');
    readonly codeImport = inject(CodeImport);
    readonly change = inject(CodeChange);
    readonly catalogue = inject(PracticeCatalogue);
    readonly changeKey = changeKey;
    private readonly diff = viewChild(CodeDiff);

    /** `practices`: the findings of catalogue entries; `all`: every finding with a place in the code. */
    readonly scope = signal<'practices' | 'all'>('practices');
    readonly files = computed(() => {
        const findings = this.codeImport.report()?.findings ?? [];
        return editsByFile(this.scope() === 'all' ? findings : findings.filter(f => f.practice));
    });
    readonly fileName = signal<string | null>(null);
    readonly current = computed(() => this.files().find(f => f.file === this.fileName()) ?? this.files()[0]);
    /** Changes the reviewer left out (by finding). */
    readonly excluded = signal<ReadonlySet<string>>(new Set());
    readonly combined = computed(() => {
        const f = this.current();
        if (!f?.before && !f?.changes.length) return undefined;
        const included = f.changes.filter(c => this.isIncluded(c));
        return combine(f.before, included);
    });
    readonly openPractice = signal<string | null>(null);
    readonly message = signal<{ ok: boolean; text: string } | null>(null);
    readonly proposing = signal(false);

    constructor() {
        void this.catalogue.load();
    }

    select(file: string): void {
        this.fileName.set(file);
        this.message.set(null);
    }

    isIncluded(c: FileChange): boolean {
        const key = changeKey(c.finding);
        return !this.excluded().has(key) && !this.codeImport.appliedChanges().has(key);
    }

    isConflict(c: FileChange): boolean {
        return !!this.combined()?.conflicts.includes(c);
    }

    toggle(c: FileChange): void {
        const key = changeKey(c.finding);
        const next = new Set(this.excluded());
        if (next.has(key)) next.delete(key);
        else next.add(key);
        this.excluded.set(next);
    }

    practiceName(f: CodeFinding): string | undefined {
        return this.catalogue.entry(f.practice)?.name;
    }

    explain(f: CodeFinding): void {
        this.openPractice.set(this.openPractice() === changeKey(f) ? null : changeKey(f));
    }

    /** Writes the right-hand text (the combined changes, with the reviewer's edits) to the file. */
    async apply(): Promise<void> {
        const f = this.current();
        const combined = this.combined();
        if (!f || !combined) return;
        const error = await this.codeImport.apply(f.file, f.before, this.diff()?.current() ?? combined.after);
        if (!error) combined.applied.forEach(c => this.codeImport.markApplied(c.finding));
        this.message.set(error ? { ok: false, text: error } : { ok: true, text: `Applied ${combined.applied.length} change(s) to ${f.file}. Run the analysis again to check the project with them.` });
    }

    async export(how: 'download' | 'copy'): Promise<void> {
        const f = this.current();
        const text = this.diff()?.current() ?? this.combined()?.after;
        if (!f || text === undefined) return;
        if (how === 'download') downloadText(f.file.split('/').pop()!, text);
        else {
            await navigator.clipboard.writeText(text);
            this.message.set({ ok: true, text: 'Copied to the clipboard.' });
        }
    }

    /** A change for one finding: the analysis's own (a verified automatic fix, or a draft), or the LLM's. */
    async propose(f: CodeFinding, how: 'analysis' | 'llm'): Promise<boolean> {
        const result = how === 'llm' ? await this.change.llmFix(f, this.llmSpec()) : await this.change.quickFix(f);
        if (!result.finding) this.message.set({ ok: false, text: `${f.rule} (${f.subject}): ${result.error ?? 'no change proposed.'}` });
        return !!result.finding;
    }

    /** Proposes a change for each finding of the file that has none, one after the other. */
    async proposeAll(): Promise<void> {
        const pending = this.current()?.pending ?? [];
        this.proposing.set(true);
        let made = 0;
        try {
            for (const f of pending) if (await this.propose(f, 'analysis')) made++;
        } finally {
            this.proposing.set(false);
        }
        this.message.set({ ok: made > 0, text: `${made} of ${pending.length} change(s) proposed${made < pending.length ? ' (the others are about the project as a whole, or failed: see above)' : ''}.` });
    }
}
