import { Injectable, signal } from '@angular/core';

export type LlmKind = 'anthropic' | 'openai' | 'ollama';

/** The server's LLM settings as it shows them: keys masked, never in clear. */
export interface LlmSettingsView {
    anthropic: { key?: string; keyFrom?: 'settings' | 'environment'; model: string; baseUrl?: string; workspaceId?: string };
    openai: { key?: string; keyFrom?: 'settings' | 'environment'; model: string; baseUrl?: string };
    ollama: { host: string; model: string };
    preferred?: LlmKind;
    remember: boolean;
    file: string;
    configured: Record<LlmKind, boolean>;
    editable: boolean;
}

export interface LlmSettingsUpdate {
    anthropic?: { apiKey?: string; clearKey?: boolean; model?: string; baseUrl?: string; workspaceId?: string };
    openai?: { apiKey?: string; clearKey?: boolean; model?: string; baseUrl?: string };
    ollama?: { host?: string; model?: string };
    preferred?: LlmKind | '';
    remember?: boolean;
}

/** Reads and changes the LLM settings kept by the ProvenFlow server (keys stay there). */
@Injectable({ providedIn: 'root' })
export class LlmSettings {
    readonly settings = signal<LlmSettingsView | null>(null);
    readonly error = signal<string | null>(null);

    async load(): Promise<void> {
        try {
            const res = await fetch('api/llm-settings');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.settings.set((await res.json()) as LlmSettingsView);
            this.error.set(null);
        } catch (error) {
            this.error.set(`The server did not answer: ${(error as Error).message}`);
        }
    }

    async save(update: LlmSettingsUpdate): Promise<boolean> {
        try {
            const res = await fetch('api/llm-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) });
            const json = (await res.json()) as LlmSettingsView & { error?: string };
            if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
            this.settings.set(json);
            this.error.set(null);
            return true;
        } catch (error) {
            this.error.set((error as Error).message);
            return false;
        }
    }

    async test(provider: LlmKind): Promise<{ ok: boolean; text: string }> {
        try {
            const res = await fetch('api/llm-settings/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }) });
            const json = (await res.json()) as { ok?: boolean; spec?: string; answer?: string; ms?: number; error?: string };
            const error = json.error ?? '';
            return json.ok ? { ok: true, text: `${json.spec} answered "${json.answer}" in ${json.ms} ms.` } : { ok: false, text: error.startsWith(json.spec ?? '\0') ? error : `${json.spec ?? provider}: ${error}` };
        } catch (error) {
            return { ok: false, text: (error as Error).message };
        }
    }

    /** `provider:model` choices for Import code base, the preferred one first. */
    choices(): Array<{ spec: string; label: string }> {
        const s = this.settings();
        if (!s) return [];
        const all: Array<{ kind: LlmKind; spec: string; label: string }> = [
            { kind: 'anthropic', spec: `anthropic:${s.anthropic.model}`, label: `Anthropic (${s.anthropic.model})` },
            { kind: 'openai', spec: `openai:${s.openai.model}`, label: `OpenAI-compatible (${s.openai.model})` },
            { kind: 'ollama', spec: `ollama:${s.ollama.model}`, label: `Ollama, local (${s.ollama.model})` }
        ];
        return all.filter(c => s.configured[c.kind]).sort((a, b) => Number(b.kind === s.preferred) - Number(a.kind === s.preferred));
    }
}
