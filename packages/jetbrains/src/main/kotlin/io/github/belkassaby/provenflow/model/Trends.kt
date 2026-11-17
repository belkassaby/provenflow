package io.github.belkassaby.provenflow.model

import com.google.gson.Gson
import com.google.gson.JsonParseException
import kotlin.math.roundToInt

/**
 * The Trends tab: how the folder's quality moved over its measured commits, from
 * `pflow trends <folder> --json` (the history `pflow extract` keeps, and `--backfill` measures from
 * git). No IDE classes here.
 */
data class FindingCounts(val error: Int = 0, val warning: Int = 0, val info: Int = 0)

data class Duplication(val percent: Double = 0.0)

data class Complexity(val p90: Double = 0.0, val overLimit: Int = 0)

data class Properties(val failed: Int = 0)

data class MeasuredRun(
    val date: String,
    val codeLines: Int = 0,
    val findings: FindingCounts = FindingCounts(),
    val duplication: Duplication = Duplication(),
    val complexity: Complexity = Complexity(),
    val coverage: Double? = null,
    val properties: Properties = Properties(),
)

object Trends {
    /** Which way is good news for a measure. */
    private enum class Better { DOWN, UP, NEITHER }

    private class Measure(val label: String, val unit: String = "", val better: Better = Better.DOWN, val value: (MeasuredRun) -> Double?)

    private val measures =
        listOf(
            Measure("Errors") { it.findings.error.toDouble() },
            Measure("Warnings") { it.findings.warning.toDouble() },
            Measure("Properties false") { it.properties.failed.toDouble() },
            Measure("Duplicated code", "%") { it.duplication.percent },
            Measure("Complexity, 90th percentile") { it.complexity.p90 },
            Measure("Functions over the limit") { it.complexity.overLimit.toDouble() },
            Measure("Line coverage", "%", Better.UP) { it.coverage },
            Measure("Code lines", better = Better.NEITHER) { it.codeLines.toDouble() },
        )

    private const val LEVELS = "▁▂▃▄▅▆▇█"

    private class Project(val entries: List<MeasuredRun>? = null)

    /** A bar per value, from the lowest (▁) to the highest (█). */
    fun bars(values: List<Double>): String {
        val low = values.min()
        val span = values.max() - low
        return values.map { LEVELS[if (span == 0.0) 0 else ((it - low) / span * (LEVELS.length - 1)).roundToInt()] }.joinToString("")
    }

    /** The runs of the folder in `pflow trends --json`'s output (the first code base); null when it is not that output. */
    fun runsOf(json: String): List<MeasuredRun>? =
        try {
            Gson().fromJson(json, Array<Project>::class.java)?.let { it.firstOrNull()?.entries.orEmpty() }
        } catch (_: JsonParseException) {
            null
        }

    /** A row per measure: its latest value, the change since the first run, and a bar per run (the last `last`). */
    fun trendNodes(all: List<MeasuredRun>, last: Int = 30): List<TreeNode> {
        val runs = all.takeLast(last)
        if (runs.isEmpty()) return emptyList()
        val span = "${runs.size} run(s), ${runs.first().date.take(10)} to ${runs.last().date.take(10)}"
        return measures.mapNotNull { m -> runs.mapNotNull(m.value).takeIf { it.isNotEmpty() }?.let { trendNode(m, it, span) } }
    }

    private fun trendNode(m: Measure, values: List<Double>, span: String): TreeNode {
        val (first, latest) = values.first() to values.last()
        val change = ((latest - first) * 10).roundToInt() / 10.0
        val shown = if (change == 0.0) "=" else "${if (change > 0) "+" else ""}${number(change)}${m.unit}"
        return TreeNode(
            m.label,
            "${number(latest)}${m.unit}  $shown  ${bars(values)}",
            "${m.label}: ${number(first)}${m.unit} at the first run, ${number(latest)}${m.unit} now ($span).",
            toneOf(change, m.better),
            "trend",
        )
    }

    private fun toneOf(change: Double, better: Better): String? =
        when {
            change == 0.0 || better == Better.NEITHER -> null
            (change > 0) == (better == Better.UP) -> "ok"
            else -> "warning"
        }

    /** 3 rather than 3.0. */
    private fun number(value: Double): String = if (value == Math.rint(value)) value.toLong().toString() else value.toString()
}
