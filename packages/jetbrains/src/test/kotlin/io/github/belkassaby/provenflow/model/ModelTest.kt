package io.github.belkassaby.provenflow.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ModelTest {
    private val report =
        Report.parse(
            """
            {"findings": [
              {"rule": "naming-convention", "category": "naming", "severity": "info", "subject": "do_it", "message": "Not camelCase.", "fix": "doIt.",
               "suggestedPatch": {"verified": false, "note": "rename", "files": [{"file": "a.ts", "after": "x"}]}},
              {"rule": "resource-leak", "category": "lifecycle", "severity": "warning", "subject": "Poller", "message": "Poller can lose the interval.\nMore.", "fix": "Release it.",
               "loc": {"file": "poller.ts", "line": 5}, "model": "lifecycle-Poller-timer", "spec": "never_leaked",
               "counterexample": [{"state": "idle"}, {"state": "held", "event": "Poller.start", "loc": {"file": "poller.ts", "line": 5}}],
               "confirmation": {"by": "replay", "status": "confirmed", "detail": "2 timers are running."},
               "suggestedPatch": {"verified": true, "note": "clears it", "files": [{"file": "poller.ts", "after": "fixed"}]}},
              {"rule": "vulnerable-dependency", "category": "dependencies", "severity": "error", "subject": "lodash", "message": "lodash 4.17.20 has 4 known vulnerabilities.", "fix": "Upgrade.",
               "loc": {"file": "package-lock.json", "line": 4}}],
             "models": [{"id": "pattern-Cache", "kind": "pattern", "subject": "Cache"}, {"id": "lifecycle-Poller-timer", "kind": "lifecycle", "subject": "Poller timer"}],
             "verdicts": [{"model": "lifecycle-Poller-timer", "spec": "never_leaked", "verdict": "false"}, {"model": "pattern-Cache", "spec": "hit", "verdict": "true"}],
             "quality": {"metrics": {"hotspots": [{"name": "applyAll", "file": "code-import.ts", "line": 292, "cognitive": 57, "changes": 16, "score": 912}]}}}
            """.trimIndent(),
        )!!

    @Test
    fun `reads the report and counts the findings when it has no summary`() {
        assertEquals(Summary(1, 1, 1), report.summary)
        assertEquals("Poller can lose the interval.\nMore.\nFix: Release it.\nProperty: never_leaked\nOn the code (replay): confirmed. 2 timers are running.", report.findings[1].details())
        assertNull(report.findings[0].offeredPatch(FixPolicy.VERIFIED))
        assertEquals("x", report.findings[0].offeredPatch(FixPolicy.ANY)?.files?.single()?.after)
        assertNull(Report.parse("""{"nope": 1}"""))
        assertNull(Report.parse("not json"))
    }

    @Test
    fun `groups the findings by kind with errors first, and lists models, properties and hotspots`() {
        val groups = Sidebar.findingNodes(report)
        assertEquals(listOf("Dependencies" to "error", "Resource lifecycles" to "warning", "Naming" to "info"), groups.map { it.label to it.tone })
        val leak = groups[1].children.single()
        assertEquals("Poller can lose the interval.", leak.label)
        assertEquals("resource-leak · poller.ts:5 · confirmed on the code", leak.description)
        assertEquals(listOf("0. idle", "1. Poller.start → held"), leak.children.map { it.label })
        assertEquals(listOf("Poller timer" to "1 of 1 properties false", "Cache" to "1 properties hold"), Sidebar.modelNodes(report).map { it.label to it.description })
        assertEquals(listOf("never_leaked"), Sidebar.modelNodes(report)[0].children.map { it.label })
        assertEquals("57 × 16 commits = 912", Sidebar.hotspotNodes(report).single().description)
    }

    @Test
    fun `shows each measure of the trends with its change and a bar per run`() {
        val json =
            """[{"name": "demo", "entries": [
              {"date": "2026-11-17T10:00:00Z", "codeLines": 9, "findings": {"error": 0, "warning": 1, "info": 0}, "duplication": {"percent": 0}, "complexity": {"p90": 0, "overLimit": 0}, "coverage": 50, "properties": {"failed": 1}},
              {"date": "2026-11-17T11:00:00Z", "codeLines": 13, "findings": {"error": 0, "warning": 0, "info": 0}, "duplication": {"percent": 0}, "complexity": {"p90": 0, "overLimit": 0}, "coverage": 60, "properties": {"failed": 0}}]}]"""
        val nodes = Trends.trendNodes(Trends.runsOf(json)!!).associateBy { it.label }
        assertEquals("0  -1  █▁", nodes["Warnings"]?.description)
        assertEquals("ok", nodes["Warnings"]?.tone)
        assertEquals("60%  +10%  ▁█", nodes["Line coverage"]?.description)
        assertEquals("ok", nodes["Line coverage"]?.tone)
        assertNull(nodes["Code lines"]?.tone)
        assertEquals("▁█▅", Trends.bars(listOf(1.0, 5.0, 3.0)))
        assertNull(Trends.runsOf("not json"))
    }

    @Test
    fun `runs pflow with the right arguments, and finds it`() {
        assertEquals(
            listOf("extract", "/w", "-o", "/w/.provenflow/jetbrains", "--quiet", "--fail-on", "none", "--no-history", "--progress-json", "--no-analyzers", "--no-confirm", "--fix"),
            Pflow.extractArguments("/w", "/w/.provenflow/jetbrains", AnalysisSettings(full = false, fixes = true)),
        )
        assertEquals(listOf("trends", "/w", "--json", "--backfill", "12", "--quiet"), Pflow.trendsArguments("/w", 12))
        assertEquals(AnalysisProgress("verify", "Checking model 1/2", 25.0), Pflow.progressOf("""pflow-progress {"phase":"verify","message":"Checking model 1/2","percent":25}"""))
        assertNull(Pflow.progressOf("note: OSV could not be reached"))
        assertNull(Pflow.progressOf("pflow-progress {broken"))
        assertEquals(listOf("note: x"), Pflow.notesOf("pflow-progress {\"message\":\"a\",\"percent\":5}\nnote: x\n"))
        val there = { paths: List<String> -> { p: String -> p in paths } }
        assertEquals("/w/node_modules/.bin/pflow", Pflow.findCli("/w", "", Environment("/usr/bin:/opt/bin", windows = false), there(listOf("/w/node_modules/.bin/pflow", "/opt/bin/pflow"))))
        assertEquals("/opt/bin/pflow", Pflow.findCli("/w", "", Environment("/usr/bin:/opt/bin", windows = false), there(listOf("/opt/bin/pflow"))))
        assertEquals("/w/tools/cli.js", Pflow.findCli("/w", "tools/cli.js", Environment("/opt/bin", windows = false), there(listOf("/w/tools/cli.js"))))
        assertNull(Pflow.findCli("/w", "/nowhere/pflow", Environment("/opt/bin", windows = false), there(listOf("/opt/bin/pflow"))))
        assertEquals("/repo/node_modules/.bin/pflow", Pflow.findCli("/repo/packages/app", "", Environment("/opt/bin", windows = false), there(listOf("/repo/node_modules/.bin/pflow", "/opt/bin/pflow"))))
        assertEquals(listOf("/n/node", "/p/cli.js", "serve"), Pflow.commandLine("/p/cli.js", listOf("serve"), "/n/node"))
        assertEquals(listOf("src/a.ts", ".provenflow/x", ".git/HEAD", "node_modules/a.js", ".idea/w.xml", "../b.ts").map(Pflow::startsAnalysis), listOf(true, false, false, false, false, false))
    }

    @Test
    fun `frames the editor, and opens models, C4 maps and diagrams`() {
        assertEquals("http://127.0.0.1:53211/", Pflow.editorUrlOf("ProvenFlow editor at http://127.0.0.1:53211/\n"))
        assertNull(Pflow.editorUrlOf("starting"))
        val html = EditorPage.html("http://127.0.0.1:53211/", "window.cefQuery_1({request: message});")
        assertTrue(html.contains("""src="http://127.0.0.1:53211/?host=jetbrains""""))
        assertTrue(html.contains("""if (event.source !== frame.contentWindow || event.origin !== origin) return;"""))
        assertTrue(html.contains("window.cefQuery_1({request: message});"))
        assertEquals("""window.provenflowToEditor && window.provenflowToEditor({"provenflow":"map-c4","path":"/w"});""", EditorPage.toEditorScript(EditorDocuments.c4("/w").message!!))
        val root = Files.createTempDirectory("provenflow-jetbrains").toFile()
        try {
            File(root, "${Pflow.OUTPUT_FOLDER}/models").mkdirs()
            File(root, "${Pflow.OUTPUT_FOLDER}/models/lifecycle-Poller-timer.pflow").writeText("diagram Poller\n")
            val model = EditorDocuments.model(root.path, "lifecycle-Poller-timer", report)!!
            assertEquals(true, (model.message!!["file"] as Map<*, *>)["check"])
            assertNull(EditorDocuments.model(root.path, "gone", report))
        } finally {
            root.deleteRecursively()
        }
        assertEquals(listOf("diagram", "diagram", "c4", "c4", null), listOf("a.pflow", "b.NXD", "w.dsl", "w.c4.json", "x.json").map(EditorDocuments::kindOf))
        assertNull(EditorDocuments.file("/w/a.ts", ""))
    }

    @Test
    fun `lists the editor's menus, and saves over a tab's file only when it saves that file`() {
        assertEquals(EditorMenu.submenus.toSet(), EditorMenu.items.map { it.submenu }.toSet())
        assertEquals(25, EditorMenu.items.size)
        assertEquals(mapOf("provenflow" to "command", "command" to "example:door"), EditorMenu.commandDocument("example:door", "Door", "example:door").message)
        val file = EditorDocuments.file("/w/d/door.pflow", "diagram Door\n")!!
        assertEquals(SavePlan(write = "/w/d/door.pflow"), Saving.plan(file, "door.pflow", "/w"))
        assertEquals(SavePlan(ask = "/w/d/door.smv"), Saving.plan(file, "door.smv", "/w"))
        assertEquals(SavePlan(ask = "/w/w.dsl"), Saving.plan(EditorDocuments.c4("/w"), "w.dsl", "/w"))
    }
}
