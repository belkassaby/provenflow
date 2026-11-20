package io.github.belkassaby.provenflow.model

import com.google.gson.Gson
import com.google.gson.JsonParseException
import com.google.gson.JsonParser
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * One change for one finding, through the editor's server (`pflow serve`): the fix the analysis
 * makes itself (or a draft to finish by hand), the fix an LLM writes, and the check of the user's
 * own version (POST /api/fix, POST /api/verify-change; see packages/server/src/routes/analysis.ts).
 * The same as the VS Code extension's change-client.ts. No IDE classes here: the diff is in ide/.
 */
data class ChangedFile(val file: String, val before: String, val after: String)

/** A change to review: proposed by pflow or an LLM, a draft, or the user's own edit. */
data class Change(val finding: Finding, val title: String, val verified: Boolean, val note: String, val files: List<ChangedFile>)

sealed interface FixHow {
    data object Proposed : FixHow

    data object Analysis : FixHow

    data class Llm(val spec: String) : FixHow

    data object Manual : FixHow

    data object LlmSettings : FixHow
}

data class FixChoice(val label: String, val detail: String, val how: FixHow)

/** What GET /api/llm-settings says (keys masked; only what the choices need). */
data class LlmSettingsView(
    val anthropic: LlmModel? = null,
    val openai: LlmModel? = null,
    val ollama: LlmModel? = null,
    val preferred: String? = null,
    val configured: Map<String, Boolean>? = null,
) {
    data class LlmModel(val model: String? = null)

    fun model(kind: String): String? =
        when (kind) {
            "anthropic" -> anthropic?.model
            "openai" -> openai?.model
            "ollama" -> ollama?.model
            else -> null
        }

    companion object {
        fun parse(text: String): LlmSettingsView? =
            try {
                Gson().fromJson(text, LlmSettingsView::class.java)
            } catch (_: JsonParseException) {
                null
            }
    }
}

/** What a request to the server answers: the finding with its change, or why there is none. */
data class ChangeResult(val finding: Finding? = null, val error: String? = null)

/** One line of the server's NDJSON answer. */
data class ChangeLine(val stage: String? = null, val result: ChangeResult? = null, val error: String? = null)

object Fixing {
    private val llmNames = linkedMapOf("anthropic" to "Anthropic", "openai" to "OpenAI", "ollama" to "Ollama (local)")

    /** The analysers' findings: a check of a change needs them to run again (slower). */
    private val toolSources = setOf("semgrep", "codeql", "infer", "esbmc", "cbmc", "kani", "sarif")

    /** The LLMs set up on the server (Help → LLM Settings), the preferred one first: (`kind:model`, name). */
    fun llmSpecs(settings: LlmSettingsView?): List<Pair<String, String>> {
        if (settings == null) return emptyList()
        val kinds = (listOfNotNull(settings.preferred) + llmNames.keys).distinct().filter { it in llmNames }
        return kinds.mapNotNull { kind ->
            val model = settings.model(kind)
            if (model.isNullOrEmpty() || settings.configured?.get(kind) != true) null else "$kind:$model" to "${llmNames[kind]} $model"
        }
    }

    /** The ways to fix a finding: its proposed change first when it has one, then without and with an LLM, then by hand. */
    fun choices(finding: Finding, settings: LlmSettingsView?): List<FixChoice> {
        val patch = finding.suggestedPatch
        val proposed =
            if (patch?.files.isNullOrEmpty()) emptyList()
            else listOf(FixChoice(if (patch.verified) "Review the verified fix" else "Review the proposed fix (not verified)", patch.note, FixHow.Proposed))
        val llms = llmSpecs(settings).map { (spec, name) -> FixChoice("Fix with $name", "The LLM implements the suggested fix; the change is then checked like the automatic fixes.", FixHow.Llm(spec)) }
        val setUp = if (llms.any { !(it.how as FixHow.Llm).spec.startsWith("ollama:") }) emptyList() else listOf(FixChoice("Set up an LLM (API keys)…", "Anthropic or OpenAI keys and models, kept by pflow.", FixHow.LlmSettings))
        return proposed +
            FixChoice("Fix without an LLM", "The automatic fix where the analysis has one (checked), else the suggested fix as a comment where the code has to change, to finish by hand.", FixHow.Analysis) +
            llms +
            FixChoice("Edit by hand", "${finding.fix} Change the file in the diff, then Verify and Apply.", FixHow.Manual) +
            setUp
    }

    /** The body of POST /api/fix: the analysis's own fix, or an LLM's. */
    fun fixRequest(root: String, finding: Finding, how: FixHow): String {
        val asked = if (how is FixHow.Llm) mapOf("llm" to how.spec) else mapOf("how" to "analysis")
        return Gson().toJson(mapOf("path" to root, "finding" to finding, "analyzers" to needsAnalyzers(finding)) + asked)
    }

    /** The body of POST /api/verify-change: the user's version of the files. */
    fun verifyRequest(root: String, finding: Finding, changed: List<Pair<String, String>>): String =
        Gson().toJson(mapOf("path" to root, "finding" to finding, "analyzers" to needsAnalyzers(finding), "changed" to changed.map { (file, after) -> mapOf("file" to file, "after" to after) }))

    private fun needsAnalyzers(finding: Finding): Boolean = finding.source in toolSources

    /** One line of the answer: a stage to show, the result, or why it failed (null for the others). */
    fun line(text: String): ChangeLine? {
        val value =
            try {
                JsonParser.parseString(text).takeIf { it.isJsonObject }?.asJsonObject
            } catch (_: JsonParseException) {
                null
            } ?: return null
        value.get("result")?.takeIf { it.isJsonObject }?.let { return ChangeLine(result = Gson().fromJson(it, ChangeResult::class.java)) }
        value.get("error")?.takeIf { it.isJsonPrimitive }?.let { return ChangeLine(error = it.asString) }
        val event = value.get("event")?.takeIf { it.isJsonObject }?.asJsonObject ?: return null
        val stage = event.get("text")?.takeIf { event.get("type")?.asString == "stage" && it.isJsonPrimitive }?.asString
        return stage?.let { ChangeLine(stage = it) }
    }

    /** The change a result carries, or why there is none. */
    fun changeOf(result: ChangeResult, title: String): Result<Change> {
        val finding = result.finding
        val patch = finding?.suggestedPatch
        val files = patch?.files.orEmpty().mapNotNull { f -> f.before?.let { ChangedFile(f.file, it, f.after) } }
        if (finding == null || patch == null || files.isEmpty()) return Result.failure(IllegalStateException(result.error ?: "No change was proposed."))
        return Result.success(Change(finding, title, patch.verified, patch.note, files))
    }

    /** The change a finding already has from the analysis; `read` gives a file's text now. */
    fun proposedChange(finding: Finding, read: (String) -> String?): Change? {
        val patch = finding.suggestedPatch ?: return null
        val files = patch.files.orEmpty().mapNotNull { f -> (f.before ?: read(f.file))?.let { ChangedFile(f.file, it, f.after) } }
        return if (files.isEmpty()) null else Change(finding, if (patch.verified) "verified fix" else "proposed fix", patch.verified, patch.note, files)
    }

    /** A change to make by hand: the finding's file, unchanged so far. */
    fun manualChange(finding: Finding, read: (String) -> String?): Change? {
        val file = finding.loc?.file ?: return null
        val text = read(file) ?: return null
        return Change(finding, "your fix", false, "Not checked yet. ${finding.fix}", unchanged(file, text))
    }

    private fun unchanged(file: String, text: String): List<ChangedFile> = listOf(ChangedFile(file, text, text))
}

/**
 * Posts change requests to the editor's server and follows the answer line by line. `opened` gets
 * the answer's stream as soon as it arrives, so that a cancel can close it.
 */
class ChangeClient(private val serverUrl: String) {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    fun llmSettings(): LlmSettingsView? {
        val builder = HttpRequest.newBuilder(URI.create(serverUrl).resolve("api/llm-settings"))
        builder.timeout(Duration.ofSeconds(10))
        val request = builder.GET().build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        return if (response.statusCode() == 200) LlmSettingsView.parse(response.body()) else null
    }

    fun post(path: String, body: String, onStage: (String) -> Unit, opened: (InputStream) -> Unit = {}): ChangeResult {
        val builder = HttpRequest.newBuilder(URI.create(serverUrl).resolve(path))
        builder.header("content-type", "application/json")
        builder.header("accept", "application/x-ndjson")
        val request = builder.POST(HttpRequest.BodyPublishers.ofString(body)).build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofInputStream())
        response.body().use { stream ->
            opened(stream)
            if (response.statusCode() != 200) throw IllegalStateException(errorOf(stream.readAllBytes().toString(Charsets.UTF_8)) ?: "pflow serve answered HTTP ${response.statusCode()}.")
            stream.bufferedReader().lineSequence().forEach { text ->
                val line = Fixing.line(text) ?: return@forEach
                line.stage?.let(onStage)
                line.error?.let { throw IllegalStateException(it) }
                line.result?.let { return it }
            }
        }
        throw IllegalStateException("pflow serve ended its answer without a result.")
    }

    private fun errorOf(text: String): String? =
        try {
            JsonParser.parseString(text).asJsonObject.get("error")?.asString
        } catch (_: RuntimeException) {
            text.trim().ifEmpty { null }
        }
}
