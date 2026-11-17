package io.github.belkassaby.provenflow.model

/**
 * What the ProvenFlow tool window shows, as plain trees: the findings by kind with their
 * counterexample steps, the extracted models with their false properties, and the hotspots. No IDE
 * classes here: ide/NodeTreePanel.kt shows these nodes.
 */
data class TreeNode(
    val label: String,
    val description: String? = null,
    val tooltip: String? = null,
    /** error, warning, info, ok, or none. */
    val tone: String? = null,
    /** What the node is, for its icon: category, finding, step, model, property, hotspot, trend. */
    val kind: String,
    /** The place in the analysed folder a double-click opens. */
    val place: Location? = null,
    /** A model a double-click opens in the ProvenFlow editor (models/<model>.pflow). */
    val model: String? = null,
    val finding: Finding? = null,
    val children: List<TreeNode> = emptyList(),
) {
    override fun toString(): String = label
}

object Sidebar {
    /** The groups of the Findings tab, in the report's order. */
    private val categories =
        linkedMapOf(
            "security" to "Security and dataflow",
            "memory" to "Memory safety and arithmetic",
            "heap" to "Heap (interprocedural)",
            "build" to "Build and tests",
            "dependencies" to "Dependencies",
            "state-machine" to "State machines",
            "lifecycle" to "Resource lifecycles",
            "pattern" to "Design patterns",
            "architecture" to "Architecture",
            "duplication" to "Duplicated code",
            "complexity" to "Complexity",
            "tests" to "Tests and coverage",
            "paradigm" to "Paradigm and size",
            "practice" to "Practices and anti-patterns",
            "naming" to "Naming",
        )

    private val severities = listOf("error", "warning", "info")

    private fun rank(severity: String): Int = severities.indexOf(severity).let { if (it < 0) severities.size else it }

    private fun order(category: String): Int = categories.keys.indexOf(category).let { if (it < 0) categories.size else it }

    /** The findings, grouped by kind (the groups with errors first), each with its counterexample steps. */
    fun findingNodes(report: Report): List<TreeNode> =
        report.findings
            .groupBy { it.category ?: "other" }
            .entries
            .sortedWith(compareBy({ group -> group.value.minOf { rank(it.severity) } }, { order(it.key) }))
            .map { (category, findings) ->
                val worst = severities[findings.minOf { rank(it.severity) }.coerceAtMost(severities.size - 1)]
                TreeNode(categories[category] ?: category, findings.size.toString(), tone = worst, kind = "category", children = findings.sortedBy { rank(it.severity) }.map(::findingNode))
            }

    private fun findingNode(f: Finding): TreeNode {
        val where = f.loc?.let { "${it.file}:${it.line}" } ?: f.subject
        val confirmed =
            when (f.confirmation?.status) {
                "confirmed" -> " · confirmed on the code"
                "refuted" -> " · not reproduced"
                else -> ""
            }
        val steps =
            f.counterexample.orEmpty().mapIndexed { i, step ->
                TreeNode("$i. ${step.event?.let { "$it → " } ?: ""}${step.state}", step.loc?.let { "${it.file}:${it.line}" }, kind = "step", place = step.loc)
            }
        return TreeNode(f.message.lineSequence().first(), "${f.rule} · $where$confirmed", f.details(), f.severity, "finding", f.loc, f.model, f, steps)
    }

    /** The models, those with false properties first, each with the properties found false. */
    fun modelNodes(report: Report): List<TreeNode> =
        report.models
            .sortedWith(compareBy({ -report.failedProperties(it.id).size }, { it.id }))
            .map { m ->
                val failed = report.failedProperties(m.id)
                val checked = report.verdicts.count { it.model == m.id }
                TreeNode(
                    m.subject,
                    if (failed.isEmpty()) "$checked properties hold" else "${failed.size} of $checked properties false",
                    "models/${m.id}.pflow (${m.kind}). Double-click to open it in the ProvenFlow editor.",
                    if (failed.isEmpty()) "ok" else "warning",
                    "model",
                    model = m.id,
                    children = failed.map { TreeNode(it.spec, tone = "error", kind = "property", model = m.id) },
                )
            }

    /** The functions to simplify first: complexity × commits to their file. */
    fun hotspotNodes(report: Report): List<TreeNode> =
        report.hotspots.map { h ->
            TreeNode(
                h.name,
                if (h.changes > 0) "${h.cognitive} × ${h.changes} commits = ${h.score}" else "complexity ${h.cognitive}",
                "${h.file}:${h.line}",
                "warning",
                "hotspot",
                Location(h.file, h.line),
            )
        }
}
