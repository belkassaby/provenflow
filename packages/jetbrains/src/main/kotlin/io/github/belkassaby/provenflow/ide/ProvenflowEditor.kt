package io.github.belkassaby.provenflow.ide

import com.google.gson.Gson
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorLocation
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import io.github.belkassaby.provenflow.model.EditorDocument
import io.github.belkassaby.provenflow.model.EditorDocuments
import io.github.belkassaby.provenflow.model.EditorExample
import io.github.belkassaby.provenflow.model.EditorPage
import java.awt.BorderLayout
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The ProvenFlow editor (diagrams, counterexamples, C4) in an IDE tab: a JCEF browser showing the
 * page of EditorPage, around the editor that `pflow serve` runs. Messages to the editor wait until
 * it says it listens; it follows the IDE's light or dark theme, and asks for folders with the IDE's
 * dialog.
 */
class ProvenflowEditor(private val project: Project, private val file: VirtualFile, private val document: EditorDocument) : UserDataHolderBase(), FileEditor {
    private val panel = JPanel(BorderLayout())
    private var browser: JBCefBrowser? = null
    private var listening = false
    private val waiting = mutableListOf<Map<String, Any?>>()

    init {
        panel.add(JBLabel("Starting the ProvenFlow editor…", SwingConstants.CENTER), BorderLayout.CENTER)
        if (!JBCefApp.isSupported()) message("This IDE runs without JCEF, which the ProvenFlow editor needs.") else startServer()
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(LafManagerListener.TOPIC, LafManagerListener { sendTheme() })
    }

    private fun startServer() {
        val service = AnalysisService.of(project)
        val root = service.root ?: return message("Open a project folder first.")
        val cli = service.cli(root) ?: return message("pflow was not found: choose it in the notification, or in Settings | Tools | ProvenFlow.")
        ApplicationManager.getApplication().executeOnPooledThread {
            val url = runCatching { EditorServer.get().url(cli, root) }
            ApplicationManager.getApplication().invokeLater({ url.fold(::load) { message("${it.message} Is the editor built (npm run build)?") } }, project.disposed)
        }
    }

    private fun load(url: String) {
        val browser = JBCefBrowser()
        Disposer.register(this, browser)
        val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
        Disposer.register(this, query)
        query.addHandler { json ->
            ApplicationManager.getApplication().invokeLater { received(json) }
            null
        }
        browser.loadHTML(EditorPage.html(url, query.inject("message")))
        this.browser = browser
        panel.removeAll()
        panel.add(browser.component, BorderLayout.CENTER)
        panel.revalidate()
        document.message?.let(::send)
    }

    /** Sends the editor a message (opens a document, maps a folder...), once it listens. */
    fun send(message: Map<String, Any?>) {
        val b = browser
        if (listening && b != null) b.cefBrowser.executeJavaScript(EditorPage.toEditorScript(message), b.cefBrowser.url, 0) else waiting.add(message)
    }

    private fun received(json: String) {
        val message = runCatching { Gson().fromJson(json, Map::class.java) }.getOrNull() ?: return
        when (message["provenflow"]) {
            "ready" -> {
                listening = true
                sendTheme()
                waiting.toList().also { waiting.clear() }.forEach(::send)
                EditorTabs.examplesListed(EditorHost.examplesOf(message["examples"]))
            }
            "save-file" -> (message["file"] as? Map<*, *>)?.let { EditorHost.save(project, document, it) }
            "notify" -> (message["text"] as? String)?.let { EditorHost.notify(project, it) }
            "pick-folder" -> {
                val folder = FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor().withTitle(message["title"] as? String ?: "Choose a Folder"), project, null)
                send(mapOf("provenflow" to "folder", "id" to message["id"], "path" to folder?.path))
            }
        }
    }

    private fun sendTheme() {
        if (listening) send(mapOf("provenflow" to "theme", "theme" to if (JBColor.isBright()) "light" else "dark"))
    }

    private fun message(text: String) {
        panel.removeAll()
        panel.add(JBLabel(text, SwingConstants.CENTER), BorderLayout.CENTER)
        panel.revalidate()
    }

    override fun getComponent(): JComponent = panel

    override fun getPreferredFocusedComponent(): JComponent? = browser?.component

    override fun getName(): String = "ProvenFlow"

    override fun getFile(): VirtualFile = file

    override fun setState(state: FileEditorState) {}

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = true

    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}

    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun getCurrentLocation(): FileEditorLocation? = null

    override fun dispose() {}
}

/** A document of the ProvenFlow editor that is not a file of the project: a model, the C4 architecture of a folder, an empty editor. */
class ProvenflowDocumentFile(val document: EditorDocument) : LightVirtualFile(document.title, PlainTextFileType.INSTANCE, "") {
    init {
        isWritable = false
    }
}

/**
 * Opens editor documents in tabs: the same document shows the same tab (and gets the document's
 * message again). Knows the ProvenFlow tab in front, which the menu's commands act on, and the
 * examples the editor lists.
 */
object EditorTabs {
    private val files = mutableMapOf<String, ProvenflowDocumentFile>()
    private var examples: List<EditorExample> = emptyList()
    private val waitingForExamples = mutableListOf<(List<EditorExample>) -> Unit>()

    fun open(project: Project, document: EditorDocument) {
        val key = "${project.locationHash}:${document.key}"
        val reused = files.containsKey(key)
        val file = files.getOrPut(key) { ProvenflowDocumentFile(document) }
        val editors = FileEditorManager.getInstance(project).openFile(file, true)
        if (reused) document.message?.let { message -> editors.filterIsInstance<ProvenflowEditor>().forEach { it.send(message) } }
    }

    /** The ProvenFlow tab in front, if the selected editor is one. */
    fun front(project: Project): ProvenflowEditor? = FileEditorManager.getInstance(project).selectedEditor as? ProvenflowEditor

    /** Runs `use` with the editor's examples: at once when an editor listed them, else once an empty editor opened for it does. */
    fun withExamples(project: Project, use: (List<EditorExample>) -> Unit) {
        if (examples.isNotEmpty()) return use(examples)
        waitingForExamples.add(use)
        open(project, EditorDocuments.empty)
    }

    fun examplesListed(listed: List<EditorExample>) {
        if (listed.isEmpty()) return
        examples = listed
        waitingForExamples.toList().also { waitingForExamples.clear() }.forEach { it(listed) }
    }
}

/** The editor tab of models, C4 maps and the empty editor. */
class ProvenflowDocumentEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = file is ProvenflowDocumentFile

    override fun createEditor(project: Project, file: VirtualFile): FileEditor = ProvenflowEditor(project, file, (file as ProvenflowDocumentFile).document)

    override fun getEditorTypeId(): String = "provenflow-document"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

/** A "ProvenFlow" tab next to the text of .pflow diagrams and C4 workspaces (.dsl, .c4.json). */
class ProvenflowFileEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = file.isInLocalFileSystem && EditorDocuments.kindOf(file.name) != null

    override fun createEditor(project: Project, file: VirtualFile): FileEditor = ProvenflowEditor(project, file, EditorDocuments.file(file.path, VfsUtilCore.loadText(file)) ?: EditorDocuments.empty)

    override fun getEditorTypeId(): String = "provenflow-file"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR
}
