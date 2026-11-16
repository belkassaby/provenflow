import { Component, computed, inject, signal } from '@angular/core';
import { PracticeDetail } from './practice-detail';
import { KIND_TITLES, PracticeCatalogue, type PracticeKind } from './practice-catalogue';

/**
 * Import code base → Patterns and practices: the catalogue grouped by kind (design patterns,
 * principles, anti-patterns), each entry with its one-line solution, a checkbox selecting it for the
 * next analysis, and its full explanation on request.
 */
@Component({
    selector: 'app-practice-picker',
    imports: [PracticeDetail],
    templateUrl: './practice-picker.html'
})
export class PracticePicker {
    readonly catalogue = inject(PracticeCatalogue);
    readonly kindTitles = KIND_TITLES;
    /** The entry whose explanation is open. */
    readonly open = signal<string | null>(null);
    readonly filter = signal('');

    constructor() {
        void this.catalogue.load();
    }

    /** The groups with the entries matching the filter (name, summary or rules). */
    readonly groups = computed(() => {
        const q = this.filter().trim().toLowerCase();
        return this.catalogue
            .groups()
            .map(g => ({ ...g, entries: q ? g.entries.filter(e => `${e.name} ${e.summary} ${e.rules.join(' ')}`.toLowerCase().includes(q)) : g.entries }))
            .filter(g => g.entries.length > 0);
    });

    selectedIn(kind: PracticeKind): number {
        return this.catalogue.entries().filter(e => e.kind === kind && this.catalogue.isSelected(e.id)).length;
    }

    explain(id: string): void {
        this.open.set(this.open() === id ? null : id);
    }
}
