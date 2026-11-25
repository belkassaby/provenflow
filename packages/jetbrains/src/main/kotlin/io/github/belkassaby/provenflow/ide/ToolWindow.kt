package io.github.belkassaby.provenflow.ide

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.treeStructure.Tree
import io.github.belkassaby.provenflow.model.EditorDocuments
import io.github.belkassaby.provenflow.model.MeasuredRun
import io.github.belkassaby.provenflow.model.Report
import io.github.belkassaby.provenflow.model.Sidebar
import io.github.belkassaby.provenflow.model.TreeNode
import io.github.belkassaby.provenflow.model.Trends
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.Icon
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel

/** The ProvenFlow tool window: Findings, Models, Hotspots and Trends of the project's last analysis. */
class ProvenflowToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val findings = NodeTreePanel(project, "No analysis yet.", "Analyse project", "ProvenFlow.Analyse", listOf("ProvenFlow.Analyse", "ProvenFlow.OpenReport", "ProvenFlow.OpenC4", "ProvenFlow.OpenEditor"))
        val models = NodeTreePanel(project, "The models ProvenFlow extracts from the code show here after an analysis.")
        val hotspots = NodeTreePanel(project, "The complex functions in files that change often show here after an analysis.")
        val trends = NodeTreePanel(project, "No commits measured yet.", "Measure older commits", "ProvenFlow.BackfillTrends", listOf("ProvenFlow.RefreshTrends", "ProvenFlow.BackfillTrends"))
        val factory = ContentFactory.getInstance()
        val findingsTab = factory.createContent(findings, "Findings", false)
        listOf(findingsTab, factory.createContent(models, "Models", false), factory.createContent(hotspots, "Hotspots", false), factory.createContent(trends, "Trends", false))
            .forEach(toolWindow.contentManager::addContent)
        project.messageBus.connect(toolWindow.disposable).subscribe(
            ReportListener.TOPIC,
            object : ReportListener {
                override fun reportChanged(report: Report) {
                    findings.show(Sidebar.findingNodes(report))
                    models.show(Sidebar.modelNodes(report))
                    hotspots.show(Sidebar.hotspotNodes(report))
                    findingsTab.displayName = "Findings (${report.summary.error + report.summary.warning})"
                }

                override fun trendsChanged(runs: List<MeasuredRun>) = trends.show(Trends.trendNodes(runs))
            },
        )
        AnalysisService.of(project).report?.let { project.messageBus.syncPublisher(ReportListener.TOPIC).reportChanged(it) }
    }
}

/**
 * A tab of the tool window: a tree of nodes, a toolbar, and the empty text with its action. A
 * double-click (or Enter) opens a node's place in the code, or its model in the ProvenFlow editor;
 * a finding's context menu fixes it in a diff, applies its proposed fix or shows its counterexample.
 */
class NodeTreePanel(
    private val project: Project,
    empty: String,
    emptyAction: String? = null,
    emptyActionId: String? = null,
    toolbarActions: List<String> = emptyList(),
) : SimpleToolWindowPanel(true, true) {
    private val tree = Tree(DefaultTreeModel(DefaultMutableTreeNode()))

    init {
        tree.isRootVisible = false
        tree.showsRootHandles = true
        tree.cellRenderer = NodeRenderer()
        tree.emptyText.text = empty
        if (emptyAction != null && emptyActionId != null) tree.emptyText.appendSecondaryText(emptyAction, SimpleTextAttributes.LINK_ATTRIBUTES) { runAction(emptyActionId) }
        javax.swing.ToolTipManager.sharedInstance().registerComponent(tree)
        setContent(JBScrollPane(tree))
        if (toolbarActions.isNotEmpty()) {
            val group = DefaultActionGroup(toolbarActions.mapNotNull { ActionManager.getInstance().getAction(it) })
            toolbar = ActionManager.getInstance().createActionToolbar("ProvenFlow", group, true).also { it.targetComponent = tree }.component
        }
        installOpening()
        PopupHandler.installPopupMenu(tree, DefaultActionGroup(FixAction(), ApplyFixAction(), ShowCounterexampleAction()), "ProvenFlowTree")
    }

    /** Replaces the tree; the groups of findings stay expanded. */
    fun show(nodes: List<TreeNode>) {
        val root = DefaultMutableTreeNode()
        nodes.forEach { root.add(treeNode(it)) }
        tree.model = DefaultTreeModel(root)
        (tree.rowCount - 1 downTo 0).filter { (tree.getPathForRow(it)?.lastPathComponent as? DefaultMutableTreeNode)?.userObject.let { n -> n is TreeNode && n.kind == "category" } }.forEach(tree::expandRow)
    }

    private fun treeNode(node: TreeNode): DefaultMutableTreeNode = DefaultMutableTreeNode(node).also { parent -> node.children.forEach { parent.add(treeNode(it)) } }

    private fun selected(): TreeNode? = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? TreeNode

    private fun installOpening() {
        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean = open(selected())
        }.installOn(tree)
        tree.addKeyListener(
            object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER && open(selected())) e.consume()
                }
            },
        )
    }

    private fun open(node: TreeNode?): Boolean {
        val root = AnalysisService.of(project).root ?: return false
        node?.place?.let { place ->
            val file = LocalFileSystem.getInstance().refreshAndFindFileByPath(File(root, place.file).path) ?: return false
            OpenFileDescriptor(project, file, (place.line - 1).coerceAtLeast(0), 0).navigate(true)
            return true
        }
        return node?.model?.let { openModel(project, it) } ?: false
    }

    private fun runAction(id: String) {
        ActionManager.getInstance().getAction(id)?.let { ActionManager.getInstance().tryToExecute(it, null, tree, "ProvenFlow", true) }
    }

    private inner class FixAction : AnAction("Fix…", "Fix this finding in a diff: the analysis's own fix, an LLM's, or your edit, verified before it is applied", AllIcons.Actions.Edit), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabledAndVisible = selected()?.finding?.loc != null
        }

        override fun actionPerformed(e: AnActionEvent) {
            selected()?.finding?.let { FindingFixes.start(project, it) }
        }
    }

    private inner class ApplyFixAction : AnAction("Apply Fix", "Apply the change ProvenFlow proposed for this finding", AllIcons.Actions.IntentionBulb), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun update(e: AnActionEvent) {
            val policy = AnalysisService.of(project).fixPolicy()
            e.presentation.isEnabledAndVisible = selected()?.finding?.offeredPatch(policy) != null
        }

        override fun actionPerformed(e: AnActionEvent) {
            selected()?.finding?.let { Fixes.apply(project, it) }
        }
    }

    private inner class ShowCounterexampleAction : AnAction("Show Model and Counterexample", "Open the model of this finding in the ProvenFlow editor", AllIcons.Actions.StartDebugger), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabledAndVisible = selected()?.model != null
        }

        override fun actionPerformed(e: AnActionEvent) {
            selected()?.model?.let { openModel(project, it) }
        }
    }
}

/** Opens a model of the last analysis in a ProvenFlow editor tab (checked, when a property of it is false). */
fun openModel(project: Project, model: String): Boolean {
    val service = AnalysisService.of(project)
    val document = service.root?.let { EditorDocuments.model(it, model, service.report) }
    if (document == null) service.notify("models/$model.pflow is not there any more. Analyse the project again.", com.intellij.notification.NotificationType.INFORMATION)
    else EditorTabs.open(project, document)
    return document != null
}

private class NodeRenderer : ColoredTreeCellRenderer() {
    override fun customizeCellRenderer(tree: JTree, value: Any?, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean) {
        val node = (value as? DefaultMutableTreeNode)?.userObject as? TreeNode ?: return
        icon = iconOf(node)
        append(node.label)
        node.description?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
        toolTipText = node.tooltip
    }

    private fun iconOf(node: TreeNode): Icon =
        when {
            node.kind == "step" -> AllIcons.Debugger.Frame
            node.kind == "hotspot" -> AllIcons.Actions.Lightning
            node.kind == "model" -> AllIcons.Nodes.Class
            node.kind == "trend" && node.tone == null -> AllIcons.General.Remove
            node.tone == "error" -> AllIcons.General.Error
            node.tone == "warning" -> AllIcons.General.Warning
            node.tone == "ok" -> AllIcons.RunConfigurations.TestPassed
            else -> AllIcons.General.Information
        }
}
