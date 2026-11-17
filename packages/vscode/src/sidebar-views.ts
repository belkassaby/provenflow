/**
 * The ProvenFlow sidebar (its icon in the activity bar): Findings, Models, Hotspots and Trends of
 * the folder analysed last. Each view shows a welcome text with its actions while it is empty.
 */
import * as vscode from 'vscode';
import type { Report } from './report';
import { findingNodes, hotspotNodes, modelNodes } from './sidebar';
import { NodeTree } from './tree-view';
import { trendNodes, type MeasuredRun } from './trends';

export const VIEWS = {
    findings: 'provenflow.findings',
    models: 'provenflow.models',
    hotspots: 'provenflow.hotspots',
    trends: 'provenflow.trends'
} as const;

export class SidebarViews implements vscode.Disposable {
    private readonly findings = new NodeTree();
    private readonly models = new NodeTree();
    private readonly hotspots = new NodeTree();
    private readonly trends = new NodeTree();
    private readonly findingsView = vscode.window.createTreeView(VIEWS.findings, { treeDataProvider: this.findings, showCollapseAll: true });
    private readonly others = [
        vscode.window.createTreeView(VIEWS.models, { treeDataProvider: this.models }),
        vscode.window.createTreeView(VIEWS.hotspots, { treeDataProvider: this.hotspots }),
        vscode.window.createTreeView(VIEWS.trends, { treeDataProvider: this.trends })
    ];
    /** The folder the views show, and its last report. */
    private shown?: { folder: vscode.Uri; report: Report };

    get folder(): vscode.Uri | undefined {
        return this.shown?.folder;
    }

    get report(): Report | undefined {
        return this.shown?.report;
    }

    /** Shows a folder's report: its findings, models and hotspots. */
    showReport(folder: vscode.Uri, report: Report): void {
        this.shown = { folder, report };
        this.findings.show(findingNodes(report), folder);
        this.models.show(modelNodes(report), folder);
        this.hotspots.show(hotspotNodes(report), folder);
        const count = report.summary.error + report.summary.warning;
        this.findingsView.badge = count ? { value: count, tooltip: `${report.summary.error} error(s), ${report.summary.warning} warning(s)` } : undefined;
        this.findingsView.description = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1 ? folder.path.split('/').pop() : undefined;
    }

    /** Shows how a folder's quality moved over its measured commits. */
    showTrends(folder: vscode.Uri, runs: MeasuredRun[]): void {
        this.trends.show(trendNodes(runs), folder);
    }

    dispose(): void {
        [this.findingsView, ...this.others, this.findings, this.models, this.hotspots, this.trends].forEach(d => d.dispose());
    }
}
