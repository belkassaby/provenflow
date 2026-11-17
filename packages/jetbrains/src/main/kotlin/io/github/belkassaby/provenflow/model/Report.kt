package io.github.belkassaby.provenflow.model

import com.google.gson.Gson
import com.google.gson.JsonParseException

/**
 * What the plugin reads from pflow's report.json (written by `pflow extract`, see
 * packages/extract/src/report.ts). No IDE classes here: the IDE parts are in the `ide` package.
 */
data class Location(val file: String, val line: Int)

data class CounterexampleStep(val state: String, val event: String? = null, val loc: Location? = null)

data class Confirmation(val by: String, val status: String, val detail: String)

data class PatchFile(val file: String, val after: String)

data class SuggestedPatch(val verified: Boolean, val note: String, val files: List<PatchFile>? = null)

data class Finding(
    val rule: String,
    val category: String? = null,
    val severity: String,
    val subject: String,
    val message: String,
    val fix: String,
    val loc: Location? = null,
    val endLine: Int? = null,
    val model: String? = null,
    val spec: String? = null,
    val counterexample: List<CounterexampleStep>? = null,
    val confirmation: Confirmation? = null,
    val suggestedPatch: SuggestedPatch? = null,
) {
    /** The change to offer: verified ones, and unverified ones only when the policy allows them. */
    fun offeredPatch(policy: FixPolicy): SuggestedPatch? = suggestedPatch?.takeIf { !it.files.isNullOrEmpty() && (it.verified || policy == FixPolicy.ANY) }

    /** The text shown with the finding in the editor and the tool window. */
    fun details(): String =
        listOfNotNull(
            message,
            "Fix: $fix",
            spec?.let { "Property: $it" },
            confirmation?.let { "On the code (${it.by}): ${it.status}. ${it.detail}" },
        ).joinToString("\n")
}

/** Which proposed changes the IDE offers. */
enum class FixPolicy { VERIFIED, ANY }

data class Hotspot(val name: String, val file: String, val line: Int, val cognitive: Int, val changes: Int, val score: Int)

data class ReportModel(val id: String, val kind: String, val subject: String)

data class Verdict(val model: String, val spec: String, val verdict: String)

data class Summary(val error: Int = 0, val warning: Int = 0, val info: Int = 0)

data class Report(
    val findings: List<Finding>,
    val summary: Summary,
    val models: List<ReportModel>,
    val verdicts: List<Verdict>,
    val hotspots: List<Hotspot>,
) {
    fun failedProperties(model: String): List<Verdict> = verdicts.filter { it.model == model && it.verdict == "false" }

    companion object {
        private class Metrics(val hotspots: List<Hotspot>? = null)

        private class Quality(val metrics: Metrics? = null) {
            fun hotspots(): List<Hotspot> = metrics?.hotspots.orEmpty()
        }

        private class Raw(
            val findings: List<Finding>? = null,
            val summary: Summary? = null,
            val models: List<ReportModel>? = null,
            val verdicts: List<Verdict>? = null,
            val quality: Quality? = null,
        )

        /** Reads report.json's text; null when it is not a report. */
        fun parse(text: String): Report? {
            val raw =
                try {
                    Gson().fromJson(text, Raw::class.java)
                } catch (_: JsonParseException) {
                    null
                }
            val findings = raw?.findings ?: return null
            val counted = Summary(findings.count { it.severity == "error" }, findings.count { it.severity == "warning" }, findings.count { it.severity == "info" })
            return Report(findings, raw.summary ?: counted, raw.models.orEmpty(), raw.verdicts.orEmpty(), raw.quality?.hotspots().orEmpty())
        }
    }
}
