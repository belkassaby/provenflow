/**
 * The ProvenFlow menu's commands (editor-menu.ts), and what the extension does for the editor tabs:
 * it writes the files they save or export, shows their messages, and keeps the examples they list.
 */
import * as vscode from 'vscode';
import { commandDocument, EMPTY_EDITOR, savePlan } from './editor-documents';
import { commandOf, EDITOR_MENU, type EditorExample, type MenuItem } from './editor-menu';
import type { EditorDocument, EditorHost, EditorPanels, SavedFile } from './editor-panels';

/** What the menu needs from the rest of the extension. */
export interface MenuContext {
    /** The folder ProvenFlow works on (the sidebar's, else the first of the workspace). */
    folder(): vscode.Uri | undefined;
    openC4(): Promise<void>;
    /** Opens a .pflow diagram or C4 workspace in an editor tab. */
    openFile(uri: vscode.Uri): Promise<void>;
}

/** How long the first editor tab may take to list its examples. */
const EDITOR_START_MS = 30_000;

export class EditorMenu implements EditorHost, vscode.Disposable {
    private editors?: EditorPanels;
    private examples: EditorExample[] = [];
    private examplesKnown?: () => void;
    private readonly commands: vscode.Disposable[];
    /** New diagrams opened so far, for their tabs' names. */
    private created = 0;

    constructor(private readonly context: MenuContext) {
        this.commands = EDITOR_MENU.map(item => vscode.commands.registerCommand(commandOf(item), () => this.run(item)));
    }

    /** The editor tabs the menu acts on (made after the menu, which they report to). */
    attach(editors: EditorPanels): void {
        this.editors = editors;
    }

    ready(examples: EditorExample[]): void {
        if (examples.length) this.examples = examples;
        this.examplesKnown?.();
    }

    /** Writes a saved or exported file: over the tab's file when it saves that file, else where the user says. */
    async save(document: EditorDocument, file: SavedFile): Promise<void> {
        const folder = this.context.folder()?.fsPath ?? process.cwd();
        const plan = savePlan(document, file.name, folder);
        const target = 'write' in plan ? vscode.Uri.file(plan.write) : await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(plan.ask), saveLabel: 'Save', title: `ProvenFlow: save ${file.name}` });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
        this.notify(`Saved ${vscode.workspace.asRelativePath(target)}`);
    }

    notify(text: string): void {
        vscode.window.setStatusBarMessage(`ProvenFlow: ${text}`, 6000);
    }

    dispose(): void {
        this.commands.forEach(c => c.dispose());
    }

    private async run(item: MenuItem): Promise<void> {
        const editors = this.editors;
        if (!editors) return;
        const command = { provenflow: 'command' as const, command: item.command };
        switch (item.target) {
            case 'tab':
                // The tab in front; with none open, an editor of its own (Help, LLM settings, a new diagram's commands).
                if (!editors.sendToFront(command)) await editors.open({ ...EMPTY_EDITOR, message: command });
                return;
            case 'new':
                this.created++;
                return editors.open(commandDocument(`new:${this.created}`, item.command === 'new-diagram' ? `Untitled ${this.created}.pflow` : 'ProvenFlow', item.command));
            case 'report':
                return editors.open(commandDocument(`report:${this.context.folder()?.fsPath ?? ''}`, 'Code Base Report', item.command));
            case 'c4':
                return this.context.openC4();
            case 'open':
                return this.openFile();
            case 'example':
                return this.openExample(editors);
        }
    }

    private async openFile(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            title: 'Open a diagram or a C4 workspace',
            canSelectMany: false,
            defaultUri: this.context.folder(),
            filters: { 'ProvenFlow diagrams and C4 workspaces': ['pflow', 'nxd', 'dsl', 'json'] }
        });
        if (picked?.[0]) await this.context.openFile(picked[0]);
    }

    /** Lists the editor's examples (an editor tab opens first if none has listed them yet) and opens the one picked. */
    private async openExample(editors: EditorPanels): Promise<void> {
        if (!this.examples.length) {
            const known = new Promise<void>(resolve => {
                this.examplesKnown = resolve;
                setTimeout(resolve, EDITOR_START_MS);
            });
            await editors.open(EMPTY_EDITOR);
            await known;
        }
        if (!this.examples.length) return void vscode.window.showErrorMessage('ProvenFlow: the editor did not list its examples. Is it built (npm run build)?');
        const picked = await vscode.window.showQuickPick(
            this.examples.map(e => ({ label: e.title, description: e.group, detail: e.description, id: e.id })),
            { placeHolder: 'Example to open in the ProvenFlow editor', matchOnDescription: true, matchOnDetail: true }
        );
        if (picked) await editors.open(commandDocument(`example:${picked.id}`, `${picked.label}`, `example:${picked.id}`));
    }
}
