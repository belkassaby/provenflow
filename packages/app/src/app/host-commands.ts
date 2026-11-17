import type { HelpSection } from './help-dialog/help-dialog';

/** What the menu commands act on: the editor's own actions (App implements them). */
export interface MenuTarget {
    newDiagram(): void;
    open(): Promise<void>;
    importAgentGraph(): Promise<void>;
    importCodeBase(): void;
    showCodeReport(): void;
    openC4(): void;
    save(): void;
    exportSmv(): void;
    exportPng(): void;
    exportSvg(): void;
    loadExample(id: string): void;
    check(): Promise<void>;
    simulate(): void;
    openHelp(section?: HelpSection): void;
    openLlmSettings(): void;
    readonly codeExport: { downloadPython(): void; downloadNotebook(): void };
    readonly api: { refreshStatus(): Promise<unknown> };
    readonly theme: { toggle(): void };
}

/** Brings a panel of the diagram's bottom area to the front. */
export type ShowPanel = (panel: 'attributes' | 'model' | 'console') => void;

const HELP_SECTIONS: HelpSection[] = ['guide', 'walkthroughs', 'symbols', 'glossary', 'references'];

/**
 * The editor's menus as commands, for the menus of the desktop application and of the IDEs (the
 * editor in an IDE tab shows no menu bar of its own). A command can take an argument after a colon:
 * `example:<id>`, `help:<section>`.
 */
export function menuCommands(app: MenuTarget, showPanel: ShowPanel): Record<string, (arg?: string) => void> {
    return {
        // File
        'new-diagram': () => app.newDiagram(),
        open: () => void app.open(),
        'import-agent-graph': () => void app.importAgentGraph(),
        'import-code': () => app.importCodeBase(),
        'code-report': () => app.showCodeReport(),
        c4: () => app.openC4(),
        save: () => app.save(),
        'export-smv': () => app.exportSmv(),
        'export-png': () => app.exportPng(),
        'export-svg': () => app.exportSvg(),
        'export-python': () => app.codeExport.downloadPython(),
        'export-notebook': () => app.codeExport.downloadNotebook(),
        // Examples
        example: id => id && app.loadExample(id),
        // Attributes
        attributes: () => showPanel('attributes'),
        // nuXmv
        'show-model': () => showPanel('model'),
        check: () => void app.check(),
        simulate: () => app.simulate(),
        'show-console': () => showPanel('console'),
        'redetect-nuxmv': () => void app.api.refreshStatus(),
        // Help
        help: section => app.openHelp(HELP_SECTIONS.find(s => s === section) ?? 'guide'),
        'help-guide': () => app.openHelp('guide'),
        'help-walkthroughs': () => app.openHelp('walkthroughs'),
        'llm-settings': () => app.openLlmSettings(),
        'toggle-theme': () => app.theme.toggle()
    };
}
