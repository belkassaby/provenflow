package io.github.belkassaby.provenflow.ide

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.execution.process.ProcessOutput
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.util.Alarm
import com.intellij.util.EnvironmentUtil
import com.intellij.util.messages.Topic
import io.github.belkassaby.provenflow.model.AnalysisSettings
import io.github.belkassaby.provenflow.model.Environment
import io.github.belkassaby.provenflow.model.FixPolicy
import io.github.belkassaby.provenflow.model.MeasuredRun
import io.github.belkassaby.provenflow.model.Pflow
import io.github.belkassaby.provenflow.model.Report
import io.github.belkassaby.provenflow.model.ReportModel
import io.github.belkassaby.provenflow.model.Trends
import java.io.File

/** What the tool window and the highlighting listen to. */
interface ReportListener {
    fun reportChanged(report: Report) {}

    fun trendsChanged(runs: List<MeasuredRun>) {}

    companion object {
        val TOPIC: Topic<ReportListener> = Topic.create("ProvenFlow report", ReportListener::class.java)
    }
}

/**
 * Runs pflow on the project (when a file is saved, or on demand) and keeps its last report. One
 * analysis at a time: a new one cancels the one still running.
 */
@Service(Service.Level.PROJECT)
class AnalysisService(private val project: Project) : Disposable {
    private val saves = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var running: ProgressIndicator? = null

    @Volatile
    var report: Report? = null
        private set

    val root: String? get() = project.basePath

    /** The models of the last analysis. */
    val models: List<ReportModel> get() = report?.models.orEmpty()

    init {
        project.messageBus.connect(this).subscribe(
            VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: List<VFileEvent>) = changed(events)
            },
        )
    }

    /** Analyses the project in the background, and shows its report. */
    fun analyse() {
        val root = root ?: return
        val cli = cli(root) ?: return
        val s = ProvenflowSettings.get()
        running?.cancel()
        val output = File(root, Pflow.OUTPUT_FOLDER).path
        val args = Pflow.extractArguments(root, output, AnalysisSettings(full = s.fullAnalysis, fixes = s.proposeFixes))
        object : Task.Backgroundable(project, "ProvenFlow: analysing ${File(root).name}", true) {
            override fun run(indicator: ProgressIndicator) {
                running = indicator
                val result = run(cli, args, root, indicator)
                if (result.isCancelled) return
                val report = if (result.exitCode == 0) readReport(output) else null
                if (report == null) notify("pflow extract failed (exit ${result.exitCode}). ${result.stderr.trim().lines().lastOrNull() ?: ""}", NotificationType.ERROR)
                else publish(report)
            }
        }.queue()
    }

    /** The last report of the project, if pflow wrote one before (shown when the project opens). */
    fun loadLastReport() {
        val root = root ?: return
        readReport(File(root, Pflow.OUTPUT_FOLDER).path)?.let(::publish)
        // Silently: a project without pflow shows no trends.
        findCli(root)?.let { trends(root, it, 0) {} }
    }

    /** The trends, from `pflow trends --json`; `backfill` first measures that many older commits. */
    fun refreshTrends(backfill: Int) {
        val root = root ?: return
        val cli = cli(root) ?: return
        trends(root, cli, backfill) { notify(it, NotificationType.ERROR) }
    }

    private fun trends(root: String, cli: String, backfill: Int, failed: (String) -> Unit) {
        val title = if (backfill > 0) "ProvenFlow: measuring $backfill older commits" else "ProvenFlow: reading the trends"
        object : Task.Backgroundable(project, title, true) {
            override fun run(indicator: ProgressIndicator) {
                val result = run(cli, Pflow.trendsArguments(root, backfill), root, indicator)
                val runs = if (result.exitCode == 0) Trends.runsOf(result.stdout) else null
                if (runs != null) ApplicationManager.getApplication().invokeLater { project.messageBus.syncPublisher(ReportListener.TOPIC).trendsChanged(runs) }
                else failed("pflow trends failed (exit ${result.exitCode}).")
            }
        }.queue()
    }

    /** The pflow for the project; when there is none, says so and offers to choose it. */
    fun cli(root: String): String? = findCli(root) ?: null.also { missingCli(ProvenflowSettings.get().cliPath ?: "") }

    /** The pflow for the project, if there is one. */
    private fun findCli(root: String): String? = Pflow.findCli(root, ProvenflowSettings.get().cliPath ?: "", Environment(EnvironmentUtil.getValue("PATH") ?: "", SystemInfo.isWindows))

    /** The fixes the IDE offers, as the settings say. */
    fun fixPolicy(): FixPolicy = if (ProvenflowSettings.get().offerUnverifiedFixes) FixPolicy.ANY else FixPolicy.VERIFIED

    /** The notification of a missing pflow: Choose pflow… keeps the choice in the settings and analyses the project. */
    private fun missingCli(configured: String) {
        val choose =
            NotificationAction.createSimpleExpiring("Choose pflow…") {
                val descriptor = FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle("The pflow to Run").withDescription("The packages/server/out/cli.js of a built ProvenFlow checkout, or a pflow command")
                FileChooser.chooseFile(descriptor, project, null)?.let {
                    ProvenflowSettings.get().cliPath = it.path
                    analyse()
                }
            }
        val settings = NotificationAction.createSimpleExpiring("Open settings") { ShowSettingsUtil.getInstance().showSettingsDialog(project, ProvenflowConfigurable::class.java) }
        val notification = notification(Pflow.missingCliMessage(configured), NotificationType.WARNING)
        notification.addAction(choose)
        notification.addAction(settings)
        notification.notify(project)
    }

    fun notify(message: String, type: NotificationType) = notification(message, type).notify(project)

    private fun notification(message: String, type: NotificationType) = group().createNotification("ProvenFlow", message, type)

    private fun group() = NotificationGroupManager.getInstance().getNotificationGroup("ProvenFlow")

    override fun dispose() {
        running?.cancel()
    }

    private fun publish(report: Report) {
        this.report = report
        ApplicationManager.getApplication().invokeLater({ project.messageBus.syncPublisher(ReportListener.TOPIC).reportChanged(report) }, project.disposed)
    }

    /** A save in the project starts an analysis once the saves have stopped for a moment. */
    private fun changed(events: List<VFileEvent>) {
        val root = root ?: return
        val s = ProvenflowSettings.get()
        val inProject = events.any { it is VFileContentChangeEvent && it.isFromSave && Pflow.startsAnalysis(File(it.path).relativeToOrSelf(File(root)).invariantSeparatorsPath) && it.path.startsWith(root) }
        if (!s.runOnSave || !inProject) return
        saves.cancelAllRequests()
        saves.addRequest(::analyse, s.saveDelay)
    }

    companion object {
        fun of(project: Project): AnalysisService = project.service()

        /** Runs pflow with the login shell's environment (the IDE may have been started from the Dock). */
        fun run(cli: String, args: List<String>, cwd: String, indicator: ProgressIndicator): ProcessOutput {
            val node = PathEnvironmentVariableUtil.findInPath("node")?.path ?: "node"
            val command = GeneralCommandLine(Pflow.commandLine(cli, args, node)).withWorkDirectory(cwd).withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
            return CapturingProcessHandler(command).runProcessWithProgressIndicator(indicator)
        }

        fun readReport(output: String): Report? = File(output, "report.json").takeIf { it.isFile }?.let { Report.parse(it.readText()) }
    }
}
