import { computed, Injectable, signal } from '@angular/core';
import { directoryPicker, ensureWritable, listFiles, loadFolder, readText, saveFolder, writeText } from './folder-access';

/** A place in the analysed code base. */
export interface CodeLocation {
    file: string;
    line: number;
}

export interface CodeFinding {
    rule: string;
    category: 'state-machine' | 'lifecycle' | 'pattern' | 'paradigm' | 'architecture';
    severity: 'error' | 'warning' | 'info';
    subject: string;
    message: string;
    fix: string;
    loc?: CodeLocation;
    model?: string;
    spec?: string;
    counterexample?: Array<{ state: string; event?: string; loc?: CodeLocation }>;
    source: 'analysis' | 'nuxmv' | 'graph' | 'llm';
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
    patterns: Array<{ pattern: string; subject: string; loc: CodeLocation; evidence: string; model?: string }>;
    paradigm: Array<{ part: string; declared?: string; detected: string; files: number; classes: number; methods: number; freeFunctions: number; pureFunctions: number; mutationDensity: number; mutableGlobals: number }>;
    architecture: { edges: Array<{ from: string; to: string; count: number; typeOnly: boolean }> };
    notes: string[];
    markdown: string;
}

/** What the analysis reads: sources, Angular templates, and the files that describe the project. */
const WANTED = /(\.(ts|tsx|mts|cts|py|html|java|kts?|groovy|gradle|scala|sc|c|h|cpp|cc|cxx|hpp|hh|hxx|cs|go|rs|swift|rb|php|R|r)|(^|\/)(package\.json|provenflow\.config\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|DESCRIPTION|composer\.json|Gemfile))$/;
const SKIPPED_DIR = /(^|\/)(node_modules|\.git|dist|out|build|\.angular|\.venv|venv|__pycache__|\.provenflow|coverage|target|bin|obj|vendor|\.gradle|\.idea|renv|Pods|DerivedData)\//;
const MAX_FILES = 5000;
/** The last report is kept in the browser, so its models stay one click away after a reload. */
const REPORT_KEY = 'provenflow.code-report';
const MAX_FILE_BYTES = 1_000_000;

/** Sends a code base to the server (`pflow extract`) and keeps its report. */
@Injectable({ providedIn: 'root' })
export class CodeImport {
    readonly running = signal(false);
    readonly progress = signal('');
    readonly error = signal<string | null>(null);
    readonly report = signal<CodeReport | null>(loadReport());
    /** The server can read a folder by path (it runs on this machine). */
    readonly pathsAllowed = signal(false);
    /** LLM providers configured on the server (their keys stay there). */
    readonly llmProviders = signal<LlmProviders>({ anthropic: false, openai: false, ollama: false });
    /** Propose deterministic quick fixes, each verified by re-running the checks. */
    readonly quickFixes = signal(true);
    /** `anthropic:<model>`, `openai:<model>`, `ollama:<model>`, or '' for no LLM. */
    readonly llm = signal('');
    readonly llmFixes = signal(5);
    /** Files written in this session. */
    readonly applied = signal<ReadonlySet<string>>(new Set());
    /** Changes applied in this session (see changeKey). */
    readonly appliedChanges = signal<ReadonlySet<string>>(new Set());
    /** Folder opened with write access in the browser (Chrome/Edge). */
    private folder: FileSystemDirectoryHandle | undefined;
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

    analysePath(path: string): Promise<void> {
        return this.run(`Analysing ${path}…`, { path: path.trim(), ...this.fixOptions() });
    }

    private fixOptions(): Record<string, unknown> {
        return { quickFixes: this.quickFixes() ? 20 : 0, ...(this.llm().trim() ? { llm: this.llm().trim(), llmFixes: this.llmFixes() } : {}) };
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

    /** Analyses the report's folder again, after changes were applied. */
    async reanalyse(): Promise<void> {
        const r = this.report();
        if (!r) return;
        if (r.applicable) return this.analysePath(r.root);
        if (r.browserFolder) {
            try {
                await this.analyseDirectory(await this.writableFolder());
            } catch (error) {
                this.error.set((error as Error).message);
            }
        }
    }

    private async analyseDirectory(dir: FileSystemDirectoryHandle): Promise<void> {
        const entries = await listFiles(dir, SKIPPED_DIR);
        const picked: Record<string, string> = {};
        let skipped = 0;
        for (const { path, file } of entries) {
            if (!WANTED.test(path) || path.endsWith('.d.ts')) continue;
            if (file.size > MAX_FILE_BYTES || Object.keys(picked).length >= MAX_FILES) {
                skipped++;
                continue;
            }
            picked[path] = await file.text();
        }
        if (Object.keys(picked).length === 0) {
            this.error.set('No source files of a supported language in that folder (TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, Ruby, PHP, R).');
            return;
        }
        this.folder = dir;
        void saveFolder(dir);
        await this.run(`Analysing ${Object.keys(picked).length} files of ${dir.name}${skipped ? ` (${skipped} skipped: too large or too many)` : ''}…`, { files: picked, ...this.fixOptions() }, dir.name, true);
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
        const picked: Record<string, string> = {};
        let skipped = 0;
        for (const file of files) {
            // "project/src/a.ts" -> "src/a.ts": paths are relative to the chosen folder.
            const path = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
            if (SKIPPED_DIR.test(`/${path}`) || !WANTED.test(path) || path.endsWith('.d.ts')) continue;
            if (file.size > MAX_FILE_BYTES || Object.keys(picked).length >= MAX_FILES) {
                skipped++;
                continue;
            }
            picked[path] = await file.text();
        }
        const count = Object.keys(picked).length;
        if (count === 0) {
            this.error.set('No source files of a supported language in that folder (TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, Ruby, PHP, R).');
            return;
        }
        const folder = files[0].webkitRelativePath.split('/')[0] || 'folder';
        return this.run(`Uploading and analysing ${count} files of ${folder}${skipped ? ` (${skipped} skipped: too large or too many)` : ''}…`, { files: picked, ...this.fixOptions() }, folder);
    }

    private async run(progress: string, body: unknown, name?: string, browserFolder = false): Promise<void> {
        this.running.set(true);
        this.error.set(null);
        this.progress.set(progress);
        try {
            const res = await fetch('api/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            const json = (await res.json()) as CodeReport & { error?: string };
            if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
            const report = name ? { ...json, root: name, browserFolder } : json;
            this.report.set(report);
            this.applied.set(new Set());
            this.appliedChanges.set(new Set());
            saveReport(report);
        } catch (error) {
            this.error.set(`The analysis failed: ${(error as Error).message}`);
        } finally {
            this.running.set(false);
            this.progress.set('');
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

/** Identifies a proposed change within a report. */
export function changeKey(f: CodeFinding): string {
    return `${f.rule}|${f.subject}|${f.loc?.file ?? ''}:${f.loc?.line ?? 0}`;
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
