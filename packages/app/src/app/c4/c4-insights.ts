import { Component, computed, inject, signal } from '@angular/core';
import { C4Discovery, SUGGESTION_LABELS, type PlacementSuggestion } from './c4-discovery';
import { C4Store } from './c4-store';

/**
 * Where code belongs: the placement suggestions of the last mapping, by kind. Choosing one points
 * out its projects in the landscape (and opens it when the current view does not show them).
 */
@Component({
    selector: 'app-c4-suggestions',
    template: `
    @if (discovery.map(); as m) {
      <div class="c4-filter">
        <select [value]="kind()" (change)="kind.set($any($event.target).value)" aria-label="Kind of suggestion">
          <option value="">All ({{ m.suggestions.length }})</option>
          @for (k of kinds(); track k.kind) { <option [value]="k.kind">{{ labels[k.kind] ?? k.kind }} ({{ k.count }})</option> }
        </select>
        @if (store.highlight().size) { <button type="button" class="small" (click)="store.highlight.set(emptySet)">Clear highlight</button> }
      </div>
      <ul class="c4-suggestions">
        @for (s of shown(); track $index) {
          <li [class]="s.severity" [class.open]="open() === $index">
            <button type="button" class="c4-suggestion-head" (click)="choose(s, $index)">
              <span class="badge" [class.fail]="s.severity === 'error'" [class.warn]="s.severity === 'warning'">{{ s.severity }}</span>
              <span>{{ s.title }}</span>
            </button>
            @if (open() === $index) {
              <p class="small">{{ s.detail }}</p>
              <p class="small muted">{{ labels[s.kind] ?? s.kind }} · {{ s.confidence }} confidence@if (s.practice) { · {{ s.practice }} }</p>
              @if (s.files.length) {
                <ul class="small c4-files">
                  @for (f of s.files.slice(0, 12); track $index) { <li><span class="muted">{{ projectName(f.project) }}</span> <code>{{ f.file }}{{ f.line ? ':' + f.line : '' }}</code></li> }
                  @if (s.files.length > 12) { <li class="muted">… {{ s.files.length - 12 }} more</li> }
                </ul>
              }
            }
          </li>
        } @empty {
          <li class="muted small">No suggestions{{ kind() ? ' of this kind' : '' }}.</li>
        }
      </ul>
    } @else {
      <p class="muted small">Map the projects of a folder (Map tab) to see where code belongs.</p>
    }
  `
})
export class C4Suggestions {
    readonly discovery = inject(C4Discovery);
    readonly store = inject(C4Store);
    readonly labels = SUGGESTION_LABELS;
    readonly emptySet: ReadonlySet<string> = new Set();
    readonly kind = signal('');
    readonly open = signal<number | null>(null);
    readonly kinds = computed(() => {
        const counts = new Map<string, number>();
        for (const s of this.discovery.map()?.suggestions ?? []) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
        return [...counts].map(([kind, count]) => ({ kind, count }));
    });
    readonly shown = computed(() => (this.discovery.map()?.suggestions ?? []).filter(s => !this.kind() || s.kind === this.kind()));

    projectName(id: string): string {
        return this.discovery.byId().get(id)?.name ?? id;
    }

    /** Opens a suggestion and points out its projects, in a view that shows them all. */
    choose(s: PlacementSuggestion, index: number): void {
        this.open.set(this.open() === index ? null : index);
        const ids = this.discovery.elementsOf(s);
        this.store.highlight.set(ids);
        const shown = new Set(this.store.contents().nodes.map(n => n.id));
        if ([...ids].every(id => shown.has(id))) return;
        const landscape = this.store.workspace().views.find(v => v.type === 'systemLandscape');
        if (landscape) this.store.showView(landscape.key);
    }
}

/** The projects of the last mapping, and the dependencies between them with their ranges. */
@Component({
    selector: 'app-c4-projects',
    template: `
    @if (discovery.map(); as m) {
      <table class="code-table">
        <thead><tr><th>Project</th><th>Version</th><th>Kind</th></tr></thead>
        <tbody>
          @for (p of m.projects; track p.id) {
            <tr [class.c4-focus]="p.focus">
              <td><button type="button" class="link" (click)="show(p.id)">{{ p.name }}</button><br /><code class="small muted">{{ p.path }}</code></td>
              <td>{{ p.version ?? '' }}</td>
              <td class="small">{{ p.ecosystem }} {{ p.application ? 'application' : 'library' }}@if (!p.owned) { <br /><span class="badge">other owner</span> }</td>
            </tr>
          }
        </tbody>
      </table>
      <h4>Dependencies between them ({{ m.links.length }})</h4>
      <ul class="small c4-links">
        @for (l of m.links; track $index) {
          <li>{{ name(l.from) }}@if (l.fromModule) { <span class="muted">({{ l.fromModule }})</span> } → {{ name(l.to) }} <code>{{ l.dependency.range ?? '' }}</code>
            @if (l.dependency.kind !== 'runtime') { <span class="badge">{{ l.dependency.kind }}</span> }
            @if (l.satisfied === false) { <span class="badge warn">local {{ l.version }}</span> }
          </li>
        }
      </ul>
      @if (m.libraries.length) {
        <h4>Libraries they share</h4>
        <p class="small">@for (lib of m.libraries.slice(0, 20); track lib.name) { <code>{{ lib.name }}</code> ({{ lib.users.length }}){{ $last ? '' : ', ' }} }</p>
      }
      @for (n of m.notes; track $index) { <p class="small muted">{{ n }}</p> }
    } @else {
      <p class="muted small">No projects mapped yet.</p>
    }
  `
})
export class C4Projects {
    readonly discovery = inject(C4Discovery);
    readonly store = inject(C4Store);

    name(id: string): string {
        return this.discovery.byId().get(id)?.name ?? id;
    }

    show(id: string): void {
        this.store.highlight.set(new Set([id]));
        this.store.selection.set({ kind: 'element', id });
    }
}
