package io.github.belkassaby.provenflow.model

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress

class FixingTest {
    private val complex = Finding(rule = "cognitive-complexity", severity = "warning", source = "quality", subject = "renderStitched", message = "Too complex.", fix = "Split it.", loc = Location("src/scene.ts", 210))
    private val leak = complex.copy(rule = "resource-leak", subject = "Poller", suggestedPatch = SuggestedPatch(true, "clears it", listOf(PatchFile("src/poller.ts", "fixed"))))
    private val settings =
        LlmSettingsView.parse(
            """{"anthropic": {"model": "claude-sonnet-5", "key": "sk-…abc"}, "openai": {"model": "gpt-4.1"}, "ollama": {"model": "qwen2.5-coder"},
               "preferred": "openai", "configured": {"anthropic": true, "openai": true, "ollama": true}}""",
        )
    private val read = { file: String -> mapOf("src/scene.ts" to "now", "src/poller.ts" to "leaky")[file] }

    @Test
    fun `lists the LLMs set up on the server, the preferred one first`() {
        assertEquals(listOf("openai:gpt-4.1", "anthropic:claude-sonnet-5", "ollama:qwen2.5-coder"), Fixing.llmSpecs(settings).map { it.first })
        assertEquals(listOf("ollama:qwen2.5-coder"), Fixing.llmSpecs(settings!!.copy(preferred = null, configured = mapOf("ollama" to true))).map { it.first })
        assertEquals(emptyList<Pair<String, String>>(), Fixing.llmSpecs(null))
    }

    @Test
    fun `offers the proposed fix first, then without and with an LLM, then by hand`() {
        val kinds = Fixing.choices(leak, settings).map { it.how::class.simpleName }
        assertEquals(listOf("Proposed", "Analysis", "Llm", "Llm", "Llm", "Manual"), kinds)
        assertEquals("Review the verified fix", Fixing.choices(leak, settings).first().label)
        assertEquals(listOf("Analysis", "Manual", "LlmSettings"), Fixing.choices(complex, null).map { it.how::class.simpleName })
    }

    @Test
    fun `asks for the analysis or the LLM fix, with the analysers only for their own findings`() {
        val analysis = JsonParser.parseString(Fixing.fixRequest("/w", complex, FixHow.Analysis)).asJsonObject
        assertEquals("/w", analysis.get("path").asString)
        assertEquals("analysis", analysis.get("how").asString)
        assertEquals(false, analysis.get("analyzers").asBoolean)
        assertEquals("cognitive-complexity", analysis.getAsJsonObject("finding").get("rule").asString)
        val llm = JsonParser.parseString(Fixing.fixRequest("/w", complex.copy(source = "semgrep"), FixHow.Llm("anthropic:m"))).asJsonObject
        assertEquals("anthropic:m", llm.get("llm").asString)
        assertEquals(true, llm.get("analyzers").asBoolean)
        val verify = JsonParser.parseString(Fixing.verifyRequest("/w", complex, listOf("a.ts" to "x"))).asJsonObject
        assertEquals("""[{"file":"a.ts","after":"x"}]""", verify.get("changed").toString())
    }

    @Test
    fun `takes the changes to review from the report, a result, or the file as it is`() {
        assertEquals(listOf(ChangedFile("src/poller.ts", "leaky", "fixed")), Fixing.proposedChange(leak, read)!!.files)
        assertNull(Fixing.proposedChange(complex, read))
        assertEquals(listOf(ChangedFile("src/scene.ts", "now", "now")), Fixing.manualChange(complex, read)!!.files)
        val drafted = complex.copy(suggestedPatch = SuggestedPatch(false, "draft", listOf(PatchFile("src/scene.ts", "// TODO\nnow", "now"))))
        assertEquals("draft", Fixing.changeOf(ChangeResult(drafted), "fix by the analysis").getOrThrow().note)
        assertEquals("none proposed", Fixing.changeOf(ChangeResult(complex, "none proposed"), "t").exceptionOrNull()!!.message)
    }

    @Test
    fun `reads the lines of the server answer`() {
        assertEquals(ChangeLine(stage = "Verifying…"), Fixing.line("""{"event":{"type":"stage","text":"Verifying…"}}"""))
        assertNull(Fixing.line("""{"event":{"type":"thinking","text":"hmm"}}"""))
        assertEquals("busy", Fixing.line("""{"error":"busy"}""")!!.error)
        assertEquals("r", Fixing.line("""{"result":{"finding":{"rule":"r","severity":"info","subject":"s","message":"m","fix":"f"}}}""")!!.result!!.finding!!.rule)
        assertNull(Fixing.line("not json"))
    }

    private lateinit var server: HttpServer

    @Before
    fun startServer() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/fix") { exchange ->
            exchange.requestBody.readAllBytes()
            exchange.sendResponseHeaders(200, 0)
            exchange.responseBody.use {
                it.write("{\"event\":{\"type\":\"stage\",\"text\":\"Analysing…\"}}\n".toByteArray())
                it.flush()
                it.write("{\"result\":{\"error\":\"nothing\"}}\n".toByteArray())
            }
        }
        server.createContext("/api/verify-change") { exchange ->
            val body = """{"error":"Provide 'changed'."}""".toByteArray()
            exchange.sendResponseHeaders(400, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
    }

    @After
    fun stopServer() = server.stop(0)

    @Test
    fun `follows the server answer to its result, or its reason`() {
        val client = ChangeClient("http://127.0.0.1:${server.address.port}/")
        val stages = mutableListOf<String>()
        assertEquals("nothing", client.post("api/fix", "{}", { stages.add(it) }).error)
        assertEquals(listOf("Analysing…"), stages)
        try {
            client.post("api/verify-change", "{}", {})
            fail("a refused request throws")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("Provide 'changed'."))
        }
    }
}
