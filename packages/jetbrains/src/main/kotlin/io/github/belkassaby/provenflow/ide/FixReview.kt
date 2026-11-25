package io.github.belkassaby.provenflow.ide

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.DiffRequestPanel
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.components.JBLabel
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import io.github.belkassaby.provenflow.model.Change
import io.github.belkassaby.provenflow.model.ChangeClient
import io.github.belkassaby.provenflow.model.ChangeResult
import io.github.belkassaby.provenflow.model.EditorDocuments
import io.github.belkassaby.provenflow.model.EditorMenu
import io.github.belkassaby.provenflow.model.Finding
import io.github.belkassaby.provenflow.model.FixChoice
import io.github.belkassaby.provenflow.model.FixHow
import io.github.belkassaby.provenflow.model.Fixing
import java.awt.BorderLayout
import java.awt.Dimension
import java.io.File
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JPanel

/**
 * Fixing a finding in a diff: the user picks how (the proposed fix, the analysis's own fix or a
 * draft, an LLM's fix, or by hand), the change opens in the IDE's diff with an editable right side,
 * and Verify checks that version (the finding gone, no new warning, the build still passing) before
 * Apply writes it, in one undoable command. The requests go to the editor's server (pflow serve).
 */
object FindingFixes {
    /** Asks how to fix a finding (with the LLMs set up on the server), then opens the change. */
    fun start(project: Project, finding: Finding) {
        val service = AnalysisService.of(project)
        val root = service.root ?: return
        val cli = service.cli(root) ?: return
        object : Task.Backgroundable(project, "ProvenFlow: preparing the fix", true) {
            override fun run(indicator: ProgressIndicator) {
                val url = runCatching { EditorServer.get().url(cli, root) }.getOrNull()
                val settings = url?.let { runCatching { ChangeClient(it).llmSettings() }.getOrNull() }
                ApplicationManager.getApplication().invokeLater({ choose(project, root, url, finding, Fixing.choices(finding, settings)) }, project.disposed)
            }
        }.queue()
    }

    private fun choose(project: Project, root: String, url: String?, finding: Finding, choices: List<FixChoice>) {
        val builder = JBPopupFactory.getInstance().createPopupChooserBuilder(choices)
        builder.setTitle("Fix ${finding.rule} (${finding.subject})")
        builder.setRenderer(ChoiceRenderer())
        builder.setItemChosenCallback { proceed(project, root, url, finding, it) }
        builder.createPopup().showCenteredInCurrentWindow(project)
    }

    private fun proceed(project: Project, root: String, url: String?, finding: Finding, choice: FixChoice) {
        val read = { file: String -> textOf(root, file) }
        when (val how = choice.how) {
            FixHow.LlmSettings -> openLlmSettings(project)
            FixHow.Proposed -> Fixing.proposedChange(finding, read)?.let { FixDialog(project, root, url, it).show() } ?: missing(project, "The proposed fix no longer matches the files: analyse again.")
            FixHow.Manual -> Fixing.manualChange(finding, read)?.let { FixDialog(project, root, url, it).show() } ?: missing(project, "${finding.loc?.file ?: "The file"} cannot be read.")
            is FixHow.Analysis, is FixHow.Llm -> {
                if (url == null) return missing(project, "pflow serve did not start, which fixes on request need. Is the editor built (npm run build)?")
                val title = if (how is FixHow.Llm) "fix by ${how.spec}" else "fix by the analysis"
                request(project, "ProvenFlow: ${choice.label.lowercase()}", url, "api/fix", Fixing.fixRequest(root, finding, how)) { result ->
                    Fixing.changeOf(result, title).fold({ FixDialog(project, root, url, it).show() }, { missing(project, it.message ?: "No change was proposed.") })
                }
            }
        }
    }

    /** Posts a request in the background (its steps in the progress, Cancel closes it), then `done` on the UI thread. */
    fun request(project: Project, title: String, url: String, path: String, body: String, done: (ChangeResult) -> Unit) {
        object : Task.Backgroundable(project, title, true) {
            override fun run(indicator: ProgressIndicator) {
                val result = post(indicator, url, path, body)
                result.onSuccess { ApplicationManager.getApplication().invokeLater({ done(it) }, project.disposed) }
                result.onFailure { if (!indicator.isCanceled) missing(project, it.message ?: "The request failed.") }
            }
        }.queue()
    }

    /** Posts and follows the answer; a cancel of the indicator closes the answer's stream. */
    fun post(indicator: ProgressIndicator, url: String, path: String, body: String): Result<ChangeResult> {
        val stream = AtomicReference<InputStream?>()
        val watch = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay({ if (indicator.isCanceled) stream.get()?.close() }, 200, 200, TimeUnit.MILLISECONDS)
        return try {
            Result.success(ChangeClient(url).post(path, body, { indicator.text2 = it }) { stream.set(it) })
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            watch.cancel(false)
        }
    }

    /** A file's text: its document when it is open (unsaved changes included), else the file. */
    fun textOf(root: String, file: String): String? {
        val virtual = LocalFileSystem.getInstance().findFileByPath(File(root, file).path) ?: return null
        return runReadActionBlocking { FileDocumentManager.getInstance().getDocument(virtual)?.text }
    }

    private fun openLlmSettings(project: Project) {
        val message = EditorMenu.commandMessage("llm-settings")
        EditorTabs.front(project)?.send(message) ?: EditorTabs.open(project, EditorDocuments.empty.copy(message = message))
    }

    fun missing(project: Project, message: String) = AnalysisService.of(project).notify(message, NotificationType.WARNING)
}

/** A way to fix a finding in the chooser: its name, and what it does in its tooltip. */
private class ChoiceRenderer : ColoredListCellRenderer<FixChoice>() {
    override fun customizeCellRenderer(list: JList<out FixChoice>, value: FixChoice?, index: Int, selected: Boolean, hasFocus: Boolean) {
        value ?: return
        append(value.label)
        toolTipText = value.detail
    }
}

/** The change in the IDE's diff: the file it was made on at the left, the change (editable) at the right. */
private class FixDialog(private val project: Project, private val root: String, private val url: String?, private val change: Change) : DialogWrapper(project, true) {
    private val documents: List<Document> = change.files.map { EditorFactory.getInstance().createDocument(StringUtil.convertLineSeparators(it.after)) }
    private val status = JBLabel()
    private val diff: DiffRequestPanel = DiffManager.getInstance().createRequestPanel(project, disposable, null)

    /** The right sides Verify found verified (the change's own when pflow verified it). */
    private var verifiedTexts: List<String>? = if (change.verified) documents.map { it.text } else null

    init {
        title = "ProvenFlow: ${change.title} for ${change.finding.rule} (${change.finding.subject})"
        setOKButtonText("Apply")
        setCancelButtonText("Discard")
        showFile(0)
        showStatus(change.verified, change.note)
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, JBUI.scale(6)))
        val top = JPanel(BorderLayout(0, JBUI.scale(4)))
        top.add(status, BorderLayout.CENTER)
        if (change.files.size > 1) top.add(ComboBox(change.files.map { it.file }.toTypedArray()).apply { addActionListener { showFile(selectedIndex) } }, BorderLayout.SOUTH)
        panel.add(top, BorderLayout.NORTH)
        panel.add(diff.component, BorderLayout.CENTER)
        panel.preferredSize = Dimension(JBUI.scale(1100), JBUI.scale(700))
        return panel
    }

    override fun createActions(): Array<Action> = arrayOf(okAction, VerifyAction(), cancelAction)

    override fun getDimensionServiceKey(): String = "ProvenFlow.FixDialog"

    private fun showFile(index: Int) {
        val file = change.files[index]
        val type = FileTypeManager.getInstance().getFileTypeByFileName(File(file.file).name)
        val factory = DiffContentFactory.getInstance()
        val left = factory.create(project, StringUtil.convertLineSeparators(file.before), type)
        val right = factory.create(project, documents[index], type)
        diff.setRequest(SimpleDiffRequest(file.file, left, right, "${file.file} now", "${change.title} (edit it here)"))
    }

    private fun showStatus(verified: Boolean, note: String) {
        val state = if (verified) "<b>Verified.</b>" else "<b>Not verified.</b>"
        status.text = "<html>$state ${StringUtil.escapeXmlEntities(note)} Edit the right side if needed, then Verify or Apply.</html>"
    }

    /** Checks the right sides as they are now: the finding gone, no new warning, the build passing. */
    private inner class VerifyAction : DialogWrapperAction("Verify") {
        override fun doAction(e: java.awt.event.ActionEvent?) {
            val texts = documents.map { it.text }
            val changed = change.files.mapIndexedNotNull { i, f -> if (texts[i] != StringUtil.convertLineSeparators(f.before)) f.file to texts[i] else null }
            if (changed.isEmpty()) return showStatus(false, "The right side is still the file as it is. Change it first.")
            val server = url ?: return showStatus(false, "pflow serve did not start, which Verify needs.")
            val body = Fixing.verifyRequest(root, change.finding, changed)
            val result =
                ProgressManager.getInstance().runProcessWithProgressSynchronously<Result<ChangeResult>, RuntimeException>(
                    { FindingFixes.post(ProgressManager.getInstance().progressIndicator, server, "api/verify-change", body) },
                    "ProvenFlow: verifying your version",
                    true,
                    project,
                )
            result.onFailure { showStatus(false, it.message ?: "The check failed.") }
            result.onSuccess { r ->
                val patch = r.finding?.suggestedPatch
                if (patch?.verified == true) verifiedTexts = texts
                showStatus(patch?.verified == true, patch?.note ?: r.error ?: "Nothing to check.")
            }
        }
    }

    /** Writes the right sides into the files (one undoable command), if they did not change since. */
    override fun doOKAction() {
        val targets = change.files.map { f -> LocalFileSystem.getInstance().refreshAndFindFileByPath(File(root, f.file).path)?.let { FileDocumentManager.getInstance().getDocument(it) } }
        val stale = change.files.indices.firstOrNull { i -> targets[i]?.text != StringUtil.convertLineSeparators(change.files[i].before) }
        if (stale != null) return Messages.showErrorDialog(project, "${change.files[stale].file} changed since this fix was made. Discard it and fix the finding again.", "ProvenFlow")
        val texts = documents.map { it.text }
        WriteCommandAction.runWriteCommandAction(project, "ProvenFlow: Apply Fix", null, { targets.forEachIndexed { i, d -> d!!.setText(texts[i]) } })
        if (verifiedTexts != texts) AnalysisService.of(project).notify("Applied a change that is not verified. Review it before keeping it; the next analysis checks it.", NotificationType.WARNING)
        super.doOKAction()
    }
}

/** Alt+Enter on a line with a finding: fix it in a diff, with or without an LLM. */
class FixFindingIntention : FindingIntention() {
    override fun getFamilyName(): String = "ProvenFlow: fix in a diff"

    override fun getText(): String = "ProvenFlow: fix… (in a diff, with or without an LLM)"

    override fun offers(project: Project, finding: Finding): Boolean = true

    override fun run(project: Project, finding: Finding) = FindingFixes.start(project, finding)
}
