import { computed, Injectable, signal } from '@angular/core';
import { PRACTICE_KIND_TITLES, type Practice, type PracticeKind } from '@provenflow/language';

export type { Practice, PracticeKind } from '@provenflow/language';
export const KIND_TITLES = PRACTICE_KIND_TITLES;
const KINDS = Object.keys(KIND_TITLES) as PracticeKind[];

/** The entries selected in this browser (ids), kept across reloads. */
const SELECTION_KEY = 'provenflow.practices';

function loadSelection(): string[] | null {
    try {
        const stored = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as unknown;
        return Array.isArray(stored) && stored.every(x => typeof x === 'string') ? stored : null;
    } catch {
        return null;
    }
}

function saveSelection(ids: Iterable<string>): void {
    try {
        localStorage.setItem(SELECTION_KEY, JSON.stringify([...ids]));
    } catch {
        // Private mode or blocked storage: the selection lasts for this page only.
    }
}

/**
 * The patterns and practices the code checks verify, and which of them the next analysis checks.
 * The selection is sent with the analysis (`checks.select`); findings name their entry (`practice`).
 */
@Injectable({ providedIn: 'root' })
export class PracticeCatalogue {
    readonly entries = signal<Practice[]>([]);
    readonly error = signal<string | null>(null);
    /** Selected ids; null until the catalogue is loaded (the server's defaults apply meanwhile). */
    readonly selected = signal<ReadonlySet<string> | null>(null);
    private loading?: Promise<void>;

    readonly groups = computed(() => KINDS.map(kind => ({ kind, title: KIND_TITLES[kind], entries: this.entries().filter(e => e.kind === kind) })).filter(g => g.entries.length > 0));
    readonly selectedCount = computed(() => this.selected()?.size ?? this.entries().filter(e => e.selected).length);

    load(): Promise<void> {
        this.loading ??= this.fetch();
        return this.loading;
    }

    private async fetch(): Promise<void> {
        try {
            const res = await fetch('api/catalogue');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { entries } = (await res.json()) as { entries: Practice[] };
            this.entries.set(entries);
            const known = new Set(entries.map(e => e.id));
            const stored = loadSelection()?.filter(id => known.has(id));
            this.selected.set(new Set(stored ?? entries.filter(e => e.selected).map(e => e.id)));
            this.error.set(null);
        } catch (error) {
            this.loading = undefined;
            this.error.set(`The catalogue could not be loaded (${(error as Error).message}): the analysis checks the default selection.`);
        }
    }

    entry(id: string | undefined): Practice | undefined {
        return id ? this.entries().find(e => e.id === id) : undefined;
    }

    isSelected(id: string): boolean {
        return this.selected()?.has(id) ?? !!this.entry(id)?.selected;
    }

    toggle(id: string): void {
        const next = new Set(this.selected() ?? []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.update(next);
    }

    /** Selects or clears every entry of a kind. */
    setKind(kind: PracticeKind, on: boolean): void {
        const next = new Set(this.selected() ?? []);
        for (const e of this.entries().filter(x => x.kind === kind)) {
            if (on) next.add(e.id);
            else next.delete(e.id);
        }
        this.update(next);
    }

    /** `defaults`: the catalogue's default selection; `all`; `none`. */
    preset(which: 'defaults' | 'all' | 'none'): void {
        const entries = this.entries();
        this.update(new Set(which === 'none' ? [] : entries.filter(e => which === 'all' || e.selected).map(e => e.id)));
    }

    /** What to send with an analysis: the selected ids, or nothing (server defaults) before the catalogue loads. */
    checks(): { select: string[] } | undefined {
        const selected = this.selected();
        return selected ? { select: [...selected] } : undefined;
    }

    private update(next: Set<string>): void {
        this.selected.set(next);
        saveSelection(next);
    }
}
