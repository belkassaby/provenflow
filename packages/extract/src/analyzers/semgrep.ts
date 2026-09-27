/**
 * Semgrep: security and dataflow (taint) rules for 30+ languages. ProvenFlow's bundled rules always
 * run (offline, reproducible); registry packs or rule folders can be added in the config.
 * Semgrep's own autofixes become proposed changes, verified like the quick fixes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, Severity } from '../models.js';
import { findTool, run, toolVersion } from '../tools/process.js';
import { emptyOutput, loc, option, type AnalyzerContext, type AnalyzerOutput } from './types.js';

export const BUNDLED_RULES = fileURLToPath(new URL('../../rules/semgrep', import.meta.url));

interface SemgrepResult {
    check_id: string;
    path: string;
    start: { line: number; offset: number };
    end: { line: number; offset: number };
    extra: {
        message: string;
        severity: string;
        fix?: string;
        metadata?: { cwe?: string | string[]; fix?: string };
        dataflow_trace?: { taint_source?: unknown; intermediate_vars?: Array<{ location?: { path?: string; start?: { line?: number } } }> };
    };
}

export async function semgrep(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = emptyOutput();
    const { on, options } = option(ctx.config.analyzers?.semgrep, true);
    if (!on) return out;
    const exe = findTool('semgrep', ctx.env);
    if (!exe) {
        out.notes.push('Semgrep is not installed (brew install semgrep or pip install semgrep, or set SEMGREP_PATH): security and dataflow rules were not run.');
        return out;
    }
    const configs = [...(options.bundled === false ? [] : [BUNDLED_RULES]), ...(options.config ?? [])];
    const excludes = ['node_modules', 'dist', 'out', 'build', '.angular', 'vendor', 'target', ...(ctx.config.exclude ?? [])];
    const args = ['scan', '--json', '--metrics=off', '--disable-version-check', '--quiet', '--no-git-ignore', '--project-root', '.', '--timeout', '30', ...configs.flatMap(c => ['--config', c]), ...excludes.flatMap(e => ['--exclude', e]), ...(ctx.onlyFiles ?? ['.'])];
    const r = await run(exe, args, { cwd: ctx.dir, timeoutMs: 600_000, env: { SEMGREP_SEND_METRICS: 'off' } });
    let json: { results?: SemgrepResult[]; errors?: Array<{ message?: string; type?: unknown; path?: string; spans?: Array<{ start?: { line?: number } }> }> };
    try {
        json = JSON.parse(r.stdout);
    } catch {
        out.notes.push(`Semgrep failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
        out.ran.push({ tool: 'Semgrep', ms: r.ms, scope: configs.join(', '), ok: false });
        return out;
    }
    out.ran.push({ tool: 'Semgrep', version: toolVersion(exe), ms: r.ms, scope: `${configs.map(c => (c === BUNDLED_RULES ? 'bundled rules' : c)).join(', ')}`, ok: true });
    const unparsed = (json.errors ?? []).filter(e => /syntax|pars/i.test(JSON.stringify(e.type ?? e.message ?? '')) && e.path);
    if (unparsed.length > 0) out.notes.push(`Semgrep could not fully parse ${unparsed.length} file(s) (${unparsed.slice(0, 3).map(e => `${e.path}${e.spans?.[0]?.start?.line ? `:${e.spans[0].start.line}` : ''}`).join(', ')}): the rest of each file was checked.`);
    for (const e of (json.errors ?? []).filter(e => !unparsed.includes(e)).slice(0, 3)) if (e.message) out.notes.push(`Semgrep: ${e.message.split('\n')[0]}`);
    for (const res of json.results ?? []) {
        const id = res.check_id.replace(/^.*\./, '');
        const severity: Severity = res.extra.severity === 'ERROR' ? 'error' : res.extra.severity === 'INFO' ? 'info' : 'warning';
        const cwe = Array.isArray(res.extra.metadata?.cwe) ? res.extra.metadata.cwe[0] : res.extra.metadata?.cwe;
        const trace = (res.extra.dataflow_trace?.intermediate_vars ?? []).map(v => loc(v.location?.path ?? res.path, v.location?.start?.line));
        const source = (res.extra.dataflow_trace?.taint_source as { location?: { path?: string; start?: { line?: number } } } | [string, { location?: { path?: string; start?: { line?: number } } }] | undefined);
        const sourceLoc = Array.isArray(source) ? source[1]?.location : source?.location;
        const finding: Finding = {
            rule: `semgrep:${id}`,
            category: 'security',
            severity,
            subject: cwe ?? id,
            message: `${res.extra.message}${sourceLoc ? ` The data comes from ${sourceLoc.path ?? res.path}:${sourceLoc.start?.line}.` : ''}`,
            fix: res.extra.metadata?.fix ?? (res.extra.fix ? `Semgrep proposes: ${res.extra.fix}` : 'See the rule.'),
            loc: loc(res.path, res.start.line),
            related: [...(sourceLoc ? [loc(sourceLoc.path ?? res.path, sourceLoc.start?.line)] : []), ...trace],
            source: 'semgrep'
        };
        out.findings.push(finding);
        if (res.extra.fix !== undefined) {
            try {
                const text = readFileSync(join(ctx.dir, res.path), 'utf8');
                const lineStart = text.lastIndexOf('\n', res.start.offset - 1) + 1;
                const lineEnd = text.indexOf('\n', res.end.offset);
                const end = lineEnd < 0 ? text.length : lineEnd;
                const search = text.slice(lineStart, end);
                const replace = text.slice(lineStart, res.start.offset) + res.extra.fix + text.slice(res.end.offset, end);
                if (search !== replace) out.fixes.push({ finding, file: res.path, search, replace, explanation: `Semgrep's fix for ${id}.` });
            } catch {
                // file not readable: no fix
            }
        }
    }
    return out;
}
