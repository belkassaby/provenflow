package io.github.belkassaby.provenflow.ide

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import io.github.belkassaby.provenflow.model.Pflow
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The editor's server: one `pflow serve` for every ProvenFlow editor tab, started with the first one
 * and stopped with the IDE (it ends when its stdin closes).
 */
@Service(Service.Level.APP)
class EditorServer : Disposable {
    private var process: Process? = null
    private var started: CompletableFuture<String>? = null

    /** The editor's address, starting `pflow serve` (with this pflow) when it is not running. Blocks: call it off the UI thread. */
    @Synchronized
    fun url(cli: String, cwd: String): String {
        val future = started?.takeIf { process?.isAlive == true } ?: start(cli, cwd)
        started = future
        return try {
            future.get(START_TIMEOUT_S, TimeUnit.SECONDS)
        } catch (e: Exception) {
            dispose()
            throw IllegalStateException("pflow serve did not start: ${e.cause?.message ?: e.message}", e)
        }
    }

    @Synchronized
    override fun dispose() {
        process?.let {
            it.outputStream.close()
            it.destroy()
        }
        process = null
        started = null
    }

    private fun start(cli: String, cwd: String): CompletableFuture<String> {
        val node = PathEnvironmentVariableUtil.findInPath("node")?.path ?: "node"
        val command = GeneralCommandLine(Pflow.commandLine(cli, Pflow.serveArguments(), node)).withWorkDirectory(cwd).withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE).withRedirectErrorStream(true)
        val started = command.createProcess()
        process = started
        val url = CompletableFuture<String>()
        // Reads what it prints until it says where it listens, then keeps reading so that it never blocks on a full pipe.
        thread(isDaemon = true, name = "ProvenFlow editor server") {
            val output = StringBuilder()
            started.inputStream.bufferedReader().forEachLine { line ->
                if (!url.isDone) output.appendLine(line)
                Pflow.editorUrlOf(output.toString())?.let { url.complete(it) }
            }
            url.completeExceptionally(IllegalStateException("it stopped: ${output.lines().takeLast(3).joinToString(" ")}"))
        }
        return url
    }

    companion object {
        private const val START_TIMEOUT_S = 30L

        fun get(): EditorServer = service()
    }
}
