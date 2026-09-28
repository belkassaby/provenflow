/**
 * The LLM providers: Anthropic, OpenAI-compatible servers and Ollama. Answers are streamed, so the
 * model's thinking (when it has any and the setting asks for it) and its answer can be followed as
 * they are written, and every call reports its token usage.
 *
 * Thinking: LLM_THINKING=<budget in tokens> asks for it (Anthropic extended thinking, Ollama
 * `think`; OpenAI-compatible reasoning models send theirs as reasoning_content). A model that
 * refuses it is asked again without.
 */
import type { Fetch } from './llm-types.js';
import type { LlmEvent, LlmProvider, LlmUsage } from './llm-types.js';

export type { LlmEvent, LlmProvider, LlmUsage } from './llm-types.js';

class HttpFailure extends Error {
    constructor(
        readonly spec: string,
        readonly status: number,
        readonly body: string
    ) {
        const hint = /anthropic-workspace-id/.test(body) ? ' Set the workspace ID (LLM settings, or ANTHROPIC_WORKSPACE_ID): it is in the Claude Console under Settings → Workspaces. Or create the key inside a workspace.' : '';
        super(`${spec}: HTTP ${status} ${body.slice(0, 300)}${hint}`);
    }
}

/** `anthropic:<model>`, `openai:<model>` (any OpenAI-compatible server via OPENAI_BASE_URL) or `ollama:<model>`. */
export function providerFromSpec(spec: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): LlmProvider {
    const [kind, ...rest] = spec.split(':');
    const model = rest.join(':');
    const thinking = Math.max(0, Number(env['LLM_THINKING'] ?? 0) || 0);
    const send = async (url: string, headers: Record<string, string>, body: unknown): Promise<Response> => {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
        if (!response.ok) throw new HttpFailure(spec, response.status, await response.text());
        return response;
    };
    /** Sends `body`; if the server refuses one of `optional`'s fields (HTTP 400 naming it), again without it. */
    const sendTolerant = async (url: string, headers: Record<string, string>, body: Record<string, unknown>, optional: string[], onEvent?: (e: LlmEvent) => void): Promise<Response> => {
        let current = body;
        for (;;) {
            try {
                return await send(url, headers, current);
            } catch (error) {
                const refused = error instanceof HttpFailure && error.status === 400 ? optional.find(k => k in current && new RegExp(k.replace('_', '.?'), 'i').test(error.body)) : undefined;
                if (!refused) throw error;
                const { [refused]: _dropped, ...rest } = current;
                if (refused === 'thinking' || refused === 'think') onEvent?.({ type: 'note', text: `${spec} does not offer its thinking: asked again without it.` });
                current = refused === 'thinking' ? { ...rest, max_tokens: 8192 } : rest;
            }
        }
    };
    switch (kind) {
        case 'anthropic': {
            const key = env['ANTHROPIC_API_KEY'];
            if (!key) throw new Error('Set ANTHROPIC_API_KEY to use anthropic:<model>.');
            // A key not scoped to a workspace needs the workspace named in each request.
            const headers: Record<string, string> = { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(env['ANTHROPIC_WORKSPACE_ID'] ? { 'anthropic-workspace-id': env['ANTHROPIC_WORKSPACE_ID'] } : {}) };
            return {
                name: spec,
                async complete(system, user, onEvent) {
                    const body = { model: model || 'claude-sonnet-5', max_tokens: thinking ? thinking + 8192 : 8192, system, messages: [{ role: 'user', content: user }], stream: true, ...(thinking ? { thinking: { type: 'enabled', budget_tokens: thinking } } : {}) };
                    const res = await sendTolerant(`${env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com'}/v1/messages`, headers, body, ['thinking'], onEvent);
                    return readAnthropic(res, spec, onEvent);
                }
            };
        }
        case 'openai': {
            const key = env['OPENAI_API_KEY'] ?? '';
            return {
                name: spec,
                async complete(system, user, onEvent) {
                    const url = `${env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'}/chat/completions`;
                    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, stream: true, stream_options: { include_usage: true } };
                    // Reasoning models refuse a temperature, some servers stream_options: asked again without them.
                    const res = await sendTolerant(url, key ? { authorization: `Bearer ${key}` } : {}, body, ['temperature', 'stream_options'], onEvent);
                    return readOpenAi(res, onEvent);
                }
            };
        }
        case 'ollama':
            return {
                name: spec,
                async complete(system, user, onEvent) {
                    const body = { model, stream: true, options: { temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(thinking ? { think: true } : {}) };
                    const res = await sendTolerant(`${env['OLLAMA_HOST'] ?? 'http://localhost:11434'}/api/chat`, {}, body, ['think'], onEvent);
                    return readOllama(res, onEvent);
                }
            };
        default:
            throw new Error(`Unknown LLM provider '${kind}': use anthropic:<model>, openai:<model> or ollama:<model>.`);
    }
}

/** The lines of a streamed response body, as they arrive. */
async function* linesOf(res: Response): AsyncGenerator<string> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        yield* lines;
        if (done) {
            if (buffer) yield buffer;
            return;
        }
    }
}

/** The JSON payloads of a server-sent event stream (`data: {...}` lines). */
async function* eventsOf(res: Response): AsyncGenerator<Record<string, any>> {
    for await (const line of linesOf(res)) {
        const data = /^data:\s?(.*)$/.exec(line)?.[1];
        if (!data || data === '[DONE]') continue;
        try {
            yield JSON.parse(data) as Record<string, any>;
        } catch {
            // a partial or keep-alive line
        }
    }
}

const streamed = (res: Response) => /event-stream|ndjson|x-ndjson/.test(res.headers.get('content-type') ?? '');

async function readAnthropic(res: Response, spec: string, onEvent?: (e: LlmEvent) => void): Promise<string> {
    if (!streamed(res)) {
        const json = (await res.json()) as { content: Array<{ type: string; text?: string; thinking?: string }>; usage?: Record<string, number> };
        for (const c of json.content) if (c.type === 'thinking' && c.thinking) onEvent?.({ type: 'thinking', text: c.thinking });
        const text = json.content.filter(c => c.type === 'text').map(c => c.text).join('');
        onEvent?.({ type: 'text', text });
        if (json.usage) onEvent?.({ type: 'usage', usage: anthropicUsage(json.usage) });
        return text;
    }
    let text = '';
    let usage: Record<string, number> = {};
    for await (const e of eventsOf(res)) {
        if (e['type'] === 'message_start') usage = { ...usage, ...(e['message']?.usage ?? {}) };
        else if (e['type'] === 'content_block_delta') {
            const d = e['delta'] ?? {};
            if (d.type === 'thinking_delta' && d.thinking) onEvent?.({ type: 'thinking', text: d.thinking });
            else if (d.type === 'text_delta' && d.text) {
                text += d.text;
                onEvent?.({ type: 'text', text: d.text });
            }
        } else if (e['type'] === 'message_delta') usage = { ...usage, ...(e['usage'] ?? {}) };
        else if (e['type'] === 'error') throw new Error(`${spec}: ${e['error']?.message ?? 'the stream failed'}`);
    }
    onEvent?.({ type: 'usage', usage: anthropicUsage(usage) });
    return text;
}

function anthropicUsage(u: Record<string, number>): LlmUsage {
    return { input: (u['input_tokens'] ?? 0) + (u['cache_read_input_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0), output: u['output_tokens'] ?? 0, cacheRead: u['cache_read_input_tokens'] || undefined };
}

async function readOpenAi(res: Response, onEvent?: (e: LlmEvent) => void): Promise<string> {
    const usageOf = (u?: Record<string, any>): LlmUsage | undefined => (u ? { input: u['prompt_tokens'] ?? 0, output: u['completion_tokens'] ?? 0, thinking: u['completion_tokens_details']?.reasoning_tokens || undefined } : undefined);
    if (!streamed(res)) {
        const json = (await res.json()) as { choices: Array<{ message: { content: string; reasoning_content?: string; reasoning?: string } }>; usage?: Record<string, any> };
        const m = json.choices[0]?.message;
        const reasoning = m?.reasoning_content ?? m?.reasoning;
        if (reasoning) onEvent?.({ type: 'thinking', text: reasoning });
        onEvent?.({ type: 'text', text: m?.content ?? '' });
        const usage = usageOf(json.usage);
        if (usage) onEvent?.({ type: 'usage', usage });
        return m?.content ?? '';
    }
    let text = '';
    let usage: LlmUsage | undefined;
    for await (const e of eventsOf(res)) {
        const d = e['choices']?.[0]?.delta ?? {};
        const reasoning = d.reasoning_content ?? d.reasoning;
        if (reasoning) onEvent?.({ type: 'thinking', text: reasoning });
        if (d.content) {
            text += d.content;
            onEvent?.({ type: 'text', text: d.content });
        }
        usage = usageOf(e['usage']) ?? usage;
    }
    if (usage) onEvent?.({ type: 'usage', usage });
    return text;
}

async function readOllama(res: Response, onEvent?: (e: LlmEvent) => void): Promise<string> {
    let text = '';
    const handle = (e: Record<string, any>) => {
        if (e['message']?.thinking) onEvent?.({ type: 'thinking', text: e['message'].thinking });
        if (e['message']?.content) {
            text += e['message'].content;
            onEvent?.({ type: 'text', text: e['message'].content });
        }
        if (e['done']) onEvent?.({ type: 'usage', usage: { input: e['prompt_eval_count'] ?? 0, output: e['eval_count'] ?? 0 } });
    };
    const type = res.headers.get('content-type') ?? '';
    if (/application\/json/.test(type) && !/ndjson/.test(type)) {
        handle({ ...((await res.json()) as Record<string, any>), done: true });
        return text;
    }
    for await (const line of linesOf(res)) {
        if (!line.trim()) continue;
        try {
            handle(JSON.parse(line) as Record<string, any>);
        } catch {
            // not a JSON line
        }
    }
    return text;
}

export type LlmTotals = LlmUsage & { calls: number; cached: number };

/** A provider that adds up the usage of every call made through it (`usage()`, for the report). */
export function metered(provider: LlmProvider): LlmProvider & { usage(): LlmTotals } {
    const totals: LlmTotals = { input: 0, output: 0, calls: 0, cached: 0 };
    return {
        name: provider.name,
        usage: () => ({ ...totals }),
        async complete(system, user, onEvent) {
            totals.calls++;
            return provider.complete(system, user, e => {
                if (e.type === 'usage') {
                    totals.input += e.usage.input;
                    totals.output += e.usage.output;
                    if (e.usage.thinking) totals.thinking = (totals.thinking ?? 0) + e.usage.thinking;
                }
                if (e.type === 'note' && /cached answer/.test(e.text)) totals.cached++;
                onEvent?.(e);
            });
        }
    };
}

/** One line per call, for the server's log: what was asked, the tokens used and how long it took. */
export function logged(provider: LlmProvider, log: (line: string) => void, label = ''): LlmProvider {
    return {
        name: provider.name,
        async complete(system, user, onEvent) {
            const started = Date.now();
            let usage: LlmUsage | undefined;
            let thought = 0;
            let cached = false;
            try {
                return await provider.complete(system, user, e => {
                    if (e.type === 'usage') usage = e.usage;
                    if (e.type === 'thinking') thought += e.text.length;
                    if (e.type === 'note' && /cached answer/.test(e.text)) cached = true;
                    onEvent?.(e);
                });
            } finally {
                const seconds = ((Date.now() - started) / 1000).toFixed(1);
                log(`[llm] ${provider.name}${label ? ` ${label}` : ''}: ${cached ? 'cached answer, no tokens' : usage ? `${usage.input} input + ${usage.output} output tokens${usage.thinking ? ` (${usage.thinking} of them thinking)` : ''}${thought ? `, ${thought} characters of thinking` : ''}` : 'no usage reported'}, ${seconds} s`);
            }
        }
    };
}
