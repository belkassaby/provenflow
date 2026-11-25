/**
 * One change for one finding, through the editor's server (`pflow serve`): the fix the analysis
 * makes itself (or a draft to finish by hand), the fix an LLM writes, and the check of the user's
 * own version (POST /api/fix, POST /api/verify-change; see packages/server/src/routes/analysis.ts).
 * No `vscode` import here: fix-review.ts shows the changes in diff editors.
 */
import type { ReportFinding } from './report';

/** One file of a change: its text when the change was made, and the text the change gives it. */
export interface ChangedFile {
    file: string;
    before: string;
    after: string;
}

/** A change to review: proposed by pflow or an LLM, a draft, or the user's own edit. */
export interface Change {
    finding: ReportFinding;
    title: string;
    verified: boolean;
    /** Why it is (not) verified, or what to do with a draft. */
    note: string;
    files: ChangedFile[];
}

export type FixHow = { kind: 'proposed' } | { kind: 'analysis' } | { kind: 'llm'; spec: string } | { kind: 'manual' } | { kind: 'llm-settings' };

export interface FixChoice {
    label: string;
    detail: string;
    how: FixHow;
}

/** What GET /api/llm-settings says (keys masked; only what the choices need). */
export interface LlmSettingsView {
    anthropic?: { model: string };
    openai?: { model: string };
    ollama?: { model: string; host?: string };
    preferred?: LlmKind;
    configured?: Partial<Record<LlmKind, boolean>>;
}

type LlmKind = 'anthropic' | 'openai' | 'ollama';

const LLM_NAMES: Record<LlmKind, string> = { anthropic: 'Anthropic', openai: 'OpenAI', ollama: 'Ollama (local)' };

/** The analysers' findings: a check of a change needs them to run again (slower). */
const TOOL_SOURCES = new Set(['semgrep', 'codeql', 'infer', 'esbmc', 'cbmc', 'kani', 'sarif']);

/** The LLMs set up on the server (Help → LLM Settings), the preferred one first, as `kind:model`. */
export function llmSpecs(settings: LlmSettingsView | undefined): Array<{ spec: string; name: string }> {
    if (!settings) return [];
    const kinds: LlmKind[] = [...(settings.preferred ? [settings.preferred] : []), 'anthropic', 'openai', 'ollama'];
    return [...new Set(kinds)].flatMap(kind => {
        const model = settings[kind]?.model;
        return model && settings.configured?.[kind] ? [{ spec: `${kind}:${model}`, name: `${LLM_NAMES[kind]} ${model}` }] : [];
    });
}

/** The ways to fix a finding: its proposed change first when it has one, then without and with an LLM, then by hand. */
export function fixChoices(finding: ReportFinding, settings: LlmSettingsView | undefined): FixChoice[] {
    const patch = finding.suggestedPatch;
    const proposed: FixChoice[] = patch?.files?.length
        ? [{ label: patch.verified ? 'Review the verified fix' : 'Review the proposed fix (not verified)', detail: patch.note, how: { kind: 'proposed' } }]
        : [];
    const llms = llmSpecs(settings).map(({ spec, name }) => ({ label: `Fix with ${name}`, detail: 'The LLM implements the suggested fix; the change is then checked like the automatic fixes.', how: { kind: 'llm', spec } }) satisfies FixChoice);
    return [
        ...proposed,
        { label: 'Fix without an LLM', detail: 'The automatic fix where the analysis has one (checked), else the suggested fix as a comment where the code has to change, to finish by hand.', how: { kind: 'analysis' } },
        ...llms,
        { label: 'Edit by hand', detail: `${finding.fix} Change the file in the diff, then Verify and Apply.`, how: { kind: 'manual' } },
        ...(llms.some(l => !l.how.spec.startsWith('ollama:')) ? [] : [{ label: 'Set up an LLM (API keys)…', detail: 'Anthropic or OpenAI keys and models, kept by pflow.', how: { kind: 'llm-settings' } } satisfies FixChoice])
    ];
}

/** The body of POST /api/fix: the analysis's own fix, or an LLM's. */
export function fixRequest(root: string, finding: ReportFinding, how: { kind: 'analysis' } | { kind: 'llm'; spec: string }): Record<string, unknown> {
    return { path: root, finding, analyzers: needsAnalyzers(finding), ...(how.kind === 'llm' ? { llm: how.spec } : { how: 'analysis' }) };
}

/** The body of POST /api/verify-change: the user's version of the files. */
export function verifyRequest(root: string, finding: ReportFinding, files: Array<{ file: string; after: string }>): Record<string, unknown> {
    return { path: root, finding, analyzers: needsAnalyzers(finding), changed: files.map(f => ({ file: f.file, after: f.after })) };
}

function needsAnalyzers(finding: ReportFinding): boolean {
    return TOOL_SOURCES.has(finding.source ?? '');
}

/** The finding and its change, as the server answers them (`error` when there was nothing to check). */
export interface ChangeResult {
    finding?: ReportFinding;
    error?: string;
}

/** One line of the server's NDJSON answer: a stage to show, the result, or why it failed. */
export function changeLine(line: string): { stage?: string; result?: ChangeResult; error?: string } | undefined {
    let value: { event?: { type?: string; text?: string }; result?: ChangeResult; error?: string };
    try {
        value = JSON.parse(line) as typeof value;
    } catch {
        return undefined;
    }
    if (value.result) return { result: value.result };
    if (typeof value.error === 'string') return { error: value.error };
    return value.event?.type === 'stage' && value.event.text ? { stage: value.event.text } : undefined;
}

/** The change a result carries, to review; undefined (with the reason) when there is none. */
export function changeOf(result: ChangeResult, title: string): Change | { error: string } {
    const patch = result.finding?.suggestedPatch;
    const files = (patch?.files ?? []).filter((f): f is ChangedFile => typeof f.before === 'string');
    if (!result.finding || !patch || files.length === 0) return { error: result.error ?? 'No change was proposed.' };
    return { finding: result.finding, title, verified: patch.verified, note: patch.note, files };
}

/** The change a finding already has from the analysis; `read` gives a file's text now. */
export function proposedChange(finding: ReportFinding, read: (file: string) => string | undefined): Change | undefined {
    const patch = finding.suggestedPatch;
    const files = (patch?.files ?? []).flatMap(f => {
        const before = f.before ?? read(f.file);
        return before === undefined ? [] : [{ file: f.file, before, after: f.after }];
    });
    return patch && files.length ? { finding, title: patch.verified ? 'verified fix' : 'proposed fix', verified: patch.verified, note: patch.note, files } : undefined;
}

/** A change to make by hand: the finding's file, unchanged so far. */
export function manualChange(finding: ReportFinding, read: (file: string) => string | undefined): Change | undefined {
    const text = finding.loc && read(finding.loc.file);
    return finding.loc && text !== undefined ? { finding, title: 'your fix', verified: false, note: `Not checked yet. ${finding.fix}`, files: [{ file: finding.loc.file, before: text, after: text }] } : undefined;
}

/**
 * Posts a change request to the editor's server and follows its answer, line by line (`onStage`
 * gets each step). Resolves with the result, or rejects with the server's reason.
 */
export async function postChange(serverUrl: string, path: 'api/fix' | 'api/verify-change', body: Record<string, unknown>, onStage: (text: string) => void, signal?: AbortSignal): Promise<ChangeResult> {
    const response = await fetch(new URL(path, serverUrl), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(body), signal });
    if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(errorOf(text) ?? `pflow serve answered HTTP ${response.status}.`);
    }
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        const outcome = followLines(lines, onStage);
        if (outcome) return outcome;
    }
    return followLines([pending], onStage) ?? Promise.reject(new Error('pflow serve ended its answer without a result.'));
}

function followLines(lines: string[], onStage: (text: string) => void): ChangeResult | undefined {
    for (const line of lines) {
        const parsed = changeLine(line);
        if (parsed?.stage) onStage(parsed.stage);
        if (parsed?.error) throw new Error(parsed.error);
        if (parsed?.result) return parsed.result;
    }
    return undefined;
}

function errorOf(text: string): string | undefined {
    try {
        const value = JSON.parse(text) as { error?: unknown };
        return typeof value.error === 'string' ? value.error : undefined;
    } catch {
        return text.trim() || undefined;
    }
}
