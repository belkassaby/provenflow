package io.github.belkassaby.provenflow.model

import com.google.gson.Gson
import com.google.gson.JsonParseException
import java.io.File

/** What an analysis runs: the installed analysers and the replay too (slower), and automatic fixes, each verified. */
data class AnalysisSettings(val full: Boolean, val fixes: Boolean)

/** Where pflow is looked for: the PATH, and whether npm's Windows shims apply. */
data class Environment(val path: String, val windows: Boolean)

/** A step of the analysis, as `pflow extract --progress-json` reports it; `percent` is over the whole analysis. */
data class AnalysisProgress(val phase: String? = null, val message: String? = null, val percent: Double? = null)

/** How the plugin runs pflow: which command, with which arguments. No IDE classes here. */
object Pflow {
    /** Where the plugin asks pflow to write its outputs, under the analysed folder. */
    const val OUTPUT_FOLDER = ".provenflow/jetbrains"

    /** The first line `pflow serve` writes (packages/server/src/commands/serve.ts). */
    private val serveBanner = Regex("""ProvenFlow editor at (http://127\.0\.0\.1:\d+/)""")

    /** Folders whose files do not start an analysis when they change: pflow's outputs, git, dependencies, the IDE's. */
    private val notAnalysed = Regex("""^(\.provenflow|\.git|\.idea|node_modules|build|out)(/|$)""")

    /** `pflow extract` for a folder: the report only, never a failing exit code for findings; saves measure no trends. */
    fun extractArguments(folder: String, output: String, settings: AnalysisSettings): List<String> =
        listOf("extract", folder, "-o", output, "--quiet", "--fail-on", "none", "--no-history", "--progress-json") +
            (if (settings.full) emptyList() else listOf("--no-analyzers", "--no-confirm")) +
            (if (settings.fixes) listOf("--fix") else emptyList())

    /** `pflow trends` for a folder, as JSON; with `backfill`, first measures that many older commits. */
    fun trendsArguments(folder: String, backfill: Int = 0): List<String> =
        listOf("trends", folder, "--json") + (if (backfill > 0) listOf("--backfill", backfill.toString(), "--quiet") else emptyList())

    fun serveArguments(): List<String> = listOf("serve", "--until-stdin-closes")

    private const val PROGRESS_PREFIX = "pflow-progress "

    /** The step a line of pflow's stderr reports; null when it is another line (a note, an error). */
    fun progressOf(line: String): AnalysisProgress? {
        if (!line.startsWith(PROGRESS_PREFIX)) return null
        val step =
            try {
                Gson().fromJson(line.removePrefix(PROGRESS_PREFIX).trim(), AnalysisProgress::class.java)
            } catch (_: JsonParseException) {
                null
            }
        return step?.takeIf { it.message != null && it.percent != null }
    }

    /** The last step a chunk of pflow's stderr reports, if any. */
    fun lastProgressIn(text: String): AnalysisProgress? = text.lines().mapNotNull(::progressOf).lastOrNull()

    /** What pflow wrote on stderr besides its progress: its notes and errors. */
    fun notesOf(stderr: String): List<String> = stderr.lines().filter { it.isNotBlank() && progressOf(it) == null }

    /** The editor's address in what `pflow serve` printed so far, once it is there. */
    fun editorUrlOf(output: String): String? = serveBanner.find(output)?.groupValues?.get(1)

    /** Whether a change to a file (its path relative to the project, with /) should start an analysis. */
    fun startsAnalysis(relativePath: String): Boolean = relativePath.isNotEmpty() && !relativePath.startsWith("..") && !notAnalysed.containsMatchIn(relativePath)

    /** The names pflow has on a platform (npm writes a .cmd shim on Windows). */
    private val windowsNames = listOf("pflow.cmd", "pflow.exe", "pflow")
    private val otherNames = listOf("pflow")

    /**
     * The pflow to run, in this order: the configured path (relative to the folder), node_modules/.bin
     * of the folder or of a folder above it (a package of a monorepo), then the PATH. Null when none
     * is there.
     */
    fun findCli(folder: String, configured: String, environment: Environment, exists: (String) -> Boolean = { File(it).exists() }): String? {
        if (configured.isNotBlank()) {
            val file = if (File(configured).isAbsolute) configured else File(folder, configured).path
            return file.takeIf(exists)
        }
        val names = if (environment.windows) windowsNames else otherNames
        val local = generateSequence(File(folder)) { it.parentFile }.toList().flatMap { dir -> names.map { File(File(dir, "node_modules/.bin"), it).path } }
        val onPath = environment.path.split(File.pathSeparator).filter { it.isNotEmpty() }.flatMap { dir -> names.map { File(dir, it).path } }
        return (local + onPath).firstOrNull(exists)
    }

    /** The command line: a .js runs with node, anything else directly. */
    fun commandLine(cli: String, args: List<String>, node: String = "node"): List<String> =
        if (Regex("""\.(c|m)?js$""").containsMatchIn(cli)) listOf(node, cli) + args else listOf(cli) + args

    /** What to tell the user when no pflow is found. */
    fun missingCliMessage(configured: String): String =
        if (configured.isNotBlank()) {
            "The pflow set in Settings | Tools | ProvenFlow ($configured) does not exist. Choose another one."
        } else {
            "pflow was not found (no pflow command is set, and there is no node_modules/.bin/pflow here and no pflow on the PATH). Choose it: the packages/server/out/cli.js of a built ProvenFlow checkout, or a pflow command."
        }
}
