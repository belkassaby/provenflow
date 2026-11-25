package io.github.belkassaby.provenflow.ide

import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.VfsUtilCore
import io.github.belkassaby.provenflow.model.EditorDocuments
import io.github.belkassaby.provenflow.model.EditorExample
import io.github.belkassaby.provenflow.model.EditorMenu
import io.github.belkassaby.provenflow.model.MenuItem
import io.github.belkassaby.provenflow.model.MenuTarget

/** The editor's menus (File, Examples, Attributes, nuXmv, Help) as submenus of Run | ProvenFlow. */
class EditorMenusGroup : ActionGroup(), DumbAware {
    private val submenus: Array<AnAction> by lazy {
        EditorMenu.submenus
            .map { name -> DefaultActionGroup(name, EditorMenu.items.filter { it.submenu == name }.map(::EditorMenuAction)).apply { isPopup = true } }
            .toTypedArray()
    }

    override fun getChildren(e: AnActionEvent?): Array<AnAction> = submenus

    override fun getActionUpdateThread() = ActionUpdateThread.BGT
}

/** An item of the editor's menus: it acts on the ProvenFlow tab in front, a new tab, or opens what it says. */
class EditorMenuAction(private val item: MenuItem) : AnAction(item.title), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.basePath != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val root = project.basePath ?: return
        when (item.target) {
            MenuTarget.TAB -> sendToFront(project)
            MenuTarget.NEW -> EditorTabs.open(project, EditorMenu.commandDocument("new:${++created}", if (item.command == "new-diagram") "Untitled $created.pflow" else "ProvenFlow", item.command))
            MenuTarget.REPORT -> EditorTabs.open(project, EditorMenu.commandDocument("report:$root", "Code Base Report", item.command))
            MenuTarget.C4 -> EditorTabs.open(project, EditorDocuments.c4(root))
            MenuTarget.OPEN -> openFile(project)
            MenuTarget.EXAMPLE -> EditorTabs.withExamples(project) { chooseExample(project, it) }
        }
    }

    /** The tab in front; with none open, an editor of its own (Help, LLM settings...). */
    private fun sendToFront(project: Project) {
        val message = EditorMenu.commandMessage(item.command)
        EditorTabs.front(project)?.send(message) ?: EditorTabs.open(project, EditorDocuments.empty.copy(message = message))
    }

    private fun openFile(project: Project) {
        val descriptor = FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle("Open a Diagram or a C4 Workspace").withExtensionFilter("ProvenFlow diagrams and C4 workspaces", "pflow", "nxd", "dsl", "json")
        val file = FileChooser.chooseFile(descriptor, project, null) ?: return
        EditorDocuments.file(file.path, VfsUtilCore.loadText(file))?.let { EditorTabs.open(project, it) }
    }

    private fun chooseExample(project: Project, examples: List<EditorExample>) {
        val byLabel = examples.associateBy { "${it.title} · ${it.group}" }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(byLabel.keys.toList())
            .setTitle("Example to Open in the ProvenFlow Editor")
            .setItemChosenCallback { label -> byLabel[label]?.let { EditorTabs.open(project, EditorMenu.commandDocument("example:${it.id}", it.title, "example:${it.id}")) } }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    companion object {
        /** New diagrams opened so far, for their tabs' names. */
        private var created = 0
    }
}
