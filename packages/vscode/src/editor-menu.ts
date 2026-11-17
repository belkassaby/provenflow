/**
 * The ProvenFlow menu: the editor's own menus (File, Examples, Attributes, nuXmv, Help), which the
 * editor does not show in an IDE tab. Each item is a command (`provenflow.editor.<id>`) in the
 * ProvenFlow submenu of the editor tab's title bar and of the sidebar, and in the Command Palette.
 * package.json lists the same items (a test keeps them in step). No `vscode` import here.
 */

/**
 * Where an item acts: the ProvenFlow tab in front (`tab`), a new tab (`new`), the code base report's
 * tab (`report`), or the extension itself (`open`: VS Code's file dialog; `c4`; `example`: a list).
 */
export type MenuTarget = 'tab' | 'new' | 'report' | 'open' | 'c4' | 'example';

export interface MenuItem {
    /** The command is provenflow.editor.<id>. */
    id: string;
    title: string;
    submenu: 'file' | 'examples' | 'attributes' | 'nuxmv' | 'help';
    /** The editor's command (see packages/app/src/app/host-commands.ts). */
    command: string;
    target: MenuTarget;
}

export const SUBMENUS = { file: 'File', examples: 'Examples', attributes: 'Attributes', nuxmv: 'nuXmv', help: 'Help' } as const;

const item = (id: string, title: string, submenu: MenuItem['submenu'], command: string, target: MenuTarget = 'tab'): MenuItem => ({ id, title, submenu, command, target });

export const EDITOR_MENU: MenuItem[] = [
    item('newDiagram', 'New Diagram', 'file', 'new-diagram', 'new'),
    item('open', 'Open .pflow…', 'file', 'open', 'open'),
    item('importAgentGraph', 'Import Agent Graph…', 'file', 'import-agent-graph', 'new'),
    item('importCodeBase', 'Import Code Base…', 'file', 'import-code', 'report'),
    item('codeReport', 'Code Base Report', 'file', 'code-report', 'report'),
    item('c4', 'C4 Architecture', 'file', 'c4', 'c4'),
    item('save', 'Save .pflow', 'file', 'save'),
    item('exportSmv', 'Export nuXmv Model (.smv)', 'file', 'export-smv'),
    item('exportPng', 'Export Diagram (.png)', 'file', 'export-png'),
    item('exportSvg', 'Export Diagram (.svg)', 'file', 'export-svg'),
    item('exportPython', 'Export Python Implementation (.py)', 'file', 'export-python'),
    item('exportNotebook', 'Export Jupyter Notebook (.ipynb)', 'file', 'export-notebook'),
    item('example', 'Open Example…', 'examples', 'example', 'example'),
    item('attributes', 'Edit Attribute Table', 'attributes', 'attributes'),
    item('showModel', 'Show Generated Model', 'nuxmv', 'show-model'),
    item('check', 'Check Properties', 'nuxmv', 'check'),
    item('simulate', 'Simulate the Diagram', 'nuxmv', 'simulate'),
    item('showConsole', 'Show nuXmv Output', 'nuxmv', 'show-console'),
    item('redetectNuxmv', 'Re-detect nuXmv', 'nuxmv', 'redetect-nuxmv'),
    item('helpGuide', 'Using the Editor', 'help', 'help:guide'),
    item('helpWalkthroughs', 'Walkthroughs', 'help', 'help:walkthroughs'),
    item('helpSymbols', 'Logic Symbols', 'help', 'help:symbols'),
    item('helpGlossary', 'Glossary of Logic Terms', 'help', 'help:glossary'),
    item('helpReferences', 'References', 'help', 'help:references'),
    item('llmSettings', 'LLM Settings (API Keys)…', 'help', 'llm-settings')
];

export const commandOf = (i: MenuItem) => `provenflow.editor.${i.id}`;

/** An example, as the editor lists them when it is ready. */
export interface EditorExample {
    id: string;
    title: string;
    group: string;
    description: string;
}
