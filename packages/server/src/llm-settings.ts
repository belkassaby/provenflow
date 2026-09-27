/**
 * LLM settings entered in the editor (Help → LLM settings): API keys, models and server addresses.
 * They are kept by this server only: in memory, and in a file readable only by its user when
 * "remember" is chosen. They take precedence over the environment variables (ANTHROPIC_API_KEY,
 * ANTHROPIC_WORKSPACE_ID, OPENAI_API_KEY, OPENAI_BASE_URL, OLLAMA_HOST). Keys are never sent back to the browser.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type LlmKind = 'anthropic' | 'openai' | 'ollama';

export interface LlmSettings {
    /** `workspaceId`: sent as anthropic-workspace-id, for keys not scoped to a workspace. */
    anthropic: { apiKey?: string; model: string; baseUrl?: string; workspaceId?: string };
    openai: { apiKey?: string; model: string; baseUrl?: string };
    ollama: { host?: string; model: string };
    /** Provider offered first in Import code base. */
    preferred?: LlmKind;
    /** Saved to the settings file. */
    remember: boolean;
}

/** What the browser sees: keys masked. */
export interface PublicLlmSettings {
    anthropic: { key?: string; keyFrom?: 'settings' | 'environment'; model: string; baseUrl?: string; workspaceId?: string };
    openai: { key?: string; keyFrom?: 'settings' | 'environment'; model: string; baseUrl?: string };
    ollama: { host: string; model: string };
    preferred?: LlmKind;
    remember: boolean;
    file: string;
    configured: Record<LlmKind, boolean>;
}

export const SETTINGS_FILE = process.env['PROVENFLOW_SETTINGS'] ?? join(homedir(), '.config', 'provenflow', 'llm.json');

const DEFAULTS: LlmSettings = {
    anthropic: { model: 'claude-sonnet-5' },
    openai: { model: 'gpt-4.1' },
    ollama: { model: 'qwen2.5-coder' },
    remember: false
};

export class LlmSettingsStore {
    private settings: LlmSettings = structuredClone(DEFAULTS);

    constructor(
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly file = SETTINGS_FILE
    ) {}

    /** Loads the remembered settings, if any. */
    async load(): Promise<void> {
        try {
            const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LlmSettings>;
            this.settings = merge(DEFAULTS, { ...saved, remember: true });
        } catch {
            // No saved settings.
        }
    }

    /** Environment for the providers: the settings, then the server's own environment. */
    providerEnv(): NodeJS.ProcessEnv {
        const s = this.settings;
        return {
            ...this.env,
            ...(s.anthropic.apiKey ? { ANTHROPIC_API_KEY: s.anthropic.apiKey } : {}),
            ...(s.anthropic.baseUrl ? { ANTHROPIC_BASE_URL: s.anthropic.baseUrl } : {}),
            ...(s.anthropic.workspaceId ? { ANTHROPIC_WORKSPACE_ID: s.anthropic.workspaceId } : {}),
            ...(s.openai.apiKey ? { OPENAI_API_KEY: s.openai.apiKey } : {}),
            ...(s.openai.baseUrl ? { OPENAI_BASE_URL: s.openai.baseUrl } : {}),
            ...(s.ollama.host ? { OLLAMA_HOST: s.ollama.host } : {})
        };
    }

    configured(): Record<LlmKind, boolean> {
        const env = this.providerEnv();
        return { anthropic: !!env['ANTHROPIC_API_KEY'], openai: !!env['OPENAI_API_KEY'] || !!env['OPENAI_BASE_URL'], ollama: true };
    }

    /** `anthropic:<model>` for a provider, with the model chosen in the settings. */
    spec(kind: LlmKind): string {
        return `${kind}:${this.settings[kind].model}`;
    }

    public(): PublicLlmSettings {
        const s = this.settings;
        const key = (own: string | undefined, envName: string) =>
            own ? { key: mask(own), keyFrom: 'settings' as const } : this.env[envName] ? { key: mask(this.env[envName]!), keyFrom: 'environment' as const } : {};
        return {
            anthropic: { ...key(s.anthropic.apiKey, 'ANTHROPIC_API_KEY'), model: s.anthropic.model, baseUrl: s.anthropic.baseUrl ?? this.env['ANTHROPIC_BASE_URL'], workspaceId: s.anthropic.workspaceId ?? this.env['ANTHROPIC_WORKSPACE_ID'] },
            openai: { ...key(s.openai.apiKey, 'OPENAI_API_KEY'), model: s.openai.model, baseUrl: s.openai.baseUrl ?? this.env['OPENAI_BASE_URL'] },
            ollama: { host: s.ollama.host ?? this.env['OLLAMA_HOST'] ?? 'http://localhost:11434', model: s.ollama.model },
            preferred: s.preferred,
            remember: s.remember,
            file: this.file,
            configured: this.configured()
        };
    }

    /**
     * Updates the settings. A key left empty keeps the current one; `clearKeys` removes the keys
     * stored here (environment variables still apply).
     */
    async update(input: UpdateInput): Promise<void> {
        const s = this.settings;
        const text = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
        const url = (v: unknown) => {
            const u = text(v);
            if (u === undefined || u === '') return u === '' ? '' : undefined;
            if (!/^https?:\/\/[^\s]+$/.test(u)) throw new Error(`Not an http(s) address: ${u}`);
            return u.replace(/\/+$/, '');
        };
        const model = (v: unknown, fallback: string) => {
            const m = text(v, 200);
            if (m && !/^[\w.:/-]+$/.test(m)) throw new Error(`Not a model name: ${m}`);
            return m || fallback;
        };
        for (const kind of ['anthropic', 'openai'] as const) {
            const i = input[kind] ?? {};
            const key = apiKey(kind, text(i.apiKey, 1000));
            if (i.clearKey) delete s[kind].apiKey;
            else if (key) s[kind].apiKey = key;
            s[kind].model = model(i.model, s[kind].model);
            const base = url(i.baseUrl);
            if (base === '') delete s[kind].baseUrl;
            else if (base) s[kind].baseUrl = base;
        }
        const workspace = text(input.anthropic?.workspaceId, 200);
        if (workspace === '') delete s.anthropic.workspaceId;
        else if (workspace) {
            if (!/^[\w-]+$/.test(workspace)) throw new Error(`Not a workspace ID: ${workspace}`);
            s.anthropic.workspaceId = workspace;
        }
        const o = input.ollama ?? {};
        const host = url(o.host);
        if (host === '') delete s.ollama.host;
        else if (host) s.ollama.host = host;
        s.ollama.model = model(o.model, s.ollama.model);
        if (input.preferred === null || input.preferred === '') delete s.preferred;
        else if (input.preferred === 'anthropic' || input.preferred === 'openai' || input.preferred === 'ollama') s.preferred = input.preferred;
        if (typeof input.remember === 'boolean') s.remember = input.remember;
        await this.persist();
    }

    private async persist(): Promise<void> {
        if (!this.settings.remember) {
            await rm(this.file, { force: true });
            return;
        }
        const { remember: _remember, ...saved } = this.settings;
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        await writeFile(this.file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
        await chmod(this.file, 0o600);
    }
}

export interface UpdateInput {
    anthropic?: { apiKey?: unknown; clearKey?: unknown; model?: unknown; baseUrl?: unknown; workspaceId?: unknown };
    openai?: { apiKey?: unknown; clearKey?: unknown; model?: unknown; baseUrl?: unknown };
    ollama?: { host?: unknown; model?: unknown };
    preferred?: unknown;
    remember?: unknown;
}

/**
 * The key as the provider expects it: surrounding quotes are dropped, and a key pasted inside
 * other text (a JSON snippet, `ANTHROPIC_API_KEY=...`) is taken out of it. Anything else that is
 * not a key is refused here, rather than by the provider with an HTTP 401.
 */
export function apiKey(kind: 'anthropic' | 'openai', value: string | undefined): string | undefined {
    if (!value) return value;
    const bare = value.replace(/^["'`]+|["'`]+$/g, '');
    if (kind === 'anthropic') {
        if (/^sk-ant-[\w-]+$/.test(bare)) return bare;
        const inside = value.match(/sk-ant-[\w-]{20,}/g);
        if (inside?.length === 1) return inside[0];
        throw new Error('That is not an Anthropic API key: a key starts with sk-ant- and has no spaces, quotes or braces. Copy it from the Claude Console (Settings → API keys).');
    }
    if (/^[^\s"'{}]+$/.test(bare)) return bare;
    const inside = value.match(/sk-[\w-]{20,}/g);
    if (inside?.length === 1) return inside[0];
    throw new Error('That does not look like an API key: it has spaces, quotes or braces. Paste the key alone.');
}

function mask(key: string): string {
    return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function merge(base: LlmSettings, saved: Partial<LlmSettings>): LlmSettings {
    return {
        anthropic: { ...base.anthropic, ...(saved.anthropic ?? {}) },
        openai: { ...base.openai, ...(saved.openai ?? {}) },
        ollama: { ...base.ollama, ...(saved.ollama ?? {}) },
        preferred: saved.preferred,
        remember: saved.remember ?? false
    };
}
