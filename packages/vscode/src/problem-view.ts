/** The findings of each workspace folder as VS Code diagnostics (the Problems panel and squiggles). */
import * as vscode from 'vscode';
import type { Problem, RelatedPlace, Severity } from './report';

const SEVERITIES: Record<Severity, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information
};

/** The column a diagnostic runs to: the end of its last line (VS Code clamps it to the line). */
const LINE_END = 10_000;

export class ProblemView implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('provenflow');
    /** The problems shown, by file URI, for the code actions. */
    private readonly shown = new Map<string, Problem[]>();
    /** The files each folder's last analysis put problems on, to clear them on the next one. */
    private readonly filesOf = new Map<string, vscode.Uri[]>();

    /** Replaces a folder's problems with those of its latest report. */
    show(folder: vscode.Uri, problems: Map<string, Problem[]>): void {
        this.clear(folder);
        const uris: vscode.Uri[] = [];
        for (const [file, list] of problems) {
            const uri = vscode.Uri.joinPath(folder, file);
            this.collection.set(uri, list.map(p => this.diagnosticOf(folder, p)));
            this.shown.set(uri.toString(), list);
            uris.push(uri);
        }
        this.filesOf.set(folder.toString(), uris);
    }

    /** Removes a folder's problems. */
    clear(folder: vscode.Uri): void {
        for (const uri of this.filesOf.get(folder.toString()) ?? []) {
            this.collection.delete(uri);
            this.shown.delete(uri.toString());
        }
        this.filesOf.delete(folder.toString());
    }

    /** The problems of a file that touch a range of lines. */
    problemsAt(uri: vscode.Uri, range: vscode.Range): Problem[] {
        return (this.shown.get(uri.toString()) ?? []).filter(p => p.line <= range.end.line && p.endLine >= range.start.line);
    }

    dispose(): void {
        this.collection.dispose();
        this.shown.clear();
        this.filesOf.clear();
    }

    private diagnosticOf(folder: vscode.Uri, problem: Problem): vscode.Diagnostic {
        const range = new vscode.Range(problem.line, 0, problem.endLine, LINE_END);
        const diagnostic = new vscode.Diagnostic(range, problem.message, SEVERITIES[problem.severity]);
        diagnostic.source = 'ProvenFlow';
        diagnostic.code = problem.code;
        diagnostic.relatedInformation = problem.related.map(place => this.relatedOf(folder, place));
        return diagnostic;
    }

    private relatedOf(folder: vscode.Uri, place: RelatedPlace): vscode.DiagnosticRelatedInformation {
        const line = Math.max(0, place.line - 1);
        return new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.joinPath(folder, place.file), new vscode.Position(line, 0)), place.message);
    }
}
