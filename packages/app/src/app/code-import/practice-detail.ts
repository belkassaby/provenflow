import { Component, computed, inject, input } from '@angular/core';
import { CodeDiff } from './code-diff';
import { PracticeCatalogue, type Practice } from './practice-catalogue';

/**
 * One entry of the patterns and practices catalogue, explained in the narrative form of Fowler's
 * "Writing Software Patterns": the solution, the problem, how it works, when to use it and when not
 * to, a small example before and after, what ProvenFlow checks, and the sources.
 */
@Component({
    selector: 'app-practice-detail',
    imports: [CodeDiff],
    template: `
        @let p = practice();
        <div class="practice-detail">
            <p class="practice-summary"><strong>{{ p.summary }}</strong></p>
            <p>{{ p.problem }}</p>
            <p><strong>How it works.</strong> {{ p.solution }}</p>
            <p><strong>{{ p.kind === 'anti-pattern' ? 'When it is reported.' : 'When to use it.' }}</strong> {{ p.use }}</p>
            <p><strong>{{ p.kind === 'anti-pattern' ? 'When it is acceptable.' : 'When not to.' }}</strong> {{ p.avoid }}</p>
            <app-code-diff [before]="p.example.before" [after]="p.example.after" [file]="p.example.file" leftTitle="Before" rightTitle="After" [editable]="false" [compact]="true" />
            <p><strong>What ProvenFlow checks.</strong> {{ p.checks }} <span class="muted small">Rules: @for (r of rules(); track r) { <code>{{ r }}</code> }</span></p>
            @if (p.autoFix) { <p><strong>Automatic fix.</strong> {{ p.autoFix }}</p> }
            <p class="small muted">
              <strong>Sources:</strong>
              @for (s of p.sources; track $index) {
                @if (s.url) { <a [href]="s.url" target="_blank" rel="noopener">{{ s.title }}</a> } @else { <em>{{ s.title }}</em> }, {{ s.where }}{{ $last ? '.' : '; ' }}
              }
              @if (related().length) { Related: {{ related().join(', ') }}. }
            </p>
        </div>
    `
})
export class PracticeDetail {
    readonly practice = input.required<Practice>();
    private readonly catalogue = inject(PracticeCatalogue);
    readonly rules = computed(() => this.practice().rules.map(r => r.replace(/^[\w-]+:/, '')));
    readonly related = computed(() => this.practice().related.map(id => this.catalogue.entry(id)?.name ?? id));
}
