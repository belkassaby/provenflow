import { Component, inject, output } from '@angular/core';
import { CodeImport } from '../code-import/code-import';
import { C4Store } from '../c4/c4-store';
import { DocumentTabs, type DocumentKind, type DocumentTab } from './document-tabs';

const ICONS: Record<DocumentKind, string> = { file: '▤', example: '★', new: '＋', code: '⌘', import: '⇪', report: '☰', c4: '▦' };
const TITLES: Record<DocumentKind, string> = {
    file: 'Opened from a file',
    example: 'Example',
    new: 'New diagram',
    code: 'Model found by Import code base',
    import: 'Imported agent graph',
    report: 'Import code base and its report',
    c4: 'C4 architecture'
};

/** One tab per open document or page, plus the way back to the last code-base report. */
@Component({
    selector: 'app-document-tabs',
    template: `
        <nav class="doc-tabs" aria-label="Open documents">
            <div class="doc-tab-list" role="tablist">
                @for (t of tabs.tabs(); track t.id) {
                    <div class="doc-tab" role="tab" [class.active]="t.id === tabs.active()" [attr.aria-selected]="t.id === tabs.active()" [title]="titles[t.kind] + ': ' + label(t)" (click)="tabs.activate(t.id)" (auxclick)="middleClick($event, t.id)">
                        <span class="doc-icon" aria-hidden="true">{{ icons[t.kind] }}</span>
                        <span class="doc-name">{{ label(t) }}</span>
                        @if (t.dirty) { <span class="doc-dirty" title="Unsaved changes">●</span> }
                        <button type="button" class="doc-close" (click)="$event.stopPropagation(); tabs.close(t.id)" [attr.aria-label]="'Close ' + label(t)">×</button>
                    </div>
                }
                <button type="button" class="doc-new" (click)="tabs.newDiagram()" title="New diagram" aria-label="New diagram">+</button>
            </div>
            @if (codeImport.report() && !tabs.pages().has('report')) {
                @let r = codeImport.report()!;
                <button type="button" class="doc-report" (click)="showReport.emit()" [title]="'Findings and models of ' + r.root + ' (' + r.models.length + ' models)'">
                    ⌘ Code report: {{ r.root }} <span class="badge warn">{{ r.summary.error + r.summary.warning }}</span>
                </button>
            }
        </nav>
    `
})
export class DocumentTabsBar {
    readonly tabs = inject(DocumentTabs);
    readonly codeImport = inject(CodeImport);
    readonly c4 = inject(C4Store);
    readonly showReport = output<void>();
    readonly icons = ICONS;
    readonly titles = TITLES;

    /** A diagram's file name; for a page, what it shows. */
    label(t: DocumentTab): string {
        if (t.kind === 'report') {
            const r = this.codeImport.report();
            return r && !this.codeImport.running() ? `Report: ${baseName(r.root)}` : 'Import code base';
        }
        if (t.kind === 'c4') return `C4: ${this.c4.fileName()}${this.c4.dirty() ? ' •' : ''}`;
        return t.fileName;
    }

    /** Middle click closes a tab, as in browsers (no return value: returning false would cancel the event). */
    middleClick(event: MouseEvent, id: number): void {
        if (event.button === 1) this.tabs.close(id);
    }
}

function baseName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
