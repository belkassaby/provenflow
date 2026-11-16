/** The status bar item: a spinner while pflow runs, then the counts; a click opens the report. */
import * as vscode from 'vscode';
import { countsText, type Severity } from './report';

export class AnalysisStatus implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

    constructor(openReportCommand: string) {
        this.item.command = openReportCommand;
        this.item.text = 'ProvenFlow';
        this.item.tooltip = 'ProvenFlow: analyse the workspace with ProvenFlow: Analyse workspace, or save a file.';
        this.item.show();
    }

    running(folder: string): void {
        this.item.text = '$(sync~spin) ProvenFlow';
        this.item.tooltip = `ProvenFlow is analysing ${folder}…`;
    }

    done(folder: string, summary: Record<Severity, number>): void {
        this.item.text = countsText(summary);
        this.item.tooltip = `ProvenFlow on ${folder}: ${summary.error} error(s), ${summary.warning} warning(s), ${summary.info} note(s). Click to open the report.`;
    }

    failed(message: string): void {
        this.item.text = '$(warning) ProvenFlow';
        this.item.tooltip = message;
    }

    dispose(): void {
        this.item.dispose();
    }
}
