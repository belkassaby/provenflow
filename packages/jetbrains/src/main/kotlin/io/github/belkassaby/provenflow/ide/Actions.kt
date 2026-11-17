package io.github.belkassaby.provenflow.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.wm.ToolWindowManager
import io.github.belkassaby.provenflow.model.EditorDocuments
import io.github.belkassaby.provenflow.model.Pflow
import io.github.belkassaby.provenflow.model.Report
import java.io.File

/** The plugin's actions (Tools | ProvenFlow, the tool window's toolbars, Find Action). */
abstract class ProjectAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.basePath != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.let { perform(it, e) }
    }

    abstract fun perform(project: Project, e: AnActionEvent)
}

class AnalyseAction : ProjectAction() {
    override fun perform(project: Project, e: AnActionEvent) {
        ToolWindowManager.getInstance(project).getToolWindow("ProvenFlow")?.show()
        AnalysisService.of(project).analyse()
    }
}

/** report.md of the last analysis, in the IDE (with the Markdown plugin's preview when it has one). */
class OpenReportAction : ProjectAction() {
    override fun perform(project: Project, e: AnActionEvent) {
        val root = project.basePath ?: return
        val report = LocalFileSystem.getInstance().refreshAndFindFileByPath(File(root, "${Pflow.OUTPUT_FOLDER}/report.md").path)
        if (report == null) AnalysisService.of(project).notify("No report yet. Run Tools | ProvenFlow | Analyse Project first.", NotificationType.INFORMATION)
        else FileEditorManager.getInstance(project).openFile(report, true)
    }
}

class OpenEditorAction : ProjectAction() {
    override fun perform(project: Project, e: AnActionEvent) = EditorTabs.open(project, EditorDocuments.empty)
}

class OpenC4Action : ProjectAction() {
    override fun perform(project: Project, e: AnActionEvent) {
        project.basePath?.let { EditorTabs.open(project, EditorDocuments.c4(it)) }
    }
}

/** Picks one of the models of the last analysis and opens it in a ProvenFlow editor tab. */
class OpenModelAction : ProjectAction() {
    override fun perform(project: Project, e: AnActionEvent) {
        val models = AnalysisService.of(project).models
        if (models.isEmpty()) return AnalysisService.of(project).notify("No models yet. Run Tools | ProvenFlow | Analyse Project first.", NotificationType.INFORMATION)
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(models.map { it.id })
            .setTitle("Model to Open in the ProvenFlow Editor")
            .setItemChosenCallback { openModel(project, it) }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }
}

/** The selected .pflow diagram or C4 workspace in a ProvenFlow editor tab. */
class OpenInEditorAction : ProjectAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { EditorDocuments.kindOf(it.name) } != null
    }

    override fun perform(project: Project, e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        EditorDocuments.file(file.path, VfsUtilCore.loadText(file))?.let { EditorTabs.open(project, it) }
    }
}

class RefreshTrendsAction : ProjectAction() {
    override fun perform(project: Project, e: AnActionEvent) = AnalysisService.of(project).refreshTrends(0)
}

/** Measures older commits from git (`pflow trends --backfill`), without checking them out. */
class BackfillTrendsAction : ProjectAction() {
    override fun perform(project: Project, e: AnActionEvent) = AnalysisService.of(project).refreshTrends(BACKFILL_COMMITS)

    companion object {
        const val BACKFILL_COMMITS = 12
    }
}

/** When a project opens: the report and trends of its last analysis. */
class LoadLastReport : ProjectActivity {
    override suspend fun execute(project: Project) {
        AnalysisService.of(project).loadLastReport()
    }
}

/** The report's findings in the open editors, whenever it changes. */
class HighlightOnReport(private val project: Project) : ReportListener {
    override fun reportChanged(report: Report) = FindingHighlights.showAll(project, report)
}
