import { computed, inject, Injectable, signal } from '@angular/core';
import type { C4Workspace } from '@provenflow/language';
import { C4Store } from './c4-store';

/** A project found around the code base (see `pflow c4`). */
export interface MappedProject {
    id: string;
    name: string;
    path: string;
    dir: string;
    ecosystem: string;
    version?: string;
    description?: string;
    remote?: string;
    owned: boolean;
    focus: boolean;
    application: boolean;
    technology: string;
    modules: Array<{ name: string; dir: string; kind: string }>;
}

export interface MappedLink {
    from: string;
    to: string;
    fromModule?: string;
    toModule?: string;
    dependency: { name: string; range?: string; kind: string };
    version?: string;
    satisfied?: boolean;
}

export interface PlacementSuggestion {
    kind: string;
    severity: 'error' | 'warning' | 'info';
    confidence: 'high' | 'medium' | 'low';
    title: string;
    detail: string;
    project: string;
    target?: string;
    files: Array<{ project: string; file: string; line?: number; lines?: number }>;
    practice?: string;
}

export interface ProjectMap {
    root: string;
    focus: string;
    projects: MappedProject[];
    links: MappedLink[];
    libraries: Array<{ name: string; users: Array<{ project: string; range?: string }> }>;
    suggestions: PlacementSuggestion[];
    workspace: C4Workspace;
    existing?: { file: string; text: string; merged?: C4Workspace };
    notes: string[];
}

export const SUGGESTION_LABELS: Record<string, string> = {
    'move-to-dependency': 'Could move to a dependency',
    'move-to-consumer': 'Used by one consumer only',
    'duplicate-across-projects': 'Duplicated across projects',
    'unused-dependency': 'Declared, never imported',
    'undeclared-dependency': 'Imported, not declared',
    'cyclic-dependency': 'Projects in a cycle',
    'outdated-dependency': 'Behind the local version',
    'version-drift': 'Library at clashing versions'
};

const RECENT_KEY = 'provenflow.c4-folders';

/** Maps the projects around a folder on the server (POST api/c4/discover) and writes models back into it. */
@Injectable({ providedIn: 'root' })
export class C4Discovery {
    private readonly store = inject(C4Store);
    readonly running = signal(false);
    readonly error = signal<string | null>(null);
    readonly map = signal<ProjectMap | null>(null);
    readonly recent = signal<string[]>(loadRecent());
    readonly byId = computed(() => new Map((this.map()?.projects ?? []).map(p => [p.id, p])));

    async discover(path: string, scan: string[], owners: string[]): Promise<boolean> {
        this.running.set(true);
        this.error.set(null);
        try {
            const res = await fetch('api/c4/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.trim(), ...(scan.length ? { scan } : {}), ...(owners.length ? { owners } : {}) }) });
            const body = (await res.json()) as ProjectMap & { error?: string };
            if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
            this.map.set(body);
            this.store.replace(body.workspace, `${body.projects.find(p => p.focus)?.name.replace(/^@[^/]+\//, '') ?? 'projects'}.dsl`);
            this.remember(path.trim());
            return true;
        } catch (error) {
            this.error.set((error as Error).message);
            return false;
        } finally {
            this.running.set(false);
        }
    }

    /** Opens the code base's own model with the discovered projects merged in. */
    openMerged(): void {
        const existing = this.map()?.existing;
        if (existing?.merged) this.store.replace(existing.merged, existing.file.split('/').pop() ?? 'workspace.dsl');
    }

    openDiscovered(): void {
        const map = this.map();
        if (map) this.store.replace(map.workspace, this.store.fileName());
    }

    /** Writes the workspace as DSL into the analysed folder (the server only writes there). */
    async save(file: string): Promise<string | null> {
        const root = this.map()?.root;
        if (!root) return 'Map a folder first: the model is saved into it.';
        try {
            const res = await fetch('api/c4/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root, file, text: this.store.exportText(file.endsWith('.json') ? 'json' : 'dsl') }) });
            const body = (await res.json()) as { error?: string };
            if (!res.ok) return body.error ?? `HTTP ${res.status}`;
            this.store.markSaved(file.split('/').pop());
            return null;
        } catch (error) {
            return (error as Error).message;
        }
    }

    /** The diagram elements a suggestion is about: its projects. */
    elementsOf(s: PlacementSuggestion): Set<string> {
        return new Set([s.project, ...(s.target ? [s.target] : []), ...s.files.map(f => f.project)]);
    }

    private remember(path: string): void {
        const next = [path, ...this.recent().filter(p => p !== path)].slice(0, 8);
        this.recent.set(next);
        try {
            localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch {
            // Storage unavailable: the list lasts for this page only.
        }
    }
}

function loadRecent(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}
