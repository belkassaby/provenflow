import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { LlmSettings, type LlmKind } from './llm-settings';

/**
 * Help → LLM settings: API keys, models and addresses of the LLMs Import code base can ask for
 * fixes. They are sent to the ProvenFlow server on this computer and kept there (never shown again
 * in clear); the environment variables are used when nothing is set here.
 */
@Component({
    selector: 'app-llm-settings-dialog',
    templateUrl: './llm-settings-dialog.html'
})
export class LlmSettingsDialog {
    readonly llm = inject(LlmSettings);
    private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
    /** Keys typed in this session (sent on save, then cleared). */
    readonly keys = signal<Record<'anthropic' | 'openai', string>>({ anthropic: '', openai: '' });
    readonly tests = signal<Partial<Record<LlmKind, { ok: boolean; text: string } | 'running'>>>({});
    readonly saved = signal(false);

    async open(): Promise<void> {
        this.keys.set({ anthropic: '', openai: '' });
        this.tests.set({});
        this.saved.set(false);
        await this.llm.load();
        const dialog = this.dialog().nativeElement;
        if (!dialog.open) dialog.showModal();
    }

    close(): void {
        this.dialog().nativeElement.close();
    }

    backdropClick(event: MouseEvent): void {
        if (event.target === this.dialog().nativeElement) this.close();
    }

    setKey(kind: 'anthropic' | 'openai', value: string): void {
        this.keys.update(k => ({ ...k, [kind]: value }));
    }

    async save(form: HTMLFormElement): Promise<void> {
        const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
        const checked = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.checked ?? false;
        const ok = await this.llm.save({
            anthropic: { apiKey: this.keys().anthropic || undefined, model: value('anthropicModel'), baseUrl: value('anthropicBaseUrl') },
            openai: { apiKey: this.keys().openai || undefined, model: value('openaiModel'), baseUrl: value('openaiBaseUrl') },
            ollama: { host: value('ollamaHost'), model: value('ollamaModel') },
            preferred: value('preferred') as LlmKind | '',
            remember: checked('remember')
        });
        if (ok) {
            this.keys.set({ anthropic: '', openai: '' });
            this.saved.set(true);
        }
    }

    async clearKey(kind: 'anthropic' | 'openai'): Promise<void> {
        await this.llm.save({ [kind]: { clearKey: true } });
    }

    async test(kind: LlmKind, form: HTMLFormElement): Promise<void> {
        // Test what is on screen: save first (the key goes to the server, not back).
        await this.save(form);
        this.tests.update(t => ({ ...t, [kind]: 'running' }));
        const result = await this.llm.test(kind);
        this.tests.update(t => ({ ...t, [kind]: result }));
    }

    testResult(kind: LlmKind): { ok: boolean; text: string } | undefined {
        const t = this.tests()[kind];
        return t && t !== 'running' ? t : undefined;
    }
}
