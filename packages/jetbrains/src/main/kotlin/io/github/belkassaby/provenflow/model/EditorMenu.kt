package io.github.belkassaby.provenflow.model

import java.io.File

/**
 * The ProvenFlow menu (Run | ProvenFlow): the editor's own menus (File, Examples, Attributes, nuXmv,
 * Help), which the editor does not show in an IDE tab. The same items as the VS Code extension's
 * (packages/vscode/src/editor-menu.ts). No IDE classes here.
 */
enum class MenuTarget {
    /** The ProvenFlow tab in front (an editor of its own when none is open). */
    TAB,

    /** A new tab. */
    NEW,

    /** The code base report's tab. */
    REPORT,

    /** The IDE's file dialog. */
    OPEN,
    C4,

    /** A list of the editor's examples. */
    EXAMPLE,
}

data class MenuItem(val title: String, val submenu: String, val command: String, val target: MenuTarget = MenuTarget.TAB)

/** An example, as the editor lists them when it is ready. */
data class EditorExample(val id: String, val title: String, val group: String, val description: String)

object EditorMenu {
    val submenus = listOf("File", "Examples", "Attributes", "nuXmv", "Help")

    val items =
        listOf(
            MenuItem("New Diagram", "File", "new-diagram", MenuTarget.NEW),
            MenuItem("Open .pflow…", "File", "open", MenuTarget.OPEN),
            MenuItem("Import Agent Graph…", "File", "import-agent-graph", MenuTarget.NEW),
            MenuItem("Import Code Base…", "File", "import-code", MenuTarget.REPORT),
            MenuItem("Code Base Report", "File", "code-report", MenuTarget.REPORT),
            MenuItem("C4 Architecture", "File", "c4", MenuTarget.C4),
            MenuItem("Save .pflow", "File", "save"),
            MenuItem("Export nuXmv Model (.smv)", "File", "export-smv"),
            MenuItem("Export Diagram (.png)", "File", "export-png"),
            MenuItem("Export Diagram (.svg)", "File", "export-svg"),
            MenuItem("Export Python Implementation (.py)", "File", "export-python"),
            MenuItem("Export Jupyter Notebook (.ipynb)", "File", "export-notebook"),
            MenuItem("Open Example…", "Examples", "example", MenuTarget.EXAMPLE),
            MenuItem("Edit Attribute Table", "Attributes", "attributes"),
            MenuItem("Show Generated Model", "nuXmv", "show-model"),
            MenuItem("Check Properties", "nuXmv", "check"),
            MenuItem("Simulate the Diagram", "nuXmv", "simulate"),
            MenuItem("Show nuXmv Output", "nuXmv", "show-console"),
            MenuItem("Re-detect nuXmv", "nuXmv", "redetect-nuxmv"),
            MenuItem("Using the Editor", "Help", "help:guide"),
            MenuItem("Walkthroughs", "Help", "help:walkthroughs"),
            MenuItem("Logic Symbols", "Help", "help:symbols"),
            MenuItem("Glossary of Logic Terms", "Help", "help:glossary"),
            MenuItem("References", "Help", "help:references"),
            MenuItem("LLM Settings (API Keys)…", "Help", "llm-settings"),
        )

    /** The message that runs one of the editor's commands. */
    fun commandMessage(command: String): Map<String, Any?> = mapOf("provenflow" to "command", "command" to command)

    /** A tab that runs one of the editor's commands when it opens (a new diagram, an example, the code base report). */
    fun commandDocument(key: String, title: String, command: String): EditorDocument = EditorDocument(key, title, commandMessage(command))
}

/** Where a saved file goes: over the tab's file (Save of a .pflow opened from the project), or where the user says, starting there. */
data class SavePlan(val write: String? = null, val ask: String? = null)

object Saving {
    fun plan(document: EditorDocument, name: String, folder: String): SavePlan {
        val path = document.path
        if (path != null && File(path).name == name) return SavePlan(write = path)
        return SavePlan(ask = File(path?.let { File(it).parent } ?: folder, name).path)
    }
}
