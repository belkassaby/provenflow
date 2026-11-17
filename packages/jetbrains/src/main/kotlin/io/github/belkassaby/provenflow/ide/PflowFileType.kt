package io.github.belkassaby.provenflow.ide

import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.fileTypes.PlainTextLanguage
import com.intellij.openapi.util.IconLoader
import javax.swing.Icon

/** ProvenFlow diagrams (.pflow, .nxd): edited as text, with a ProvenFlow tab showing the diagram. */
class PflowFileType private constructor() : LanguageFileType(PlainTextLanguage.INSTANCE, true) {
    override fun getName(): String = "ProvenFlow diagram"

    override fun getDescription(): String = "ProvenFlow state diagram"

    override fun getDefaultExtension(): String = "pflow"

    override fun getIcon(): Icon = fileIcon

    companion object {
        @JvmField
        val instance = PflowFileType()

        val fileIcon: Icon = IconLoader.getIcon("/icons/provenflow.svg", PflowFileType::class.java)
    }
}
