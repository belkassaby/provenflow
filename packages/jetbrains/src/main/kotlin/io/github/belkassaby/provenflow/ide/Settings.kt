package io.github.belkassaby.provenflow.ide

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.panel

/** The plugin's settings (Settings | Tools | ProvenFlow), the same as the VS Code extension's. */
class SettingsState : BaseState() {
    /** The pflow to run; empty: node_modules/.bin/pflow in the project, then pflow on the PATH. */
    var cliPath by string("")
    var runOnSave by property(true)
    var saveDelay by property(1500)
    /** Also run the installed analysers and replay counterexamples (slower). */
    var fullAnalysis by property(false)
    var proposeFixes by property(true)
    var offerUnverifiedFixes by property(false)
}

@Service(Service.Level.APP)
@State(name = "ProvenflowSettings", storages = [Storage("provenflow.xml")])
class ProvenflowSettings : SimplePersistentStateComponent<SettingsState>(SettingsState()) {
    companion object {
        fun get(): SettingsState = service<ProvenflowSettings>().state
    }
}

class ProvenflowConfigurable : BoundConfigurable("ProvenFlow") {
    override fun createPanel(): DialogPanel {
        val s = ProvenflowSettings.get()
        return panel {
            row("pflow command:") {
                textField()
                    .bindText({ s.cliPath ?: "" }, { s.cliPath = it })
                    .columns(COLUMNS_LARGE)
                    .comment("Empty: node_modules/.bin/pflow in the project, then pflow on the PATH. A .js file (packages/server/out/cli.js) runs with node.")
            }
            row { checkBox("Analyse the project when a file is saved").bindSelected({ s.runOnSave }, { s.runOnSave = it }) }
            row("Wait after the last save (ms):") { intTextField(0..60_000).bindIntText({ s.saveDelay }, { s.saveDelay = it }) }
            row {
                checkBox("Full analysis: run the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani) and replay counterexamples on the code")
                    .bindSelected({ s.fullAnalysis }, { s.fullAnalysis = it })
            }
            row { checkBox("Propose automatic fixes, each verified by re-running the analysis and the build").bindSelected({ s.proposeFixes }, { s.proposeFixes = it }) }
            row { checkBox("Also offer fixes that could not be verified").bindSelected({ s.offerUnverifiedFixes }, { s.offerUnverifiedFixes = it }) }
        }
    }
}
