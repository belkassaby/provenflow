/**
 * ProvenFlow in VS Code: runs `pflow extract` on the workspace folder (on save, or on demand), shows
 * its findings as diagnostics with their counterexample steps, and offers its verified fixes as quick
 * fixes. The logic that does not need the editor is in report.ts, cli.ts and analysis-process.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import { AnalysisProcess } from './analysis-process';
import { AnalysisStatus } from './analysis-status';
import { extractArguments, findCli, missingCliMessage, OUTPUT_FOLDER, startsAnalysis, type AnalysisSettings } from './cli';
import { APPLY_FIX, applyFix, FixActions } from './fix-actions';
import { ProblemView } from './problem-view';
import { parseReport, problemsByFile, type Report } from './report';

const ANALYSE = 'provenflow.analyse';
const OPEN_REPORT = 'provenflow.openReport';
const OPEN_MODEL = 'provenflow.openModel';
const DEFAULT_SAVE_DELAY_MS = 1500;

interface Settings extends AnalysisSettings {
    cliPath: string;
    runOnSave: boolean;
    saveDelay: number;
}

/** VS Code disposes what the extension adds to its context's subscriptions when it deactivates it. */
export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(new ProvenflowExtension());
}

export class ProvenflowExtension implements vscode.Disposable {
    private readonly problems = new ProblemView();
    private readonly status = new AnalysisStatus(OPEN_REPORT);
    private readonly log = vscode.window.createOutputChannel('ProvenFlow');
    /** One pflow run per workspace folder: a new one stops the one still running. */
    private readonly runs = new Map<string, AnalysisProcess>();
    private readonly registrations: vscode.Disposable[];
    private saveTimer?: ReturnType<typeof setTimeout>;

    constructor() {
        this.registrations = [
            vscode.commands.registerCommand(ANALYSE, () => this.analyseChosen()),
            vscode.commands.registerCommand(OPEN_REPORT, () => this.openReport()),
            vscode.commands.registerCommand(OPEN_MODEL, () => this.openModel()),
            vscode.commands.registerCommand(APPLY_FIX, applyFix),
            vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixActions(this.problems), { providedCodeActionKinds: FixActions.KINDS }),
            vscode.workspace.onDidSaveTextDocument(document => this.saved(document))
        ];
    }

    /** Runs pflow on a folder and shows its report. */
    async analyse(folder: vscode.WorkspaceFolder): Promise<void> {
        const settings = this.settings();
        const root = folder.uri.fsPath;
        const cli = findCli(root, settings.cliPath, { path: process.env['PATH'] ?? '', platform: process.platform });
        if (!cli) return this.failed(missingCliMessage(settings.cliPath));
        const output = join(root, OUTPUT_FOLDER);
        this.status.running(folder.name);
        const outcome = await this.runFor(root).start(cli, extractArguments(root, output, settings), root);
        if (outcome.stopped) return;
        if (outcome.stderr) this.log.append(outcome.stderr);
        const report = outcome.code === 0 ? readReport(output) : undefined;
        if (!report) return this.failed(`ProvenFlow: pflow extract failed (exit ${outcome.code ?? '-'}). See the ProvenFlow output.`);
        this.problems.show(folder.uri, problemsByFile(report));
        this.status.done(folder.name, report.summary);
    }

    dispose(): void {
        clearTimeout(this.saveTimer);
        for (const run of this.runs.values()) run.dispose();
        this.runs.clear();
        this.registrations.forEach(r => r.dispose());
        this.problems.dispose();
        this.status.dispose();
        this.log.dispose();
    }

    private settings(): Settings {
        const config = vscode.workspace.getConfiguration('provenflow');
        return {
            cliPath: config.get<string>('cliPath', ''),
            runOnSave: config.get<boolean>('runOnSave', true),
            saveDelay: config.get<number>('saveDelay', DEFAULT_SAVE_DELAY_MS),
            full: config.get<boolean>('fullAnalysis', false),
            fixes: config.get<boolean>('proposeFixes', true)
        };
    }

    private runFor(root: string): AnalysisProcess {
        const run = this.runs.get(root) ?? new AnalysisProcess();
        this.runs.set(root, run);
        return run;
    }

    /** A save starts an analysis of its folder once the saves have stopped for a moment. */
    private saved(document: vscode.TextDocument): void {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const settings = this.settings();
        if (!folder || !settings.runOnSave || !startsAnalysis(relative(folder.uri.fsPath, document.uri.fsPath))) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.analyse(folder), settings.saveDelay);
    }

    private async analyseChosen(): Promise<void> {
        const folder = await chooseFolder();
        if (folder) await this.analyse(folder);
    }

    private async openReport(): Promise<void> {
        const folder = await chooseFolder();
        if (!folder) return;
        const report = join(folder.uri.fsPath, OUTPUT_FOLDER, 'report.md');
        if (!existsSync(report)) return void vscode.window.showInformationMessage('ProvenFlow: no report yet. Run ProvenFlow: Analyse workspace first.');
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(report));
    }

    private async openModel(): Promise<void> {
        const folder = await chooseFolder();
        if (!folder) return;
        const models = join(folder.uri.fsPath, OUTPUT_FOLDER, 'models');
        const files = existsSync(models) ? readdirSync(models).filter(f => f.endsWith('.pflow')) : [];
        if (files.length === 0) return void vscode.window.showInformationMessage('ProvenFlow: no models yet. Run ProvenFlow: Analyse workspace first.');
        const picked = await vscode.window.showQuickPick(files, { placeHolder: 'Model to open (open it in the ProvenFlow editor to check and replay it)' });
        if (picked) await vscode.window.showTextDocument(vscode.Uri.file(join(models, picked)));
    }

    private failed(message: string): void {
        this.status.failed(message);
        this.log.appendLine(message);
        void vscode.window.showErrorMessage(message);
    }
}

/** The folder of the active editor, the only folder, or the one the user picks. */
async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const editor = vscode.window.activeTextEditor;
    const active = editor?.document.uri;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const ofActive = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (ofActive) return ofActive;
    if (folders.length <= 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to analyse with ProvenFlow' });
}

function readReport(output: string): Report | undefined {
    try {
        return parseReport(readFileSync(join(output, 'report.json'), 'utf8'));
    } catch {
        return undefined;
    }
}
