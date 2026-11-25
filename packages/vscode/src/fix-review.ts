/**
 * Fixing a finding in a diff: the user picks how (the proposed fix, the analysis's own fix or a
 * draft, an LLM's fix, or by hand), the change opens in diff editors whose right side can be edited,
 * and Verify checks that version (the finding gone, no new warning, the build still passing) before
 * Apply writes it, in one undoable edit. The changes live in memory (the provenflow-fix scheme)
 * until they are applied or discarded.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { changeOf, fixChoices, fixRequest, manualChange, postChange, proposedChange, verifyRequest, type Change, type ChangeResult, type FixChoice, type LlmSettingsView } from './change-client';
import type { ReportFinding } from './report';

export const FIX_SCHEME = 'provenflow-fix';

export const FIX_COMMANDS = {
    fix: 'provenflow.fixFinding',
    verify: 'provenflow.fixReview.verify',
    apply: 'provenflow.fixReview.apply',
    discard: 'provenflow.fixReview.discard'
} as const;

/** The context key that shows the review's commands while one is open. */
const REVIEWING = 'provenflow.fixReviewOpen';
const LLM_SETTINGS_COMMAND = 'provenflow.editor.llmSettings';

/** A change being reviewed: where it applies, and the version Verify last checked. */
interface Review {
    id: number;
    folder: vscode.Uri;
    change: Change;
    /** The right sides Verify found verified (the change's own when pflow verified it). */
    verifiedTexts?: string[];
}

export class FixReview implements vscode.Disposable {
    private readonly files = new MemoryFiles();
    private readonly reviews = new Map<number, Review>();
    private readonly registrations: vscode.Disposable[];
    private next = 1;
    private last?: number;

    /** `serverUrl`: the editor's server (pflow serve), started when needed. */
    constructor(private readonly serverUrl: () => Promise<string | undefined>) {
        const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
        this.registrations = [
            vscode.workspace.registerFileSystemProvider(FIX_SCHEME, this.files, { isCaseSensitive: true }),
            command(FIX_COMMANDS.fix, (folder: vscode.Uri, finding: ReportFinding) => this.fix(folder, finding)),
            command(FIX_COMMANDS.verify, (uri?: vscode.Uri) => this.withReview(uri, r => this.verify(r))),
            command(FIX_COMMANDS.apply, (uri?: vscode.Uri) => this.withReview(uri, r => this.apply(r))),
            command(FIX_COMMANDS.discard, (uri?: vscode.Uri) => this.withReview(uri, r => this.close(r)))
        ];
    }

    /** Asks how to fix a finding, then opens the change in diff editors. */
    async fix(folder: vscode.Uri, finding: ReportFinding): Promise<void> {
        const items = this.choices(finding).then(choices => choices.map(choice => ({ label: choice.label, detail: choice.detail, choice })));
        const picked = await vscode.window.showQuickPick(items, { title: `ProvenFlow: fix ${finding.rule} (${finding.subject})`, placeHolder: 'How to fix it; the change opens in a diff to edit, verify and apply', matchOnDetail: true });
        if (!picked) return;
        const change = await this.changeFor(folder, finding, picked.choice);
        if (change) await this.open(folder, change);
    }

    dispose(): void {
        this.registrations.forEach(r => r.dispose());
        this.reviews.clear();
    }

    private async choices(finding: ReportFinding): Promise<FixChoice[]> {
        return fixChoices(finding, await this.llmSettings());
    }

    /** The LLMs set up on the server; none when it cannot start (the LLM choices are left out). */
    private async llmSettings(): Promise<LlmSettingsView | undefined> {
        try {
            const url = await this.serverUrl();
            return url ? ((await (await fetch(new URL('api/llm-settings', url))).json()) as LlmSettingsView) : undefined;
        } catch {
            return undefined;
        }
    }

    private async changeFor(folder: vscode.Uri, finding: ReportFinding, choice: FixChoice): Promise<Change | undefined> {
        const read = (file: string) => readText(folder, file);
        const how = choice.how;
        if (how.kind === 'llm-settings') return void vscode.commands.executeCommand(LLM_SETTINGS_COMMAND);
        if (how.kind === 'proposed') return proposedChange(finding, read) ?? missing('The proposed fix no longer matches the files: analyse again.');
        if (how.kind === 'manual') return manualChange(finding, read) ?? missing(`${finding.loc?.file ?? 'The file'} cannot be read.`);
        const result = await this.ask('api/fix', `ProvenFlow: ${choice.label.toLowerCase()}`, fixRequest(folder.fsPath, finding, how));
        if (!result) return undefined;
        const change = changeOf(result, how.kind === 'llm' ? `fix by ${how.spec}` : 'fix by the analysis');
        return 'error' in change ? missing(change.error) : change;
    }

    /** Posts a request to the editor's server, with its steps in a notification that can cancel it. */
    private async ask(path: 'api/fix' | 'api/verify-change', title: string, body: Record<string, unknown>): Promise<ChangeResult | undefined> {
        const url = await this.serverUrl();
        if (!url) return undefined;
        try {
            return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, cancel) => {
                const abort = new AbortController();
                cancel.onCancellationRequested(() => abort.abort());
                return postChange(url, path, body, text => progress.report({ message: text }), abort.signal);
            });
        } catch (error) {
            if ((error as Error).name !== 'AbortError') void vscode.window.showErrorMessage(`ProvenFlow: ${(error as Error).message}`);
            return undefined;
        }
    }

    /** Opens each file of a change in a diff: the file now on the left, the change (editable) on the right. */
    private async open(folder: vscode.Uri, change: Change): Promise<void> {
        const review: Review = { id: this.next++, folder, change, verifiedTexts: change.verified ? change.files.map(f => f.after) : undefined };
        this.reviews.set(review.id, review);
        this.last = review.id;
        await vscode.commands.executeCommand('setContext', REVIEWING, true);
        for (const file of change.files) {
            const right = this.uriOf(review, file.file);
            this.files.writeFile(right, Buffer.from(file.after, 'utf8'));
            await vscode.commands.executeCommand('vscode.diff', vscode.Uri.joinPath(folder, file.file), right, `${basename(file.file)} ↔ ${change.title} (ProvenFlow)`, { preview: false });
        }
        const state = change.verified ? 'Verified' : 'Not verified';
        void this.offer(review, `ProvenFlow: ${state}. ${change.note} Edit the right side if needed, then Verify or Apply.`);
    }

    private async offer(review: Review, message: string, warn = false): Promise<void> {
        const show = warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        const action = await show(message, 'Verify', 'Apply', 'Discard');
        if (!this.reviews.has(review.id)) return;
        if (action === 'Verify') await this.verify(review);
        else if (action === 'Apply') await this.apply(review);
        else if (action === 'Discard') await this.close(review);
    }

    /** Checks the right sides as they are now: the finding gone, no new warning, the build passing. */
    private async verify(review: Review): Promise<void> {
        const texts = this.texts(review);
        const changed = review.change.files.map((f, i) => ({ file: f.file, after: texts[i] })).filter((f, i) => f.after !== review.change.files[i].before);
        if (changed.length === 0) return void vscode.window.showInformationMessage('ProvenFlow: the right side is still the file as it is. Change it first, then Verify.');
        const result = await this.ask('api/verify-change', 'ProvenFlow: verifying your version', verifyRequest(review.folder.fsPath, review.change.finding, changed));
        if (!result) return;
        const patch = result.finding?.suggestedPatch;
        if (patch?.verified) review.verifiedTexts = texts;
        const message = patch ? `ProvenFlow: ${patch.verified ? 'verified' : 'not verified'}. ${patch.note}` : `ProvenFlow: ${result.error ?? 'nothing to check.'}`;
        await this.offer(review, message, !patch?.verified);
    }

    /** Writes the right sides into the files (one undoable edit), if the files did not change since. */
    private async apply(review: Review): Promise<void> {
        const texts = this.texts(review);
        const edit = new vscode.WorkspaceEdit();
        for (const [i, file] of review.change.files.entries()) {
            const uri = vscode.Uri.joinPath(review.folder, file.file);
            const document = await vscode.workspace.openTextDocument(uri);
            if (document.getText() !== file.before) return void vscode.window.showErrorMessage(`ProvenFlow: ${file.file} changed since this fix was made. Discard it and fix the finding again.`);
            edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), texts[i]);
        }
        if (!(await vscode.workspace.applyEdit(edit))) return void vscode.window.showErrorMessage('ProvenFlow: the change could not be applied.');
        const verified = review.verifiedTexts?.every((t, i) => t === texts[i]) ?? false;
        await this.close(review);
        if (!verified) void vscode.window.showWarningMessage('ProvenFlow: applied a change that is not verified. Review it before keeping it; the next analysis checks it.');
    }

    /** Closes a review's diffs and forgets its change. */
    private async close(review: Review): Promise<void> {
        const mine = (uri: vscode.Uri) => uri.scheme === FIX_SCHEME && uri.path.startsWith(`/${review.id}/`);
        for (const document of vscode.workspace.textDocuments.filter(d => mine(d.uri) && d.isDirty)) await document.save();
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && mine(t.input.modified));
        await vscode.window.tabGroups.close(tabs);
        review.change.files.forEach(f => this.files.delete(this.uriOf(review, f.file)));
        this.reviews.delete(review.id);
        if (this.last === review.id) this.last = undefined;
        await vscode.commands.executeCommand('setContext', REVIEWING, this.reviews.size > 0);
    }

    /** The right side of each file: the open document's text (saved or not), else what was written. */
    private texts(review: Review): string[] {
        return review.change.files.map(f => {
            const uri = this.uriOf(review, f.file);
            const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            return open?.getText() ?? Buffer.from(this.files.readFile(uri)).toString('utf8');
        });
    }

    /** The review of a diff's right side, of the active editor, or the last one opened. */
    private async withReview(uri: vscode.Uri | undefined, run: (review: Review) => Promise<void>): Promise<void> {
        const of = (u: vscode.Uri | undefined) => (u?.scheme === FIX_SCHEME ? Number(u.path.split('/')[1]) : undefined);
        const id = of(uri) ?? of(vscode.window.activeTextEditor?.document.uri) ?? this.last;
        const review = id === undefined ? undefined : this.reviews.get(id);
        if (review) await run(review);
        else void vscode.window.showInformationMessage('ProvenFlow: no fix is being reviewed.');
    }

    private uriOf(review: Review, file: string): vscode.Uri {
        return vscode.Uri.from({ scheme: FIX_SCHEME, path: `/${review.id}/${file}` });
    }
}

function readText(folder: vscode.Uri, file: string): string | undefined {
    const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === join(folder.fsPath, file));
    if (open) return open.getText();
    try {
        return readFileSync(join(folder.fsPath, file), 'utf8');
    } catch {
        return undefined;
    }
}

function missing(message: string): undefined {
    void vscode.window.showWarningMessage(`ProvenFlow: ${message}`);
    return undefined;
}

/** The changes under review, in memory: editable, and gone with the window. */
class MemoryFiles implements vscode.FileSystemProvider {
    private readonly contents = new Map<string, { data: Uint8Array; mtime: number }>();
    private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changed.event;

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const entry = this.contents.get(uri.path);
        if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
        return { type: vscode.FileType.File, ctime: entry.mtime, mtime: entry.mtime, size: entry.data.byteLength };
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {}

    readFile(uri: vscode.Uri): Uint8Array {
        const entry = this.contents.get(uri.path);
        if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
        return entry.data;
    }

    writeFile(uri: vscode.Uri, content: Uint8Array): void {
        this.contents.set(uri.path, { data: content, mtime: Date.now() });
        this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    delete(uri: vscode.Uri): void {
        this.contents.delete(uri.path);
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('Changes under review cannot be renamed.');
    }
}
