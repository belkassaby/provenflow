/**
 * ProvenFlow in VS Code: runs `pflow extract` on the workspace folder (on save, or on demand), shows
 * its findings as diagnostics with their counterexample steps and in the ProvenFlow sidebar
 * (findings, models, hotspots, trends), offers its verified fixes as quick fixes, and opens the
 * ProvenFlow editor (diagrams, counterexamples, C4) in VS Code tabs. The logic that does not need
 * the editor is in report.ts, sidebar.ts, trends.ts, cli.ts, editor-page.ts and analysis-process.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import { AnalysisProcess } from './analysis-process';
import { AnalysisStatus } from './analysis-status';
import { extractArguments, findCli, missingCliMessage, OUTPUT_FOLDER, startsAnalysis, trendsArguments, type AnalysisSettings } from './cli';
import { c4Document, EMPTY_EDITOR, fileDocument, modelDocument } from './editor-documents';
import { EditorPanels } from './editor-panels';
import { EditorServerProcess } from './editor-server';
import { APPLY_FIX, applyFix, FixActions } from './fix-actions';
import { ProblemView } from './problem-view';
import { parseReport, problemOf, problemsByFile, type Report } from './report';
import type { TreeNode } from './sidebar';
import { SidebarViews } from './sidebar-views';
import { OPEN_MODEL_IN_EDITOR, REVEAL, reveal } from './tree-view';
import { runsOf } from './trends';

const COMMANDS = {
    analyse: 'provenflow.analyse',
    openReport: 'provenflow.openReport',
    openModel: 'provenflow.openModel',
    openEditor: 'provenflow.openEditor',
    openC4: 'provenflow.openC4',
    openInEditor: 'provenflow.openInEditor',
    showCounterexample: 'provenflow.showCounterexample',
    applyFindingFix: 'provenflow.applyFindingFix',
    refreshTrends: 'provenflow.refreshTrends',
    backfillTrends: 'provenflow.backfillTrends'
} as const;
const DEFAULT_SAVE_DELAY_MS = 1500;
/** How many older commits "Measure older commits" measures. */
const BACKFILL_COMMITS = 12;

interface Settings extends AnalysisSettings {
    cliPath: string;
    runOnSave: boolean;
    saveDelay: number;
}

/** VS Code disposes what the extension adds to its context's subscriptions when it deactivates it. */
export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(new ProvenflowExtension(vscode.Uri.joinPath(context.extensionUri, 'media', 'provenflow.svg')));
}

export class ProvenflowExtension implements vscode.Disposable {
    private readonly problems = new ProblemView();
    private readonly status = new AnalysisStatus(COMMANDS.openReport);
    private readonly log = vscode.window.createOutputChannel('ProvenFlow');
    private readonly sidebar = new SidebarViews();
    private readonly editors: EditorPanels;
    /** One pflow run per workspace folder: a new one stops the one still running. */
    private readonly runs = new Map<string, AnalysisProcess>();
    private readonly registrations: vscode.Disposable[];
    private saveTimer?: ReturnType<typeof setTimeout>;

    constructor(icon: vscode.Uri) {
        this.editors = new EditorPanels(new EditorServerProcess(), () => this.serverLaunch(), icon);
        const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
        this.registrations = [
            command(COMMANDS.analyse, () => this.analyseChosen()),
            command(COMMANDS.openReport, () => this.openReport()),
            command(COMMANDS.openModel, () => this.openModel()),
            command(COMMANDS.openEditor, () => this.editors.open(EMPTY_EDITOR)),
            command(COMMANDS.openC4, () => this.openC4()),
            command(COMMANDS.openInEditor, (uri?: vscode.Uri) => this.openInEditor(uri)),
            command(COMMANDS.showCounterexample, (node: TreeNode) => this.openModelOf(node)),
            command(COMMANDS.applyFindingFix, (node: TreeNode) => this.applyFixOf(node)),
            command(COMMANDS.refreshTrends, () => this.refreshTrends()),
            command(COMMANDS.backfillTrends, () => this.refreshTrends(BACKFILL_COMMITS)),
            command(REVEAL, reveal),
            command(OPEN_MODEL_IN_EDITOR, (folder: vscode.Uri, model: string) => this.openModelIn(folder, model)),
            command(APPLY_FIX, applyFix),
            vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixActions(this.problems), { providedCodeActionKinds: FixActions.KINDS }),
            vscode.workspace.onDidSaveTextDocument(document => this.saved(document))
        ];
        this.showLastReport();
    }

    /** Runs pflow on a folder and shows its report. */
    async analyse(folder: vscode.WorkspaceFolder): Promise<void> {
        const root = folder.uri.fsPath;
        const cli = await this.cliFor(root);
        if (!cli) return;
        const output = join(root, OUTPUT_FOLDER);
        this.status.running(folder.name);
        const outcome = await this.runFor(root).start(cli, extractArguments(root, output, this.settings()), root);
        if (outcome.stopped) return;
        if (outcome.stderr) this.log.append(outcome.stderr);
        const report = outcome.code === 0 ? readReport(output) : undefined;
        if (!report) return this.failed(`ProvenFlow: pflow extract failed (exit ${outcome.code ?? '-'}). See the ProvenFlow output.`);
        this.problems.show(folder.uri, problemsByFile(report));
        this.sidebar.showReport(folder.uri, report);
        this.status.done(folder.name, report.summary);
    }

    dispose(): void {
        clearTimeout(this.saveTimer);
        for (const run of this.runs.values()) run.dispose();
        this.runs.clear();
        this.registrations.forEach(r => r.dispose());
        [this.problems, this.status, this.log, this.sidebar, this.editors].forEach(d => d.dispose());
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

    /**
     * The pflow for a folder. When there is none, says so (unless `quiet`) and offers to choose it:
     * the choice is kept in provenflow.cliPath, and used at once.
     */
    private async cliFor(root: string, quiet = false): Promise<string | undefined> {
        const settings = this.settings();
        const cli = findCli(root, settings.cliPath, { path: process.env['PATH'] ?? '', platform: process.platform });
        if (cli || quiet) return cli;
        const message = missingCliMessage(settings.cliPath);
        this.status.failed(message);
        this.log.appendLine(message);
        const action = await vscode.window.showErrorMessage(message, CHOOSE_CLI, OPEN_SETTINGS);
        if (action === OPEN_SETTINGS) void vscode.commands.executeCommand('workbench.action.openSettings', 'provenflow.cliPath');
        return action === CHOOSE_CLI ? chooseCli() : undefined;
    }

    /** The editor's server runs the pflow of the folder shown in the sidebar, else of the first folder. */
    private async serverLaunch(): Promise<{ cli: string; cwd: string } | undefined> {
        const root = (this.sidebar.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.fsPath;
        if (!root) {
            void vscode.window.showInformationMessage('ProvenFlow: open a folder first.');
            return undefined;
        }
        const cli = await this.cliFor(root);
        return cli ? { cli, cwd: root } : undefined;
    }

    private runFor(root: string): AnalysisProcess {
        const run = this.runs.get(root) ?? new AnalysisProcess();
        this.runs.set(root, run);
        return run;
    }

    /** The sidebar starts with the last analysis of the first folder that has one, and its trends. */
    private showLastReport(): void {
        const folder = (vscode.workspace.workspaceFolders ?? []).find(f => existsSync(join(f.uri.fsPath, OUTPUT_FOLDER, 'report.json')));
        const report = folder && readReport(join(folder.uri.fsPath, OUTPUT_FOLDER));
        if (folder && report) this.sidebar.showReport(folder.uri, report);
        void this.refreshTrends(0, true);
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
        const folder = this.sidebar.folder ?? (await chooseFolder())?.uri;
        if (!folder) return;
        const report = join(folder.fsPath, OUTPUT_FOLDER, 'report.md');
        if (!existsSync(report)) return void vscode.window.showInformationMessage('ProvenFlow: no report yet. Run ProvenFlow: Analyse workspace first.');
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(report));
    }

    /** Picks one of the models of the last analysis and opens it in the ProvenFlow editor. */
    private async openModel(): Promise<void> {
        const folder = this.sidebar.folder ?? (await chooseFolder())?.uri;
        if (!folder) return;
        const models = join(folder.fsPath, OUTPUT_FOLDER, 'models');
        const files = existsSync(models) ? readdirSync(models).filter(f => f.endsWith('.pflow')) : [];
        if (files.length === 0) return void vscode.window.showInformationMessage('ProvenFlow: no models yet. Run ProvenFlow: Analyse workspace first.');
        const picked = await vscode.window.showQuickPick(files, { placeHolder: 'Model to open in the ProvenFlow editor' });
        if (picked) await this.openModelIn(folder, picked.replace(/\.pflow$/, ''));
    }

    private async openModelIn(folder: vscode.Uri, model: string): Promise<void> {
        const report = this.sidebar.folder?.toString() === folder.toString() ? this.sidebar.report : undefined;
        const document = modelDocument(folder.fsPath, model, report);
        if (document) await this.editors.open(document);
        else void vscode.window.showInformationMessage(`ProvenFlow: models/${model}.pflow is not there any more. Analyse the workspace again.`);
    }

    /** A finding's model, checked, so that its counterexample shows in the editor. */
    private async openModelOf(node: TreeNode): Promise<void> {
        const folder = this.sidebar.folder;
        if (folder && node.model) await this.openModelIn(folder, node.model);
    }

    private async applyFixOf(node: TreeNode): Promise<void> {
        const fix = node.finding && problemOf(node.finding)?.fix;
        if (this.sidebar.folder && fix) await applyFix(this.sidebar.folder, fix);
    }

    private async openC4(): Promise<void> {
        const folder = this.sidebar.folder ?? (await chooseFolder())?.uri;
        if (folder) await this.editors.open(c4Document(folder.fsPath));
    }

    /** A .pflow diagram or a C4 workspace (Structurizr DSL) in the ProvenFlow editor: the explorer's or the active editor's file. */
    private async openInEditor(uri?: vscode.Uri): Promise<void> {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) return;
        const document = fileDocument(target.fsPath, (await vscode.workspace.openTextDocument(target)).getText());
        if (document) await this.editors.open(document);
        else void vscode.window.showInformationMessage('ProvenFlow: the editor opens .pflow diagrams and C4 workspaces (.dsl, .c4.json).');
    }

    /** The Trends view, from `pflow trends --json`; `backfill` first measures that many older commits. */
    private async refreshTrends(backfill = 0, quiet = false): Promise<void> {
        const folder = this.sidebar.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const cli = folder && (await this.cliFor(folder.fsPath, quiet));
        if (!folder || !cli) return;
        const run = () => new AnalysisProcess().start(cli, trendsArguments(folder.fsPath, backfill), folder.fsPath);
        const title = backfill ? `ProvenFlow: measuring ${backfill} older commits` : 'ProvenFlow: reading the trends';
        const outcome = await vscode.window.withProgress({ location: backfill ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title }, run);
        const runs = outcome.code === 0 ? runsOf(outcome.stdout) : undefined;
        if (runs) this.sidebar.showTrends(folder, runs);
        else if (!quiet) this.failed(`ProvenFlow: pflow trends failed (exit ${outcome.code ?? '-'}). ${outcome.stderr.trim().split('\n').pop() ?? ''}`);
    }

    private failed(message: string): void {
        this.status.failed(message);
        this.log.appendLine(message);
        void vscode.window.showErrorMessage(message);
    }
}

const CHOOSE_CLI = 'Choose pflow…';
const OPEN_SETTINGS = 'Open Settings';

/** Asks for the pflow to run, and keeps it in the user's provenflow.cliPath. */
async function chooseCli(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
        title: 'The pflow to run: packages/server/out/cli.js of a built ProvenFlow checkout, or a pflow command',
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: 'Use this pflow'
    });
    const cli = picked?.[0]?.fsPath;
    if (cli) await vscode.workspace.getConfiguration('provenflow').update('cliPath', cli, vscode.ConfigurationTarget.Global);
    return cli;
}

/** The folder of the active editor, the only folder, or the one the user picks. */
async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const ofActive = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (ofActive) return ofActive;
    if (folders.length <= 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder for ProvenFlow' });
}

function readReport(output: string): Report | undefined {
    try {
        return parseReport(readFileSync(join(output, 'report.json'), 'utf8'));
    } catch {
        return undefined;
    }
}
