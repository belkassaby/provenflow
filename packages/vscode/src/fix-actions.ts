/**
 * Quick fixes: the changes pflow proposed (and verified) for the findings under the cursor, applied
 * at once, and for every finding a fix to review in a diff (fix-review.ts).
 */
import * as vscode from 'vscode';
import { FIX_COMMANDS } from './fix-review';
import type { ProblemView } from './problem-view';
import { offeredFixes, type ProblemFix } from './report';

export const APPLY_FIX = 'provenflow.applyFix';

export class FixActions implements vscode.CodeActionProvider {
    static readonly KINDS = [vscode.CodeActionKind.QuickFix];

    constructor(private readonly problems: ProblemView) {}

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) return [];
        const unverified = vscode.workspace.getConfiguration('provenflow').get<boolean>('offerUnverifiedFixes', false);
        const problems = this.problems.problemsAt(document.uri, range);
        const fixes = offeredFixes(problems, { unverified }).map(fix => {
            const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
            action.isPreferred = fix.verified;
            action.command = { command: APPLY_FIX, title: fix.title, arguments: [folder.uri, fix] };
            return action;
        });
        const reviews = problems.map(p => {
            const title = `ProvenFlow: fix ${p.code}… (in a diff, with or without an LLM)`;
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.command = { command: FIX_COMMANDS.fix, title, arguments: [folder.uri, p.finding] };
            return action;
        });
        return [...fixes, ...reviews];
    }
}

/** Replaces each file the fix touches with its new text, in one undoable edit. */
export async function applyFix(folder: vscode.Uri, fix: ProblemFix): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const file of fix.files) {
        const uri = vscode.Uri.joinPath(folder, file.file);
        const document = await vscode.workspace.openTextDocument(uri);
        const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        edit.replace(uri, whole, file.after);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied && !fix.verified) void vscode.window.showWarningMessage('ProvenFlow: this fix was not verified. Review the change before keeping it.');
    return applied;
}
