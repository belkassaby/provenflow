import { Injectable, inject, signal } from '@angular/core';
import { changeKey, CodeImport, type CodeFinding } from './code-import';

/** What the server says about one change: the finding with its checked change, or why there is none. */
export interface ChangeOutcome {
    finding?: CodeFinding;
    error?: string;
}

/**
 * One change for one finding, from the review: a fix the LLM writes from the finding's suggested
 * fix (POST /api/fix), or the reviewer's version of the files (POST /api/verify-change). The server
 * verifies either like the automatic fixes; the report is updated with the result.
 */
@Injectable({ providedIn: 'root' })
export class CodeChange {
    private readonly codeImport = inject(CodeImport);
    /** The finding being worked on, and how. */
    readonly working = signal<{ key: string; what: 'fix' | 'verify' } | null>(null);

    isWorking(f: CodeFinding, what?: 'fix' | 'verify'): boolean {
        const w = this.working();
        return !!w && w.key === changeKey(f) && (!what || w.what === what);
    }

    /** Asks `llm` (`anthropic:<model>`...) to implement the finding's suggested fix. */
    llmFix(f: CodeFinding, llm: string): Promise<ChangeOutcome> {
        return this.request('fix', f, { llm });
    }

    /** Verifies the reviewer's version: the whole text of each changed file. */
    verify(f: CodeFinding, changed: Array<{ file: string; after: string }>): Promise<ChangeOutcome> {
        return this.request('verify', f, { changed });
    }

    private async request(what: 'fix' | 'verify', f: CodeFinding, extra: Record<string, unknown>): Promise<ChangeOutcome> {
        if (this.working()) return { error: 'Another change is being checked: wait for it to finish.' };
        this.working.set({ key: changeKey(f), what });
        try {
            const source = await this.codeImport.folderSource();
            const { suggestedPatch: _patch, ...finding } = f;
            const res = await fetch(what === 'fix' ? 'api/fix' : 'api/verify-change', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...source, finding, analyzers: this.codeImport.analyzers(), ...extra })
            });
            const json = (await res.json()) as { finding?: CodeFinding; error?: string };
            if (!res.ok) return { error: json.error ?? `HTTP ${res.status}` };
            if (json.finding?.suggestedPatch) this.codeImport.replaceFinding(f, json.finding);
            return { finding: json.finding?.suggestedPatch ? json.finding : undefined, error: json.error };
        } catch (error) {
            return { error: (error as Error).message };
        } finally {
            this.working.set(null);
        }
    }
}
