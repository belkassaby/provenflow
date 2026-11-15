import { Component, computed, inject, output, signal } from '@angular/core';
import { CodeImport, type CodeFinding, type CodeReport } from './code-import';
import { PracticeDetail } from './practice-detail';
import { KIND_TITLES, PracticeCatalogue, type Practice, type PracticeKind } from './practice-catalogue';

type Instance = CodeReport['patterns'][number];

interface EntryResult {
    practice: Practice;
    /** Checked by this analysis (selected when it ran). */
    checked: boolean;
    instances: Instance[];
    findings: CodeFinding[];
}

/**
 * Code base review → Patterns & practices: for each catalogue entry, what the analysis found: the
 * instances of a design pattern recognised in the code, where a pattern is broken, and where a
 * principle is not followed or an anti-pattern occurs, with the entry's explanation.
 */
@Component({
    selector: 'app-practice-results',
    imports: [PracticeDetail],
    templateUrl: './practice-results.html'
})
export class PracticeResults {
    readonly codeImport = inject(CodeImport);
    readonly catalogue = inject(PracticeCatalogue);
    /** Asks the dialog to open a model (a pattern's contract). */
    readonly showModel = output<string>();
    /** Asks the dialog to show the edits of the files. */
    readonly showEdits = output<void>();
    readonly open = signal<string | null>(null);

    constructor() {
        void this.catalogue.load();
    }

    /** The entries checked by the analysis that produced the report: its config's selection, else the defaults. */
    private readonly checkedIds = computed(() => {
        const checks = this.codeImport.report()?.config?.checks;
        const entries = this.catalogue.entries();
        const skip = new Set(checks?.skip ?? []);
        return new Set((checks?.select ?? entries.filter(e => e.selected).map(e => e.id)).filter(id => !skip.has(id)));
    });

    readonly groups = computed(() => {
        const r = this.codeImport.report();
        const checked = this.checkedIds();
        const results: EntryResult[] = this.catalogue.entries().map(practice => ({
            practice,
            checked: checked.has(practice.id),
            instances: (r?.patterns ?? []).filter(p => p.pattern === practice.id),
            findings: (r?.findings ?? []).filter(f => f.practice === practice.id)
        }));
        return (Object.keys(KIND_TITLES) as PracticeKind[]).map(kind => ({ kind, title: KIND_TITLES[kind], results: results.filter(x => x.practice.kind === kind && x.checked) }));
    });

    readonly unchecked = computed(() => this.catalogue.entries().filter(e => !this.checkedIds().has(e.id)));

    status(x: EntryResult): { text: string; tone: 'ok' | 'warn' | 'fail' | '' } {
        const worst = x.findings.some(f => f.severity === 'error') ? 'fail' : x.findings.some(f => f.severity === 'warning') ? 'warn' : '';
        if (x.findings.length) return { text: `${x.findings.length} ${x.practice.kind === 'pattern' ? 'broken' : x.practice.kind === 'principle' ? 'not followed' : 'found'}`, tone: worst || 'warn' };
        if (x.practice.kind === 'pattern') return x.instances.length ? { text: `✓ ${x.instances.length} found, all hold`, tone: 'ok' } : { text: 'not used', tone: '' };
        return { text: x.practice.kind === 'principle' ? '✓ followed' : '✓ none', tone: 'ok' };
    }

    toggle(id: string): void {
        this.open.set(this.open() === id ? null : id);
    }

    where(loc: { file: string; line: number } | undefined): string {
        return loc ? `${loc.file}:${loc.line}` : '';
    }
}
