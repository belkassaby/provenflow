import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { CodeChange, type LlmUsage } from './code-change';

/**
 * What the server is doing for one change, live: the step, the LLM's thinking and answer as they
 * are written, and the tokens used. After an LLM fix, the same for the change as it was made.
 */
@Component({
    selector: 'app-change-activity',
    template: `
        @if (live(); as a) {
            <div class="change-activity">
                <p class="small">
                    @if (running()) { <span class="spinner" aria-hidden="true"></span> }
                    {{ a.stage }} <span class="muted mono">{{ seconds() }} s</span>
                    @if (a.usage; as u) { <span class="mono muted"> · {{ tokens(u) }}</span> }
                    @else if (a.thinking || a.answer) { <span class="mono muted"> · ~{{ approx(a.thinking.length + a.answer.length) }} tokens written so far</span> }
                </p>
                @for (n of a.notes; track $index) { <p class="small muted">{{ n }}</p> }
                @if (a.thinking) {
                    <details open>
                        <summary class="small">Thinking</summary>
                        <pre #thinkingBox class="code-output small">{{ a.thinking }}</pre>
                    </details>
                }
                @if (a.answer) {
                    <details>
                        <summary class="small">Answer ({{ a.answer.length }} characters)</summary>
                        <pre class="code-output small">{{ a.answer }}</pre>
                    </details>
                }
            </div>
        } @else if (made(); as m) {
            <div class="change-activity">
                <p class="small muted">{{ by() }}: {{ m.usage ? tokens(m.usage) : 'no token usage reported' }}, {{ (m.ms / 1000).toFixed(1) }} s.</p>
                @if (m.thinking) {
                    <details>
                        <summary class="small">Thinking ({{ m.thinking.length }} characters)</summary>
                        <pre class="code-output small">{{ m.thinking }}</pre>
                    </details>
                }
            </div>
        }
    `
})
export class ChangeActivity {
    private readonly change = inject(CodeChange);
    /** The finding (its change key) this is about. */
    readonly key = input.required<string>();
    /** The LLM record of a change already made (suggestedPatch.llm), shown when nothing runs. */
    readonly made = input<{ usage?: LlmUsage; thinking?: string; ms: number } | undefined>(undefined);
    readonly by = input('LLM');

    readonly live = computed(() => {
        const a = this.change.activity();
        return a && a.key === this.key() && (this.running() || !this.made()) ? a : null;
    });
    readonly running = computed(() => this.change.working()?.key === this.key());
    private readonly now = signal(Date.now());
    readonly seconds = computed(() => Math.max(0, Math.round((this.now() - (this.live()?.started ?? this.now())) / 1000)));
    private readonly thinkingBox = viewChild<ElementRef<HTMLElement>>('thinkingBox');

    constructor() {
        const timer = setInterval(() => {
            if (this.running()) this.now.set(Date.now());
        }, 1000);
        inject(DestroyRef).onDestroy(() => clearInterval(timer));
        // Follow the thinking as it is written.
        effect(() => {
            void this.live()?.thinking;
            const box = this.thinkingBox()?.nativeElement;
            if (box) queueMicrotask(() => (box.scrollTop = box.scrollHeight));
        });
    }

    tokens(u: LlmUsage): string {
        return `${u.input.toLocaleString()} input + ${u.output.toLocaleString()} output tokens${u.thinking ? ` (${u.thinking.toLocaleString()} thinking)` : ''}${u.cacheRead ? `, ${u.cacheRead.toLocaleString()} read from the prompt cache` : ''}`;
    }

    /** About one token per four characters, until the provider gives the count. */
    approx(chars: number): string {
        return Math.round(chars / 4).toLocaleString();
    }
}
