package io.github.belkassaby.provenflow.ide

import com.intellij.codeInsight.daemon.impl.HighlightInfoType
import com.intellij.codeInsight.intention.HighPriorityAction
import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.colors.CodeInsightColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiFile
import io.github.belkassaby.provenflow.model.Finding
import io.github.belkassaby.provenflow.model.Report
import java.io.File
import javax.swing.Icon

/**
 * The findings in the code: each one highlights its lines, with a mark on the scroll bar and an icon
 * in the gutter whose tooltip has the message, the fix, the property and the replay's verdict.
 */
object FindingHighlights {
    private val shown = Key.create<List<RangeHighlighter>>("provenflow.highlights")

    /** Shows the report's findings in every open editor of the project. */
    fun showAll(project: Project, report: Report) {
        val editors = EditorFactory.getInstance().allEditors
        editors.filter { it.project == project }.forEach { show(it, report) }
    }

    /** Replaces an editor's ProvenFlow highlights with those of the report. */
    fun show(editor: Editor, report: Report) {
        editor.getUserData(shown)?.forEach { editor.markupModel.removeHighlighter(it) }
        val project = editor.project ?: return
        val findings = findingsIn(project, editor, report)
        editor.putUserData(shown, findings.mapNotNull { highlight(editor, it) })
    }

    /** The findings of the file an editor shows. */
    fun findingsIn(project: Project, editor: Editor, report: Report): List<Finding> {
        val root = AnalysisService.of(project).root ?: return emptyList()
        val path = FileDocumentManager.getInstance().getFile(editor.document)?.path ?: return emptyList()
        val relative = File(path).relativeToOrNull(File(root))?.invariantSeparatorsPath ?: return emptyList()
        return report.findings.filter { it.loc?.file == relative }
    }

    private fun highlight(editor: Editor, f: Finding): RangeHighlighter? {
        val document = editor.document
        val first = (f.loc?.line ?: return null) - 1
        val last = ((f.endLine ?: f.loc.line) - 1).coerceAtMost(document.lineCount - 1)
        if (first !in 0 until document.lineCount) return null
        val start = document.getLineStartOffset(first)
        val end = document.getLineEndOffset(last.coerceAtLeast(first))
        val h = editor.markupModel.addRangeHighlighter(attributesOf(f.severity), start, end, HighlighterLayer.WARNING, HighlighterTargetArea.EXACT_RANGE)
        h.errorStripeTooltip = "ProvenFlow: ${f.details()}"
        h.gutterIconRenderer = FindingGutter(f)
        return h
    }

    private fun attributesOf(severity: String): TextAttributesKey =
        when (severity) {
            "error" -> CodeInsightColors.ERRORS_ATTRIBUTES
            "warning" -> CodeInsightColors.WARNINGS_ATTRIBUTES
            else -> HighlightInfoType.WEAK_WARNING.attributesKey
        }
}

private class FindingGutter(private val finding: Finding) : GutterIconRenderer() {
    override fun getIcon(): Icon =
        when (finding.severity) {
            "error" -> AllIcons.General.Error
            "warning" -> AllIcons.General.Warning
            else -> AllIcons.General.Information
        }

    override fun getTooltipText(): String = "<html><b>ProvenFlow · ${finding.rule}</b><br>${escape(finding.details()).replace("\n", "<br>")}</html>"

    override fun equals(other: Any?): Boolean = other is FindingGutter && other.finding == finding

    override fun hashCode(): Int = finding.hashCode()

    private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}

/** Editors opened after an analysis show its findings too. */
class FindingEditorListener : EditorFactoryListener {
    override fun editorCreated(event: EditorFactoryEvent) {
        val project = event.editor.project ?: return
        AnalysisService.of(project).report?.let { FindingHighlights.show(event.editor, it) }
    }
}

/** Applies a proposed change: the whole new text of each file it touches, in one undoable command. */
object Fixes {
    fun apply(project: Project, finding: Finding) {
        val root = AnalysisService.of(project).root ?: return
        val patch = finding.suggestedPatch ?: return
        val documents =
            patch.files.orEmpty().mapNotNull { p ->
                val file = LocalFileSystem.getInstance().refreshAndFindFileByPath(File(root, p.file).path)
                file?.let { FileDocumentManager.getInstance().getDocument(it) }?.let { it to p.after }
            }
        WriteCommandAction.runWriteCommandAction(project, "ProvenFlow: Apply Fix", null, { documents.forEach { (document, text) -> document.setText(text) } })
        if (!patch.verified) AnalysisService.of(project).notify("This fix was not verified. Review the change before keeping it.", NotificationType.WARNING)
    }
}

/** Alt+Enter on a line with a finding the intention `offers` something for. */
abstract class FindingIntention : IntentionAction {
    override fun startInWriteAction(): Boolean = false

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean = editor != null && findingAt(project, editor) != null

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        editor?.let { findingAt(project, it) }?.let { run(project, it) }
    }

    protected abstract fun offers(project: Project, finding: Finding): Boolean

    protected abstract fun run(project: Project, finding: Finding)

    private fun findingAt(project: Project, editor: Editor): Finding? {
        val report = AnalysisService.of(project).report ?: return null
        val line = editor.caretModel.logicalPosition.line + 1
        return FindingHighlights.findingsIn(project, editor, report).firstOrNull { f ->
            val first = f.loc?.line ?: 0
            line in first..(f.endLine ?: first) && offers(project, f)
        }
    }
}

/** Alt+Enter on a line with a finding: its proposed change, when pflow verified it (or unverified ones, when asked for). */
class ApplyFixIntention : FindingIntention(), HighPriorityAction {
    override fun getFamilyName(): String = "ProvenFlow: apply fix"

    override fun getText(): String = "ProvenFlow: apply verified fix"

    override fun offers(project: Project, finding: Finding): Boolean = finding.offeredPatch(AnalysisService.of(project).fixPolicy()) != null

    override fun run(project: Project, finding: Finding) = Fixes.apply(project, finding)
}
