/** What an LLM call reports while it runs. */
export type LlmEvent =
    | { type: 'thinking'; text: string }
    | { type: 'text'; text: string }
    | { type: 'usage'; usage: LlmUsage }
    | { type: 'note'; text: string };

export interface LlmUsage {
    input: number;
    output: number;
    /** Output tokens spent thinking, when the provider says. */
    thinking?: number;
    cacheRead?: number;
}

export interface LlmProvider {
    /** e.g. `anthropic:claude-sonnet-5`. */
    name: string;
    /** The answer; `onEvent` follows the thinking, the answer and the usage as they arrive. */
    complete(system: string, user: string, onEvent?: (e: LlmEvent) => void): Promise<string>;
}

export type Fetch = typeof fetch;
