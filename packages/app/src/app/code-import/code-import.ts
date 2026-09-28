import { computed, Injectable, signal } from '@angular/core';
import { isApplied } from './already-applied';
import { directoryPicker, ensureWritable, listFiles, loadFolder, readText, saveFolder, writeText } from './folder-access';

/** A place in the analysed code base. */
export interface CodeLocation {
    file: string;
    line: number;
}

export interface CodeFinding {
    rule: string;
    category: 'state-machine' | 'lifecycle' | 'pattern' | 'paradigm' | 'architecture' | 'security' | 'memory' | 'heap' | 'build';
    severity: 'error' | 'warning' | 'info';
    subject: string;
    message: string;
    fix: string;
    loc?: CodeLocation;
    model?: string;
    spec?: string;
    counterexample?: Array<{ state: string; event?: string; loc?: CodeLocation }>;
    source: 'analysis' | 'nuxmv' | 'graph' | 'llm' | 'semgrep' | 'codeql' | 'infer' | 'esbmc' | 'cbmc' | 'kani' | 'sarif' | 'build';
    /** Whether the problem was reproduced on the real code (counterexample replay, or a model checker on the code). */
    confirmation?: { by: string; status: 'confirmed' | 'refuted' | 'unknown'; detail: string };
    related?: CodeLocation[];
    suggestedPatch?: SuggestedChange;
    states?: string[];
}

/** A proposed code change: every changed file whole, before and after. */
export interface SuggestedChange {
    diff: string;
    files?: Array<{ file: string; before: string; after: string }>;
    verified: boolean;
    note: string;
    by?: string;
    /** The change as exact search/replace edits (to combine it with other changes to the same file). */
    edits?: Array<{ file: string; search: string; replace: string }>;
    /** State values the change adds as cases or removes from a declaration. */
    touches?: { variable: string; adds?: string[]; removes?: string[] };
    /** Models re-extracted from the changed code: before/after .pflow and their false properties. */
    models?: Array<{ id: string; subject: string; before: string; after: string; falseBefore: string[]; falseAfter: string[] }>;
    /** Build, type check and tests run on a copy of the project with the change. */
    checks?: Array<{ name: string; command: string; ok: boolean; output: string; ms: number }>;
}

/** A property of the code itself proved (or refuted) by a model checker of the code (ESBMC, CBMC, Kani). */
export interface CodeProof {
    tool: string;
    subject: string;
    property: string;
    status: 'proved' | 'refuted' | 'unknown';
    bound?: number;
    loc?: CodeLocation;
    detail?: string;
}

export interface LlmProviders {
    anthropic: boolean;
    openai: boolean;
    ollama: boolean;
}

export interface CodeModel {
    id: string;
    kind: 'state-machine' | 'lifecycle' | 'pattern' | 'architecture';
    subject: string;
    loc?: CodeLocation;
    states: number;
    transitions: number;
    properties: number;
    failed: string[];
    notes: string[];
    pflow: string;
}

export interface CodeReport {
    root: string;
    /** The server can write reviewed changes into this folder (analysed by path on a local server). */
    applicable?: boolean;
    /** The folder was opened in the browser with write access: the browser writes the changes. */
    browserFolder?: boolean;
    files: number;
    checkedWith: 'nuxmv' | 'explicit';
    summary: { error: number; warning: number; info: number };
    findings: CodeFinding[];
    models: CodeModel[];
    verdicts: Array<{ model: string; spec: string; verdict: string }>;
    patterns: Array<{ pattern: string; subject: string; loc: CodeLocation; evidence: string; model?: string; confidence?: 'declared' | 'structural' | 'heuristic' }>;
    /** External analysers that ran (Semgrep, Infer, ESBMC/CBMC, Kani, CodeQL). */
    tools?: Array<{ tool: string; version?: string; ms: number; scope: string; ok: boolean }>;
    proofs?: CodeProof[];
    /** Build/test commands run on each proposed change. */
    changeChecks?: string[];
    /** Set for a re-run after changes: the files changed, and what was kept from the last run. */
    incremental?: { changed: string[]; reused: { patches: number; confirmations: number; toolFindings: number } };
    paradigm: Array<{ part: string; declared?: string; detected: string; files: number; classes: number; methods: number; freeFunctions: number; pureFunctions: number; mutationDensity: number; mutableGlobals: number }>;
    architecture: { edges: Array<{ from: string; to: string; count: number; typeOnly: boolean }> };
    notes: string[];
    markdown: string;
}

/** What the analysis reads: sources, Angular templates, and the files that describe the project. */
const WANTED = /(\.(ts|tsx|mts|cts|py|html|java|kts?|groovy|gradle|scala|sc|c|h|cpp|cc|cxx|hpp|hh|hxx|cs|go|rs|swift|rb|php|R|r)|(^|\/)(package\.json|provenflow\.config\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|DESCRIPTION|composer\.json|Gemfile))$/;
const SKIPPED_DIR = /(^|\/)(node_modules|\.git|dist|out|build|\.angular|\.venv|venv|__pycache__|\.provenflow|coverage|target|bin|obj|vendor|\.gradle|\.idea|renv|Pods|DerivedData)\//;
const MAX_FILES = 5000;
/** Where a running analysis is: the current step, and an overall percentage (null while unknown). */
export interface AnalysisProgress {
    phase: string;
    message: string;
    percent: number | null;
}

/** A finished step of the running analysis, with how long it took. */
export interface AnalysisStep {
    phase: string;
    label: string;
    ms: number;
}

const PHASE_LABELS: Record<string, string> = {
    read: 'Read the folder',
    upload: 'Sent the files',
    parse: 'Parsed the sources',
    models: 'Built the models',
    verify: 'Checked the models',
    analyzers: 'Ran the analysers',
    fixes: 'Verified the proposed changes',
    llm: 'LLM patches',
    confirm: 'Confirmed findings on the code'
};

/** The last report is kept in the browser, so its models stay one click away after a reload. */
const REPORT_KEY = 'provenflow.code-report';
/** Folder paths analysed recently, the last one first. */
const PATHS_KEY = 'provenflow.code-paths';
const MAX_PATHS = 8;
const MAX_FILE_BYTES = 1_000_000;

/** Sends a code base to the server (`pflow extract`) and keeps its report. */
@Injectable({ providedIn: 'root' })
export class CodeImport {
    readonly running = signal(false);
    readonly progress = signal<AnalysisProgress>({ phase: '', message: '', percent: null });
    /** Steps of the running analysis already finished. */
    readonly steps = signal<AnalysisStep[]>([]);
    /** When the running analysis started (ms since the epoch). */
    readonly startedAt = signal(0);
    private phaseStarted = 0;
    readonly error = signal<string | null>(null);
    readonly report = signal<CodeReport | null>(loadReport());
    /** Folder paths analysed recently (this browser), the last one first. */
    readonly recentPaths = signal<string[]>(loadPaths());
    /** For a folder analysed before: reuse that run, redoing only what changed since. */
    readonly reuseLastRun = signal(true);
    /** The server can read a folder by path (it runs on this machine). */
    readonly pathsAllowed = signal(false);
    /** LLM providers configured on the server (their keys stay there). */
    readonly llmProviders = signal<LlmProviders>({ anthropic: false, openai: false, ollama: false });
    /** Propose deterministic quick fixes, each verified by re-running the checks. */
    readonly quickFixes = signal(true);
    /** Run the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani) and replay counterexamples on the code. */
    readonly analyzers = signal(true);
    /** `anthropic:<model>`, `openai:<model>`, `ollama:<model>`, or '' for no LLM. */
    readonly llm = signal('');
    readonly llmFixes = signal(5);
    /** Files written in this session. */
    readonly applied = signal<ReadonlySet<string>>(new Set());
    /** Changes applied in this session (see changeKey). */
    readonly appliedChanges = signal<ReadonlySet<string>>(new Set());
    /** Folder opened with write access in the browser (Chrome/Edge). */
    private folder: FileSystemDirectoryHandle | undefined;
    /** The files last uploaded (a read-only copy), to check a single change of that report. */
    private uploaded?: { name: string; files: Record<string, string> };
    readonly canPickWritable = !!directoryPicker();

    /** How reviewed changes can be written for the current report, or why they cannot. */
    readonly writeMode = computed<{ via: 'server' | 'browser' | null; reason?: string }>(() => {
        const r = this.report();
        if (!r) return { via: null };
        if (r.applicable) return { via: 'server' };
        if (r.browserFolder) return { via: 'browser' };
        return {
            via: null,
            reason: this.canPickWritable
                ? 'This folder was uploaded as a copy, so its files cannot be changed from here. Choose it again with "Choose folder…" and allow editing, or analyse it by path; or download the changed files.'
                : 'This browser can only upload a copy of a folder, so its files cannot be changed from here: analyse the folder by path (the server runs on this computer) or download the changed files.'
        };
    });

    async refresh(): Promise<void> {
        try {
            const health = (await (await fetch('api/health')).json()) as { extract?: { paths?: boolean; llm?: LlmProviders } };
            this.pathsAllowed.set(!!health.extract?.paths);
            if (health.extract?.llm) this.llmProviders.set(health.extract.llm);
        } catch {
            this.pathsAllowed.set(false);
        }
    }

    /** `incremental`: redo only what changed since the last run of this folder (when the server still has it). */
    analysePath(path: string, incremental = this.reuseLastRun() && this.recentPaths().includes(path.trim())): Promise<void> {
        const folder = path.trim();
        this.recentPaths.set(savePaths([folder, ...this.recentPaths().filter(p => p !== folder)].slice(0, MAX_PATHS)));
        this.begin();
        return this.run(`Sending ${folder} to the server…`, { path: folder, incremental, ...this.fixOptions() });
    }

    /** Starts the progress of a new analysis. */
    private begin(): void {
        this.running.set(true);
        this.error.set(null);
        this.steps.set([]);
        this.startedAt.set(Date.now());
        this.phaseStarted = Date.now();
        this.progress.set({ phase: '', message: 'Starting…', percent: null });
    }

    /** Moves the progress on; a new phase closes the previous one in the list of steps. */
    private step(next: AnalysisProgress): void {
        const current = this.progress().phase;
        if (current && next.phase !== current) {
            this.steps.update(list => [...list, { phase: current, label: PHASE_LABELS[current] ?? current, ms: Date.now() - this.phaseStarted }]);
            this.phaseStarted = Date.now();
        }
        if (!current) this.phaseStarted = Date.now();
        this.progress.set(next);
    }

    /** Reads the picked files, showing how far it got. */
    private async readFiles<T>(items: T[], pathOf: (item: T) => string | undefined, fileOf: (item: T) => File): Promise<{ picked: Record<string, string>; skipped: number }> {
        const picked: Record<string, string> = {};
        let skipped = 0;
        const wanted = items.filter(i => pathOf(i) !== undefined);
        for (const [i, item] of wanted.entries()) {
            const file = fileOf(item);
            if (file.size > MAX_FILE_BYTES || Object.keys(picked).length >= MAX_FILES) {
                skipped++;
                continue;
            }
            picked[pathOf(item)!] = await file.text();
            if (i % 25 === 0 || i === wanted.length - 1) this.step({ phase: 'read', message: `Reading the source files: ${i + 1}/${wanted.length}…`, percent: Math.round(((i + 1) / wanted.length) * 100) });
        }
        return { picked, skipped };
    }

    private fixOptions(): Record<string, unknown> {
        return { quickFixes: this.quickFixes() ? 20 : 0, analyzers: this.analyzers(), ...(this.llm().trim() ? { llm: this.llm().trim(), llmFixes: this.llmFixes() } : {}) };
    }

    /** Writes a reviewed change into the analysed folder (refused if the file changed since the analysis). */
    async apply(file: string, before: string, after: string): Promise<string | null> {
        const r = this.report();
        const mode = this.writeMode();
        if (!r || !mode.via) return mode.reason ?? 'No analysed folder.';
        try {
            if (mode.via === 'browser') {
                const dir = await this.writableFolder();
                const current = await readText(dir, file);
                if ((current ?? '') !== before) return `${file} changed since the analysis: run the analysis again before applying.`;
                await writeText(dir, file, after);
            } else {
                const res = await fetch('api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: r.root, file, before, after }) });
                const json = (await res.json()) as { error?: string };
                if (!res.ok) return json.error ?? `HTTP ${res.status}`;
            }
            this.applied.update(set => new Set([...set, file]));
            return null;
        } catch (error) {
            return (error as Error).message;
        }
    }

    markApplied(f: CodeFinding): void {
        this.appliedChanges.update(set => new Set([...set, changeKey(f)]));
    }

    /**
     * Applies several changes, each on top of the ones before it (their edits must still match).
     * Removals come first; a change adding a value another change removes is skipped: re-run the
     * analysis to get an updated proposal for it.
     */
    async applyAll(changes: CodeFinding[]): Promise<{ results: Array<{ finding: CodeFinding; status: 'applied' | 'conflict' | 'skipped'; message?: string }>; error?: string }> {
        const r = this.report();
        const mode = this.writeMode();
        if (!r || !mode.via) return { results: [], error: mode.reason };
        const ordered = [...changes].sort((a, b) => Number(!!b.suggestedPatch?.touches?.removes?.length) - Number(!!a.suggestedPatch?.touches?.removes?.length));
        const removed = new Map<string, Set<string>>();
        const plan: CodeFinding[] = [];
        const results: Array<{ finding: CodeFinding; status: 'applied' | 'conflict' | 'skipped'; message?: string }> = [];
        for (const f of ordered) {
            const t = f.suggestedPatch?.touches;
            const clash = t?.adds?.filter(v => removed.get(t.variable)?.has(v));
            if (clash?.length) {
                results.push({ finding: f, status: 'skipped', message: `It adds ${clash.join(', ')}, which another change removes: run the analysis again for an updated proposal.` });
                continue;
            }
            if (t?.removes?.length) removed.set(t.variable, new Set([...(removed.get(t.variable) ?? []), ...t.removes]));
            plan.push(f);
        }
        const withEdits = plan.filter(f => f.suggestedPatch?.edits?.length);
        for (const f of plan.filter(x => !x.suggestedPatch?.edits?.length)) results.push({ finding: f, status: 'skipped', message: 'This change has no edits to combine: review and apply it on its own.' });
        try {
            if (mode.via === 'server') {
                const res = await fetch('api/apply-edits', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ root: r.root, changes: withEdits.map((f, i) => ({ id: String(i), edits: f.suggestedPatch!.edits })) })
                });
                const json = (await res.json()) as { results?: Array<{ id: string; status: 'applied' | 'conflict'; message?: string }>; files?: string[]; error?: string };
                if (!res.ok) return { results, error: json.error ?? `HTTP ${res.status}` };
                for (const x of json.results ?? []) results.push({ finding: withEdits[Number(x.id)], status: x.status, message: x.message });
                for (const x of results) if (x.status === 'applied') this.markApplied(x.finding);
                this.applied.update(set => new Set([...set, ...(json.files ?? [])]));
            } else {
                const dir = await this.writableFolder();
                const texts = new Map<string, string | undefined>();
                const written = new Set<string>();
                for (const f of withEdits) {
                    const pending = new Map<string, string>();
                    let conflict: string | undefined;
                    for (const e of f.suggestedPatch!.edits!) {
                        if (!texts.has(e.file)) texts.set(e.file, await readText(dir, e.file));
                        const text = pending.get(e.file) ?? texts.get(e.file);
                        if (text === undefined && e.search === '') {
                            pending.set(e.file, e.replace);
                            continue;
                        }
                        if (text !== undefined && isApplied(text, e)) {
                            conflict = `This change is already in ${e.file}: it was not applied a second time.`;
                            break;
                        }
                        if (text === undefined || text.split(e.search).length !== 2) {
                            conflict = `${e.file} no longer contains the text this change replaces: run the analysis again for an up-to-date proposal.`;
                            break;
                        }
                        pending.set(e.file, text.replace(e.search, () => e.replace));
                    }
                    if (conflict) {
                        results.push({ finding: f, status: 'conflict', message: conflict });
                        continue;
                    }
                    for (const [file, text] of pending) {
                        texts.set(file, text);
                        written.add(file);
                    }
                    results.push({ finding: f, status: 'applied' });
                }
                for (const file of written) await writeText(dir, file, texts.get(file)!);
                this.applied.update(set => new Set([...set, ...written]));
                for (const x of results) if (x.status === 'applied') this.markApplied(x.finding);
            }
            return { results };
        } catch (error) {
            return { results, error: (error as Error).message };
        }
    }

    /** Opens a folder with write access (Chrome/Edge) and analyses it; the browser writes the changes. */
    async pickWritableFolder(): Promise<boolean> {
        const picker = directoryPicker();
        if (!picker) return false;
        let dir: FileSystemDirectoryHandle;
        try {
            dir = await picker({ mode: 'readwrite', id: 'provenflow-code' });
        } catch {
            return true; // cancelled
        }
        await this.analyseDirectory(dir);
        return true;
    }

    /** Analyses the report's folder again; `incremental`: only what the changes since the last run can affect. */
    async reanalyse(incremental = true): Promise<void> {
        const r = this.report();
        if (!r) return;
        if (r.applicable) return this.analysePath(r.root, incremental);
        if (r.browserFolder) {
            try {
                await this.analyseDirectory(await this.writableFolder(), incremental);
            } catch (error) {
                this.error.set((error as Error).message);
            }
        }
    }

    private async analyseDirectory(dir: FileSystemDirectoryHandle, incremental = false): Promise<void> {
        this.begin();
        this.step({ phase: 'read', message: `Listing the files of ${dir.name}…`, percent: null });
        const entries = await listFiles(dir, SKIPPED_DIR);
        const { picked, skipped } = await this.readFiles(entries, e => (WANTED.test(e.path) && !e.path.endsWith('.d.ts') ? e.path : undefined), e => e.file);
        if (Object.keys(picked).length === 0) {
            this.running.set(false);
            this.error.set('No source files of a supported language in that folder (TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, Ruby, PHP, R).');
            return;
        }
        this.folder = dir;
        void saveFolder(dir);
        this.uploaded = { name: dir.name, files: picked };
        await this.run(uploadMessage(picked, dir.name, skipped), { files: picked, name: dir.name, incremental, ...this.fixOptions() }, dir.name, true);
    }

    /**
     * The report's folder, as the server takes it: its path, or its files (read again from a folder
     * opened in the browser, so they include the changes applied since).
     */
    async folderSource(): Promise<{ path: string } | { files: Record<string, string>; name: string }> {
        const r = this.report();
        if (!r) throw new Error('No analysed folder.');
        if (r.applicable) return { path: r.root };
        if (r.browserFolder) {
            const dir = await this.writableFolder();
            const files: Record<string, string> = {};
            for (const { path, file } of await listFiles(dir, SKIPPED_DIR)) if (WANTED.test(path) && !path.endsWith('.d.ts') && file.size <= MAX_FILE_BYTES) files[path] = await file.text();
            return { files, name: dir.name };
        }
        if (this.uploaded?.name === r.root) return { files: this.uploaded.files, name: r.root };
        throw new Error('The uploaded copy of this folder is not in memory any more (the page was reloaded): choose the folder again.');
    }

    /** Replaces a finding of the report (after a change was proposed or verified for it). */
    replaceFinding(before: CodeFinding, after: CodeFinding): void {
        const r = this.report();
        if (!r) return;
        const key = changeKey(before);
        const next = { ...r, findings: r.findings.map(f => (f === before || changeKey(f) === key ? after : f)) };
        this.report.set(next);
        saveReport(next);
    }

    /** The folder the report came from, with write permission (asked again after a reload). */
    private async writableFolder(): Promise<FileSystemDirectoryHandle> {
        const dir = this.folder ?? (await loadFolder());
        if (!dir || dir.name !== this.report()?.root) throw new Error('The folder this report came from is not open any more: choose it again with "Choose folder…".');
        if (!(await ensureWritable(dir))) throw new Error('Editing the folder was not allowed: allow it when the browser asks, or download the changed files.');
        this.folder = dir;
        return dir;
    }

    /** Uploads the relevant files of a folder picked in the browser (webkitdirectory). */
    async analyseFolder(list: FileList | null): Promise<void> {
        const files = Array.from(list ?? []);
        if (files.length === 0) return;
        this.begin();
        // "project/src/a.ts" -> "src/a.ts": paths are relative to the chosen folder.
        const pathOf = (file: File) => {
            const path = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
            return SKIPPED_DIR.test(`/${path}`) || !WANTED.test(path) || path.endsWith('.d.ts') ? undefined : path;
        };
        const { picked, skipped } = await this.readFiles(files, pathOf, f => f);
        const count = Object.keys(picked).length;
        if (count === 0) {
            this.running.set(false);
            this.error.set('No source files of a supported language in that folder (TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, Ruby, PHP, R).');
            return;
        }
        const folder = files[0].webkitRelativePath.split('/')[0] || 'folder';
        this.uploaded = { name: folder, files: picked };
        return this.run(uploadMessage(picked, folder, skipped), { files: picked, name: folder, ...this.fixOptions() }, folder);
    }

    private async run(message: string, body: unknown, name?: string, browserFolder = false): Promise<void> {
        this.running.set(true);
        this.step({ phase: 'upload', message, percent: null });
        try {
            const json = await this.follow(await fetch('api/extract', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(body) }));
            const report = name ? { ...json, root: name, browserFolder } : json;
            this.report.set(report);
            this.applied.set(new Set());
            this.appliedChanges.set(new Set());
            saveReport(report);
        } catch (error) {
            this.error.set(`The analysis failed: ${(error as Error).message}`);
        } finally {
            this.running.set(false);
            this.progress.set({ phase: '', message: '', percent: null });
        }
    }

    /**
     * The report of a streamed analysis. When the connection drops (a browser or proxy timeout, the
     * computer sleeping), the analysis goes on on the server: follow it again by its id.
     */
    private async follow(first: Response): Promise<CodeReport> {
        const run = { id: undefined as string | undefined };
        let res = first;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.readStream(res, run);
            } catch (error) {
                if (!(error instanceof ConnectionLost) || !run.id || attempt >= 20) throw error;
                this.progress.update(p => ({ ...p, message: `The connection to the server was interrupted; reconnecting to the analysis (it goes on meanwhile)…` }));
                await new Promise(ok => setTimeout(ok, Math.min(10_000, 1000 * 2 ** Math.min(attempt, 3))));
                try {
                    res = await fetch(`api/extract/runs/${run.id}`, { headers: { accept: 'application/x-ndjson' } });
                } catch {
                    res = Response.error();
                }
            }
        }
    }

    /** The report, from a streamed response (progress lines, then the result) or a plain JSON one. */
    private async readStream(res: Response, run: { id?: string }): Promise<CodeReport> {
        if (res.type === 'error') throw new ConnectionLost();
        if (!res.ok || !res.body || !/ndjson/.test(res.headers.get('content-type') ?? '')) {
            const json = (await res.json()) as CodeReport & { error?: string };
            if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
            return json;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch {
                throw new ConnectionLost(); // "Error in input stream", "network error"
            }
            const { value, done } = chunk;
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines.filter(l => l.trim())) {
                const msg = JSON.parse(line) as { run?: string; progress?: AnalysisProgress; result?: CodeReport; error?: string };
                if (msg.run) run.id = msg.run;
                if (msg.error) throw new Error(msg.error);
                if (msg.result) return msg.result;
                if (msg.progress && msg.progress.phase !== 'done') this.step(msg.progress);
            }
            if (done) throw new ConnectionLost();
        }
    }

    /** Back to choosing a folder; the last report stays available until a new analysis replaces it. */
    clear(): void {
        this.report.set(null);
        this.error.set(null);
    }

    /** The last report, when it was cleared to start a new analysis that was then abandoned. */
    restore(): void {
        if (!this.report()) this.report.set(loadReport());
    }
}

/** The stream broke before the analysis ended (the analysis itself may still be running). */
class ConnectionLost extends Error {
    constructor() {
        super('The connection to the server was lost before the analysis finished, and reconnecting failed.');
    }
}

function uploadMessage(picked: Record<string, string>, folder: string, skipped: number): string {
    const bytes = Object.values(picked).reduce((n, t) => n + t.length, 0);
    const size = bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
    return `Sending ${Object.keys(picked).length} files of ${folder} (${size}) to the server${skipped ? `; ${skipped} skipped: too large or too many` : ''}…`;
}

/** Identifies a proposed change within a report. */
export function changeKey(f: CodeFinding): string {
    return `${f.rule}|${f.subject}|${f.loc?.file ?? ''}:${f.loc?.line ?? 0}`;
}

function loadPaths(): string[] {
    try {
        const saved = JSON.parse(localStorage.getItem(PATHS_KEY) ?? '[]') as unknown;
        return Array.isArray(saved) ? saved.filter((p): p is string => typeof p === 'string').slice(0, MAX_PATHS) : [];
    } catch {
        return [];
    }
}

function savePaths(paths: string[]): string[] {
    try {
        localStorage.setItem(PATHS_KEY, JSON.stringify(paths));
    } catch {
        // storage unavailable: remembered for this session only
    }
    return paths;
}

function loadReport(): CodeReport | null {
    try {
        const raw = localStorage.getItem(REPORT_KEY);
        return raw ? (JSON.parse(raw) as CodeReport) : null;
    } catch {
        return null;
    }
}

function saveReport(report: CodeReport): void {
    try {
        localStorage.setItem(REPORT_KEY, JSON.stringify(report));
    } catch {
        // Too large for the browser's storage: the report is kept until the page is reloaded.
    }
}
