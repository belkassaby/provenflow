/**
 * `pflow mcp`: ProvenFlow as an MCP server (stdio, JSON-RPC 2.0, one message per line), so a coding
 * agent runs the same checks as CI before it opens a pull request:
 *
 * - `project_conventions`: what the code base expects (layers and what each may import, naming per
 *   language, complexity and size limits, patterns) — context to read before writing code;
 * - `find_existing_code`: functions of the project similar to a snippet the agent is about to
 *   write — so that it reuses a helper instead of re-implementing it;
 * - `review_changes`: the findings on the lines changed since a revision (default HEAD: the
 *   uncommitted work), with their fixes;
 * - `propose_fix`: the analysis's own verified fix for one finding, as a diff.
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { changeContext, extractProject, fixWithoutLlm, formatFindings, functionLabel, limitsFor, projectReader, qualitySection, runReview, similarToSnippet, STANDARDS, type ExtractionResult } from '@provenflow/extract';

interface Tool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    run: (args: Record<string, unknown>) => Promise<string>;
}

const path = (args: Record<string, unknown>) => resolve(typeof args['path'] === 'string' ? args['path'] : process.cwd());
const quick = { analyzers: false, confirm: false, quickFixes: 0, llmFixes: 0 } as const;

const TOOLS: Tool[] = [
    {
        name: 'project_conventions',
        description: 'The conventions this code base is checked against: layers and what each may import, naming styles per language, complexity and size limits, declared design patterns. Read it before writing code.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project folder (default: the current directory).' } } },
        run: async args => conventions(await extractProject(path(args), quick))
    },
    {
        name: 'find_existing_code',
        description: 'Functions of the project similar to a code snippet (shared tokens): call it before writing a helper, to reuse one that exists instead of duplicating it.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string', description: 'The function or snippet about to be written.' }, language: { type: 'string', description: 'File extension of the snippet, e.g. ts, py.' } }, required: ['code'] },
        run: async args => {
            const result = await extractProject(path(args), quick);
            const matches = similarToSnippet(result.facts.functions, projectReader(result.root), String(args['code'] ?? ''), `snippet.${String(args['language'] ?? 'ts')}`);
            if (!matches.length) return 'No similar function in the project (none shares half of its tokens with the snippet).';
            return matches.map(m => `${Math.round(m.similarity * 100)}% ${functionLabel(m.fn)} (${m.fn.loc.file}:${m.fn.loc.line}, ${m.fn.lines} lines)`).join('\n');
        }
    },
    {
        name: 'review_changes',
        description: 'ProvenFlow review of the lines changed since a git revision (default HEAD: uncommitted work): duplicated code, complexity, naming, dependencies, state machines, resource leaks, layers, patterns. Each finding has a fix. Fix the errors and warnings before committing.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, base: { type: 'string', description: 'Git revision to compare with (default HEAD).' }, files: { type: 'boolean', description: 'Report on the whole changed files, not only the changed lines.' }, analyzers: { type: 'boolean', description: 'Also run the installed analysers (Semgrep, Infer...): slower.' } } },
        run: async args => {
            const run = await runReview(path(args), { ...quick, analyzers: args['analyzers'] === true, base: typeof args['base'] === 'string' ? args['base'] : 'HEAD', scope: args['files'] === true ? 'files' : 'lines', failOn: 'warning' });
            const head = run.relevant.length ? `${run.relevant.length} finding(s) on the changed code (${run.failing.length} to fix before committing):` : 'No finding on the changed code.';
            return [head, ...run.extras, '', formatFindings({ ...run.result, findings: run.relevant })].join('\n').trim();
        }
    },
    {
        name: 'propose_fix',
        description: 'The verified automatic fix ProvenFlow can make for one finding (from review_changes), as a diff; or a draft saying where the code has to change.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, rule: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' } }, required: ['rule', 'file'] },
        run: async args => {
            const root = path(args);
            const ctx = await changeContext(root, quick);
            const findings = ctx.baseline.findings.filter(f => f.rule === args['rule'] && f.loc?.file === args['file']);
            const finding = findings.sort((a, b) => Math.abs((a.loc?.line ?? 0) - Number(args['line'] ?? 0)) - Math.abs((b.loc?.line ?? 0) - Number(args['line'] ?? 0)))[0];
            if (!finding) return `No ${String(args['rule'])} finding in ${String(args['file'])}.`;
            const change = await fixWithoutLlm(ctx, finding, quick);
            if (change.error || !change.finding.suggestedPatch) return change.error ?? 'No change proposed.';
            const p = change.finding.suggestedPatch;
            return `${p.verified ? 'Verified' : 'Not verified'} (${p.by ?? 'quick fix'}): ${p.note}\n\n${p.diff}`;
        }
    }
];

function conventions(result: ExtractionResult): string {
    const config = result.config;
    const out: string[] = ['# Conventions of this code base', ''];
    if (config.layers?.length) {
        out.push('## Layers (an import outside these rules fails the check)', '');
        for (const l of config.layers) out.push(`- ${l.name} (${l.paths.join(', ')}): may import ${l.mayImport?.length ? l.mayImport.join(', ') : 'no other layer'}${l.style ? `; ${l.style} style` : ''}`);
        out.push('');
    }
    const languages = [...new Set(result.facts.modules.filter(m => !m.isTest).map(m => m.language))];
    out.push('## Per language', '');
    for (const language of languages) {
        const s = STANDARDS[language];
        const limits = limitsFor(config, language);
        const naming = result.quality.conventions.filter(c => c.language === language).map(c => `${c.kind} ${c.style}`);
        const complexity = config.languages?.[language]?.complexity ?? (config.complexity || undefined) ?? s.limits;
        out.push(`- ${language}: naming ${naming.join(', ') || 'see the style guide'} (${s.guide}); functions up to ${limits.functionLines} lines and ${limits.functionParams} parameters; Cognitive Complexity up to ${complexity.cognitive ?? s.limits.cognitive}, nesting up to ${complexity.nesting ?? s.limits.nesting}.`);
    }
    out.push('', '## Duplication', '', 'No copied block of 10 lines or more, and no function re-implementing an existing one: search with find_existing_code before writing a helper.', '');
    if (config.patterns?.length) {
        out.push('## Declared design patterns', '');
        for (const p of config.patterns) out.push(`- ${p.subject}: ${p.pattern}`);
        out.push('');
    }
    out.push(qualitySection(result));
    return out.join('\n');
}

export async function serveMcp(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
    const lines = createInterface({ input });
    for await (const line of lines) {
        if (!line.trim()) continue;
        let request: { id?: number | string; method?: string; params?: Record<string, unknown> };
        try {
            request = JSON.parse(line);
        } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            continue;
        }
        const reply = await handle(request.method ?? '', request.params ?? {});
        if (request.id === undefined) continue; // a notification
        send(reply.error ? { jsonrpc: '2.0', id: request.id, error: reply.error } : { jsonrpc: '2.0', id: request.id, result: reply.result });
    }
}

async function handle(method: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    switch (method) {
        case 'initialize':
            return {
                result: {
                    protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'provenflow', version: '0.1.0' },
                    instructions: 'Call project_conventions before writing code, find_existing_code before writing a helper, and review_changes before committing; fix its errors and warnings.'
                }
            };
        case 'ping':
            return { result: {} };
        case 'tools/list':
            return { result: { tools: TOOLS.map(({ run: _run, ...t }) => t) } };
        case 'tools/call': {
            const tool = TOOLS.find(t => t.name === params['name']);
            if (!tool) return { error: { code: -32602, message: `Unknown tool ${String(params['name'])}` } };
            try {
                const text = await tool.run((params['arguments'] as Record<string, unknown>) ?? {});
                return { result: { content: [{ type: 'text', text }] } };
            } catch (error) {
                return { result: { content: [{ type: 'text', text: (error as Error).message }], isError: true } };
            }
        }
        default:
            return method.startsWith('notifications/') ? {} : { error: { code: -32601, message: `Method not found: ${method}` } };
    }
}

