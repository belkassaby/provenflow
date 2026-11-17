/** A sidebar view of ProvenFlow: shows the nodes it is given (sidebar.ts, trends.ts) as VS Code tree items. */
import * as vscode from 'vscode';
import type { TreeNode } from './sidebar';

/** Opens a place of a finding, a step or a hotspot; opens a model in the editor. */
export const REVEAL = 'provenflow.reveal';
export const OPEN_MODEL_IN_EDITOR = 'provenflow.openModelInEditor';

const TONES: Record<NonNullable<TreeNode['tone']>, string> = {
    error: 'problemsErrorIcon.foreground',
    warning: 'problemsWarningIcon.foreground',
    info: 'problemsInfoIcon.foreground',
    ok: 'testing.iconPassed'
};

export class NodeTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private nodes: TreeNode[] = [];
    /** The folder the nodes' places are in. */
    private folder?: vscode.Uri;

    /** Replaces what the view shows. Empty: the view's welcome text shows instead. */
    show(nodes: TreeNode[], folder?: vscode.Uri): void {
        this.nodes = nodes;
        this.folder = folder;
        this.changed.fire();
    }

    get count(): number {
        return this.nodes.length;
    }

    getChildren(node?: TreeNode): TreeNode[] {
        return node ? (node.children ?? []) : this.nodes;
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        const state = node.children?.length ? (node.id.startsWith('category:') ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(node.label, state);
        item.id = node.id;
        item.description = node.description;
        item.tooltip = node.tooltip;
        item.contextValue = node.context;
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon, node.tone ? new vscode.ThemeColor(TONES[node.tone]) : undefined);
        item.command = this.commandOf(node);
        return item;
    }

    dispose(): void {
        this.changed.dispose();
    }

    private commandOf(node: TreeNode): vscode.Command | undefined {
        if (node.place && this.folder) return { command: REVEAL, title: 'Open', arguments: [this.folder, node.place] };
        if (node.model && this.folder) return { command: OPEN_MODEL_IN_EDITOR, title: 'Open in the ProvenFlow editor', arguments: [this.folder, node.model] };
        return undefined;
    }
}

/** Opens a file of a folder at a line (1-based). */
export async function reveal(folder: vscode.Uri, place: { file: string; line: number }): Promise<void> {
    const line = Math.max(0, place.line - 1);
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder, place.file), { selection: new vscode.Range(line, 0, line, 0), preview: true });
}
