import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { C4_ROUTING_LABELS, C4_ROUTINGS, C4_TYPE_LABELS, C4_VIEW_LABELS, type C4ElementType } from '@provenflow/language';
import { downloadText, pickFile } from '../file-io';
import { CodeImport } from '../code-import/code-import';
import { FolderBrowse } from '../desktop-bridge';
import { C4Canvas } from './c4-canvas';
import { C4Discovery } from './c4-discovery';
import { C4Projects, C4Suggestions } from './c4-insights';
import { C4Properties } from './c4-properties';
import { C4Store, type C4ExportFormat } from './c4-store';

type Tab = 'map' | 'properties' | 'suggestions' | 'projects' | 'dsl';
type ExportKind = C4ExportFormat | 'svg' | 'png';

const EXTENSIONS: Record<C4ExportFormat, string> = { dsl: 'dsl', json: 'c4.json', plantuml: 'puml', mermaid: 'mmd' };

/**
 * File → C4 architecture…, in its own tab: a C4 model (Structurizr DSL) to view, edit and export;
 * and the map of the projects around a code base (same owner), with where code belongs.
 */
@Component({
    selector: 'app-c4-page',
    imports: [C4Canvas, C4Properties, C4Suggestions, C4Projects, FolderBrowse],
    templateUrl: './c4-page.html',
    host: { class: 'page' }
})
export class C4Page {
    readonly store = inject(C4Store);
    readonly discovery = inject(C4Discovery);
    readonly codeImport = inject(CodeImport);
    readonly typeLabels = C4_TYPE_LABELS;
    readonly viewLabels = C4_VIEW_LABELS;
    readonly routings = C4_ROUTINGS;
    readonly routingLabels = C4_ROUTING_LABELS;
    readonly canvas = viewChild(C4Canvas);
    readonly tab = signal<Tab>(this.store.workspace().elements.length ? 'properties' : 'map');
    readonly menu = signal<'none' | 'add' | 'export'>('none');
    readonly connect = signal(false);
    readonly path = signal(this.discovery.map()?.root ?? this.discovery.recent()[0] ?? this.codeImport.recentPaths()[0] ?? '');
    readonly scan = signal('');
    readonly owners = signal('');
    readonly dsl = signal('');
    readonly message = signal<string | null>(null);
    readonly saveFile = signal('docs/c4/workspace.dsl');
    /** What the Add menu offers: what the view can show (people and systems when there is no view yet). */
    readonly addTypes = computed<C4ElementType[]>(() => (this.store.workspace().views.length ? this.store.addable() : ['person', 'softwareSystem']));
    readonly errors = computed(() => this.store.diagnostics().filter(d => d.severity === 'error').length);

    constructor() {
        void this.codeImport.refresh();
    }

    /** Maps the projects around a folder (from the code base report). */
    mapFolder(folder: string): void {
        this.path.set(folder);
        void this.discover();
    }

    /** A workspace opened with the desktop application (File → Open…, the file manager). */
    openText(text: string, name: string): void {
        this.flash(this.store.open(text, name) ? `Opened ${name}.` : `${name} could not be read: see the DSL tab.`);
        this.tab.set(this.errors() ? 'dsl' : 'properties');
    }

    toggleMenu(name: 'add' | 'export'): void {
        if (this.menu() === name) this.menu.set('none');
        else this.menu.set(name);
    }

    keydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') this.menu.set('none');
        const editing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement).tagName);
        if (editing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
        event.preventDefault();
        if (event.shiftKey) this.store.redo();
        else this.store.undo();
    }

    async discover(): Promise<void> {
        const split = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
        const ok = await this.discovery.discover(this.path(), split(this.scan()), split(this.owners()));
        if (ok) this.tab.set('suggestions');
    }

    async openFile(): Promise<void> {
        const file = await pickFile('.dsl,.json,.txt');
        if (!file) return;
        this.flash(this.store.open(file.text, file.name) ? `Opened ${file.name}.` : `${file.name} could not be read: see Problems.`);
        this.tab.set(this.errors() ? 'dsl' : 'properties');
        this.refreshDsl();
    }

    add(type: C4ElementType): void {
        this.menu.set('none');
        this.store.addElement(type, this.canvas()?.centre());
        this.tab.set('properties');
    }

    exportAs(kind: ExportKind): void {
        this.menu.set('none');
        const base = `${this.store.fileName().replace(/\.(dsl|json)$/, '')}${kind === 'dsl' || kind === 'json' ? '' : `-${this.store.view()?.key ?? 'view'}`}`;
        if (kind === 'svg') this.canvas()?.exportSvg(base);
        else if (kind === 'png') this.canvas()?.exportPng(base);
        else downloadText(`${base}.${EXTENSIONS[kind]}`, this.store.exportText(kind), kind === 'json' ? 'application/json' : 'text/plain');
    }

    refreshDsl(): void {
        this.dsl.set(this.store.exportText('dsl'));
    }

    showDsl(): void {
        this.refreshDsl();
        this.tab.set('dsl');
    }

    /** Replaces the model with the DSL as edited (kept as it is when it has errors). */
    applyDsl(): void {
        const ok = this.store.open(this.dsl(), this.store.fileName());
        this.flash(ok && !this.errors() ? 'Applied.' : `${this.errors()} error(s): see below.`);
    }

    async save(): Promise<void> {
        const error = await this.discovery.save(this.saveFile());
        this.flash(error ?? `Saved ${this.saveFile()} in ${this.discovery.map()?.root}.`);
    }

    /** A short message in the toolbar (also why a relationship's end could not move). */
    flash(text: string): void {
        this.message.set(text);
        setTimeout(() => this.message() === text && this.message.set(null), 4000);
    }
}
