package io.github.belkassaby.provenflow.model

import com.google.gson.Gson
import java.io.File
import java.net.URI

/**
 * The ProvenFlow editor in an IDE tab: a JCEF page whose only content is a frame of the editor that
 * `pflow serve` runs on 127.0.0.1. The page passes messages between the plugin and the editor (the
 * editor's side is packages/app/src/app/host-frame.ts), as the VS Code extension's page does. No IDE
 * classes here.
 */
object EditorPage {
    /** The editor's address for an IDE tab: the editor then talks to the page around it. */
    fun framedUrl(url: String): String = "$url?host=jetbrains"

    /**
     * The HTML of an editor tab. `toPlugin` is the JavaScript that sends `message` (a JSON string) to
     * the plugin (a JBCefJSQuery's injection); the plugin sends the editor messages through
     * `window.provenflowToEditor`. Only the editor frame's messages, from its origin, reach the plugin.
     */
    fun html(url: String, toPlugin: String): String {
        val origin = URI(url).let { "${it.scheme}://${it.host}:${it.port}" }
        return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; display: block; }</style>
</head>
<body>
<iframe id="editor" title="ProvenFlow editor" src="${framedUrl(url)}"></iframe>
<script>
const frame = document.getElementById('editor');
const origin = ${Gson().toJson(origin)};
window.provenflowToEditor = message => frame.contentWindow.postMessage(message, origin);
window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    const message = JSON.stringify(event.data);
    $toPlugin
});
</script>
</body>
</html>
"""
    }

    /** The JavaScript that hands a message to the editor. */
    fun toEditorScript(message: Map<String, Any?>): String = "window.provenflowToEditor && window.provenflowToEditor(${Gson().toJson(message)});"
}

/**
 * What an editor tab opens: its identity, its title, the message that opens it (none: an empty
 * editor), and the file it shows, when it shows a file of the project (Save writes it).
 */
data class EditorDocument(val key: String, val title: String, val message: Map<String, Any?>? = null, val path: String? = null)

object EditorDocuments {
    /** The kind of editor document a file is, or null when the editor does not open it. */
    fun kindOf(path: String): String? {
        val name = path.lowercase()
        return when {
            name.endsWith(".pflow") || name.endsWith(".nxd") -> "diagram"
            name.endsWith(".dsl") || name.endsWith(".c4.json") -> "c4"
            else -> null
        }
    }

    /** A model of the folder's last analysis (checked at once when a property of it is false); null when its file is not there. */
    fun model(root: String, id: String, report: Report?): EditorDocument? {
        val file = File(root, "${Pflow.OUTPUT_FOLDER}/models/$id.pflow")
        if (!file.isFile) return null
        val check = report?.failedProperties(id)?.isNotEmpty() == true
        return EditorDocument("model:${file.path}", "$id.pflow", openFile(fileOf(file.name, file.path, file.readText(), "diagram") + ("check" to check)))
    }

    /** The C4 architecture of a folder: its projects, mapped by the editor. */
    fun c4(root: String): EditorDocument = EditorDocument("c4:$root", "C4 · ${File(root).name}", mapOf("provenflow" to "map-c4", "path" to root))

    /** A .pflow diagram or a C4 workspace file; null when the editor does not open it. */
    fun file(path: String, text: String): EditorDocument? {
        val kind = kindOf(path) ?: return null
        val name = File(path).name
        return EditorDocument("file:$path", name, openFile(fileOf(name, path, text, kind)), path)
    }

    /** An editor with nothing opened: a new diagram, or File → Import code base. */
    val empty = EditorDocument("editor", "ProvenFlow")

    private fun fileOf(name: String, path: String, text: String, kind: String): Map<String, Any?> = mapOf("name" to name, "path" to path, "text" to text, "kind" to kind)

    private fun openFile(file: Map<String, Any?>): Map<String, Any?> = mapOf("provenflow" to "open-file", "file" to file)
}
