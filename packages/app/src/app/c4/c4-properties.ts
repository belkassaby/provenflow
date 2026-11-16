import { Component, computed, inject } from '@angular/core';
import { C4_ROUTING_LABELS, C4_ROUTINGS, C4_SIDES, C4_TYPE_LABELS, C4_VIEW_LABELS, routingOf, type C4Anchors, type C4Direction, type C4Element, type C4Relationship, type C4Routing, type C4Side } from '@provenflow/language';
import { C4Discovery } from './c4-discovery';
import { C4Store } from './c4-store';

const list = (text: string) => text.split(',').map(s => s.trim()).filter(Boolean);

/** Edits what is selected in the C4 diagram: an element, a relationship, or (nothing selected) the view. */
@Component({
    selector: 'app-c4-properties',
    template: `
    @if (element(); as e) {
      <h3>{{ typeLabels[e.type] }} <code class="muted small">{{ e.id }}</code></h3>
      <label class="c4-field">Name <input [value]="e.name" (change)="setElement(e, 'name', $event)" /></label>
      <label class="c4-field">Description <textarea rows="3" [value]="e.description ?? ''" (change)="setElement(e, 'description', $event)"></textarea></label>
      @if (e.type !== 'person' && e.type !== 'softwareSystem') {
        <label class="c4-field">Technology <input [value]="e.technology ?? ''" (change)="setElement(e, 'technology', $event)" /></label>
      }
      <label class="c4-field">Tags <input [value]="e.tags.join(', ')" placeholder="External, Database" (change)="setTags(e, $event)" /></label>
      <label class="c4-field">Group <input [value]="e.group ?? ''" (change)="setElement(e, 'group', $event)" /></label>
      @if (e.parent) { <p class="small muted">In {{ store.index().get(e.parent)?.name ?? e.parent }}</p> }
      @if (project(e.id); as p) {
        <p class="small"><span class="muted">Project</span> {{ p.ecosystem }} {{ p.version ?? '' }} · <code>{{ p.path }}</code>@if (p.remote) { · {{ p.remote }} }</p>
      }
      <div class="c4-actions">
        @if (e.type === 'softwareSystem' || e.type === 'container') { <button type="button" (click)="store.drillDown(e.id)">Open {{ e.type === 'container' ? 'components' : 'containers' }}</button> }
        @if (e.type === 'softwareSystem') { <button type="button" (click)="store.openView('systemContext', e.id)">Open context</button> }
        <button type="button" (click)="store.removeSelected()">Delete</button>
      </div>
    } @else if (relationship(); as r) {
      <h3>Relationship</h3>
      <p class="small">{{ name(r.source) }} → {{ name(r.destination) }}</p>
      @if (implied()) { <p class="small muted">Shown on {{ name(implied()!.source) }} → {{ name(implied()!.target) }} (implied by this one).</p> }
      <label class="c4-field">Description <input [value]="r.description ?? ''" (change)="setRelationship(r, 'description', $event)" /></label>
      <label class="c4-field">Technology <input [value]="r.technology ?? ''" (change)="setRelationship(r, 'technology', $event)" /></label>
      <label class="c4-field">Tags <input [value]="r.tags.join(', ')" (change)="setRelationshipTags(r, $event)" /></label>
      @if (line(); as l) {
        <label class="c4-field">Line in this view
          <select [value]="l.chosen ?? ''" (change)="setLine($event)">
            <option value="">Like the others ({{ routingLabels[l.styled] }})</option>
            @for (o of routings; track o) { <option [value]="o">{{ routingLabels[o] }}</option> }
          </select>
        </label>
        <div class="c4-sides">
          @for (end of ends; track end.key) {
            <label class="c4-field">{{ end.label }}
              <select [value]="l.anchors[end.key] ?? ''" (change)="setSide(end.key, $event)">
                <option value="">The shortest way</option>
                @for (side of sides; track side) { <option [value]="side">{{ sideLabels[side] }} of {{ name(end.key === 'source' ? l.source : l.target) }}</option> }
              </select>
            </label>
          }
        </div>
        <p class="small muted">Or drag the ends of the selected line to a side of its box, or to another box.</p>
      }
      <div class="c4-actions"><button type="button" (click)="store.removeSelected()">Delete</button></div>
    } @else if (store.view(); as v) {
      <h3>{{ viewLabels[v.type] }} view</h3>
      @if (v.scope && v.scope !== '*') { <p class="small muted">Of {{ name(v.scope) }}</p> }
      <label class="c4-field">Key <input [value]="v.key" (change)="setView('key', $event)" /></label>
      <label class="c4-field">Title <input [value]="v.title ?? ''" (change)="setView('title', $event)" /></label>
      <label class="c4-field">Description <textarea rows="2" [value]="v.description ?? ''" (change)="setView('description', $event)"></textarea></label>
      <label class="c4-field">Layout
        <select [value]="v.autoLayout?.direction ?? 'tb'" (change)="setDirection($event)">
          <option value="tb">Top to bottom</option><option value="lr">Left to right</option><option value="bt">Bottom to top</option><option value="rl">Right to left</option>
        </select>
      </label>
      @if (v.type !== 'dynamic') {
        <label class="c4-field">Include <input [value]="v.include.join(' ') || '*'" (change)="setList('include', $event)" /></label>
        <label class="c4-field">Exclude <input [value]="v.exclude.join(' ')" (change)="setList('exclude', $event)" /></label>
      }
      <p class="small muted">{{ store.contents().nodes.length }} elements, {{ store.contents().edges.length }} relationships. Double-click a system or container to open the next level; drag to place (the view keeps the placement).</p>
      <div class="c4-actions"><button type="button" (click)="store.removeView(v.key)">Delete view</button></div>
    } @else {
      <p class="muted small">No view: open a model, map the projects of a folder, or add an element.</p>
    }
  `
})
export class C4Properties {
    readonly store = inject(C4Store);
    private readonly discovery = inject(C4Discovery);
    readonly typeLabels = C4_TYPE_LABELS;
    readonly viewLabels = C4_VIEW_LABELS;

    readonly element = computed(() => {
        const sel = this.store.selection();
        return sel?.kind === 'element' ? this.store.index().get(sel.id) : undefined;
    });
    readonly relationship = computed(() => {
        const sel = this.store.selection();
        return sel?.kind === 'relationship' ? this.store.workspace().relationships.find(r => r.id === sel.id.split('@')[0]) : undefined;
    });
    /** For an implied relationship: the edge it is shown as. */
    readonly implied = computed(() => {
        const sel = this.store.selection();
        return sel?.kind === 'relationship' && sel.id.includes('@') ? this.store.contents().edges.find(e => e.id === sel.id) : undefined;
    });

    readonly routings = C4_ROUTINGS;
    readonly routingLabels = C4_ROUTING_LABELS;
    /** How the selected relationship is drawn in the view: chosen for it, or as its style says. */
    readonly line = computed(() => {
        const sel = this.store.selection();
        const edge = sel?.kind === 'relationship' ? this.store.contents().edges.find(e => e.id === sel.id) : undefined;
        if (!edge) return undefined;
        const anchors: C4Anchors = this.store.view()?.anchors?.[edge.id] ?? {};
        return { id: edge.id, source: edge.source, target: edge.target, anchors, chosen: this.store.view()?.routing?.[edge.id], styled: routingOf(this.store.workspace(), undefined, edge) };
    });
    readonly sides = C4_SIDES;
    readonly sideLabels: Record<C4Side, string> = { top: 'Top', right: 'Right side', bottom: 'Bottom', left: 'Left side' };
    readonly ends: Array<{ key: keyof C4Anchors; label: string }> = [
        { key: 'source', label: 'Starts at' },
        { key: 'target', label: 'Ends at' }
    ];

    setSide(end: keyof C4Anchors, event: Event): void {
        const id = this.line()?.id;
        if (id) this.store.setAnchor(id, end, (this.value(event) || undefined) as C4Side | undefined);
    }

    setLine(event: Event): void {
        const id = this.line()?.id;
        if (id) this.store.setRouting(id, (this.value(event) || undefined) as C4Routing | undefined);
    }

    name(id: string): string {
        return this.store.index().get(id)?.name ?? id;
    }

    project(id: string) {
        return this.discovery.byId().get(id);
    }

    private value(event: Event): string {
        return (event.target as HTMLInputElement).value;
    }

    setElement(e: C4Element, field: 'name' | 'description' | 'technology' | 'group', event: Event): void {
        const v = this.value(event).trim();
        this.store.updateElement(e.id, { [field]: v || (field === 'name' ? e.name : undefined) });
    }

    setTags(e: C4Element, event: Event): void {
        this.store.updateElement(e.id, { tags: list(this.value(event)) });
    }

    setRelationship(r: C4Relationship, field: 'description' | 'technology', event: Event): void {
        this.store.updateRelationship(r.id, { [field]: this.value(event).trim() || undefined });
    }

    setRelationshipTags(r: C4Relationship, event: Event): void {
        this.store.updateRelationship(r.id, { tags: list(this.value(event)) });
    }

    setView(field: 'key' | 'title' | 'description', event: Event): void {
        const v = this.store.view();
        const value = this.value(event).trim();
        if (!v || (field === 'key' && (!value || this.store.workspace().views.some(x => x.key === value)))) return;
        this.store.updateView(v.key, { [field]: value || undefined });
    }

    setDirection(event: Event): void {
        const v = this.store.view();
        if (!v) return;
        this.store.updateView(v.key, { autoLayout: { ...v.autoLayout, direction: this.value(event) as C4Direction }, positions: undefined });
        this.store.layoutRequests.update(n => n + 1);
    }

    setList(field: 'include' | 'exclude', event: Event): void {
        const v = this.store.view();
        if (v) this.store.updateView(v.key, { [field]: this.value(event).split(/\s+/).filter(Boolean) });
    }
}
