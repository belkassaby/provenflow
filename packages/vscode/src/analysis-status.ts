/** The status bar item: a spinner while pflow runs, then the counts; a click opens the report. */
import * as vscode from 'vscode';
import type { AnalysisProgress } from './cli';
import { countsText, type Severity } from './report';

export class AnalysisStatus implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

    constructor(openReportCommand: string) {
        this.item.command = openReportCommand;
        this.item.text = 'ProvenFlow';
        this.item.tooltip = 'ProvenFlow: analyse the workspace with ProvenFlow: Analyse workspace, or save a file.';
        this.item.show();
    }

    /** While pflow runs: how far it is, and what it is doing. */
    running(folder: string, step?: AnalysisProgress): void {
        this.item.text = `$(sync~spin) ProvenFlow${step ? ` ${step.percent}%` : ''}`;
        this.item.tooltip = `ProvenFlow is analysing ${folder}${step ? `: ${step.message}` : '…'}`;
    }

    stopped(folder: string): void {
        this.item.text = 'ProvenFlow';
        this.item.tooltip = `The analysis of ${folder} was stopped.`;
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
