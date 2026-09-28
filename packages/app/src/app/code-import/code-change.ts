import { Injectable, inject, signal } from '@angular/core';
import { changeKey, CodeImport, type CodeFinding } from './code-import';

/** What the server says about one change: the finding with its checked change, or why there is none. */
export interface ChangeOutcome {
    finding?: CodeFinding;
    error?: string;
}

export interface LlmUsage {
    input: number;
    output: number;
    thinking?: number;
    cacheRead?: number;
}

/** What the server is doing for the change being made: the step, and the LLM's thinking and answer as they arrive. */
export interface ChangeActivity {
    key: string;
    stage: string;
    thinking: string;
    answer: string;
    usage?: LlmUsage;
    notes: string[];
    started: number;
}

type ServerEvent = { type: 'stage' | 'thinking' | 'text' | 'note'; text: string } | { type: 'usage'; usage: LlmUsage };

/**
 * One change for one finding, from the review: a fix the LLM writes from the finding's suggested
 * fix (POST /api/fix), or the reviewer's version of the files (POST /api/verify-change). The server
 * verifies either like the automatic fixes; the report is updated with the result.
 */
@Injectable({ providedIn: 'root' })
export class CodeChange {
    private readonly codeImport = inject(CodeImport);
    /** The finding being worked on, and how. */
    readonly working = signal<{ key: string; what: 'fix' | 'quick' | 'verify' } | null>(null);
    /** The live activity of the running request (and of the last one, until the next starts). */
    readonly activity = signal<ChangeActivity | null>(null);

    isWorking(f: CodeFinding, what?: 'fix' | 'quick' | 'verify'): boolean {
        const w = this.working();
        return !!w && w.key === changeKey(f) && (!what || w.what === what);
    }

    /** Asks `llm` (`anthropic:<model>`...) to implement the finding's suggested fix. */
    llmFix(f: CodeFinding, llm: string): Promise<ChangeOutcome> {
        return this.request('fix', f, { llm });
    }

    /** The fix the analysis makes itself: a verified quick fix, or a draft with the suggested fix as a comment. */
    quickFix(f: CodeFinding): Promise<ChangeOutcome> {
        return this.request('quick', f, { how: 'analysis' });
    }

    /** Verifies the reviewer's version: the whole text of each changed file. */
    verify(f: CodeFinding, changed: Array<{ file: string; after: string }>): Promise<ChangeOutcome> {
        return this.request('verify', f, { changed });
    }

    private async request(what: 'fix' | 'quick' | 'verify', f: CodeFinding, extra: Record<string, unknown>): Promise<ChangeOutcome> {
        if (this.working()) return { error: 'Another change is being checked: wait for it to finish.' };
        this.working.set({ key: changeKey(f), what });
        this.activity.set({ key: changeKey(f), stage: 'Sending the folder to the server…', thinking: '', answer: '', notes: [], started: Date.now() });
        try {
            const source = await this.codeImport.folderSource();
            const { suggestedPatch: _patch, ...finding } = f;
            const res = await fetch(what === 'verify' ? 'api/verify-change' : 'api/fix', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
                body: JSON.stringify({ ...source, finding, analyzers: this.codeImport.analyzers(), ...extra })
            });
            const json = await this.read(res);
            if (!res.ok) return { error: json.error ?? `HTTP ${res.status}` };
            if (json.finding?.suggestedPatch) this.codeImport.replaceFinding(f, json.finding);
            return { finding: json.finding?.suggestedPatch ? json.finding : undefined, error: json.error };
        } catch (error) {
            return { error: (error as Error).message };
        } finally {
            this.working.set(null);
        }
    }

    /** The result, after the streamed events (the activity follows them). */
    private async read(res: Response): Promise<{ finding?: CodeFinding; error?: string }> {
        if (!res.ok || !res.body || !/ndjson/.test(res.headers.get('content-type') ?? '')) return (await res.json()) as { finding?: CodeFinding; error?: string };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines.filter(l => l.trim())) {
                const msg = JSON.parse(line) as { event?: ServerEvent; heartbeat?: boolean; result?: { finding?: CodeFinding; error?: string }; error?: string };
                if (msg.error) return { error: msg.error };
                if (msg.result) return msg.result;
                if (msg.event && !msg.heartbeat) this.follow(msg.event);
            }
            if (done) return { error: 'The connection to the server was lost before the change was checked.' };
        }
    }

    private follow(e: ServerEvent): void {
        this.activity.update(a => {
            if (!a) return a;
            if (e.type === 'usage') return { ...a, usage: e.usage };
            if (e.type === 'stage') return { ...a, stage: e.text };
            if (e.type === 'thinking') return { ...a, thinking: a.thinking + e.text };
            if (e.type === 'text') return { ...a, answer: a.answer + e.text };
            return { ...a, notes: [...a.notes, e.text] };
        });
    }
}
