package io.github.belkassaby.provenflow.ide

import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.WindowManager
import io.github.belkassaby.provenflow.model.EditorDocument
import io.github.belkassaby.provenflow.model.EditorExample
import io.github.belkassaby.provenflow.model.Saving
import java.io.File
import java.util.Base64

/** What the plugin does for the editor tabs: it writes the files they save or export, and shows their messages. */
object EditorHost {
    /** Writes a saved or exported file: over the tab's file when it saves that file, else where the user says. */
    fun save(project: Project, document: EditorDocument, file: Map<*, *>) {
        val name = file["name"] as? String ?: return
        val content = file["content"] as? String ?: return
        val bytes = if (file["encoding"] == "base64") Base64.getDecoder().decode(content) else content.toByteArray()
        val plan = Saving.plan(document, name, project.basePath ?: System.getProperty("user.home"))
        val target = plan.write?.let(::File) ?: ask(project, plan.ask ?: return) ?: return
        target.writeBytes(bytes)
        LocalFileSystem.getInstance().refreshAndFindFileByIoFile(target)
        notify(project, "Saved ${target.path}")
    }

    private fun ask(project: Project, suggested: String): File? {
        val file = File(suggested)
        val descriptor = FileSaverDescriptor("Save ${file.name}", "Where ProvenFlow saves the file", file.extension)
        val folder = LocalFileSystem.getInstance().findFileByIoFile(file.parentFile)
        val dialog = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project)
        return dialog.save(folder, file.name)?.file
    }

    fun notify(project: Project, text: String) {
        WindowManager.getInstance().getStatusBar(project)?.info = "ProvenFlow: $text"
    }

    /** The examples in the editor's `ready` message. */
    fun examplesOf(value: Any?): List<EditorExample> =
        (value as? List<*>).orEmpty().mapNotNull { e ->
            val m = e as? Map<*, *> ?: return@mapNotNull null
            val id = m["id"] as? String ?: return@mapNotNull null
            EditorExample(id, m["title"] as? String ?: id, m["group"] as? String ?: "", m["description"] as? String ?: "")
        }
}
