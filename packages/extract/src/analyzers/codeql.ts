/**
 * CodeQL: GitHub's dataflow/taint security queries. Opt-in (analyzers.codeql: true) because building
 * the databases takes minutes; uses build-mode none where the language allows it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Language } from '../ir.js';
import { findTool, run, toolVersion } from '../tools/process.js';
import { sarifToFindings } from './sarif.js';
import { emptyOutput, option, type AnalyzerContext, type AnalyzerOutput } from './types.js';

const CODEQL_LANGUAGE: Partial<Record<Language, string>> = {
    typescript: 'javascript-typescript',
    python: 'python',
    java: 'java-kotlin',
    kotlin: 'java-kotlin',
    c_sharp: 'csharp',
    go: 'go',
    ruby: 'ruby',
    swift: 'swift',
    c: 'c-cpp',
    cpp: 'c-cpp',
    rust: 'rust'
};

export async function codeql(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = emptyOutput();
    const { on, options } = option(ctx.config.analyzers?.codeql, false);
    if (!on || ctx.onlyFiles) return out; // too slow to re-run for each proposed change
    const exe = findTool('codeql', ctx.env);
    if (!exe) {
        out.notes.push('CodeQL is enabled but not installed (github.com/github/codeql-action releases, or set CODEQL_PATH).');
        return out;
    }
    const languages = [...new Set(ctx.facts.modules.filter(m => !m.isTest).map(m => CODEQL_LANGUAGE[m.language]).filter((x): x is string => !!x))];
    const work = mkdtempSync(join(tmpdir(), 'provenflow-codeql-'));
    try {
        for (const language of languages) {
            const db = join(work, `db-${language}`);
            const started = Date.now();
            const create = await run(exe, ['database', 'create', db, `--language=${language}`, `--source-root=${ctx.dir}`, '--overwrite', ...(['c-cpp', 'swift', 'go'].includes(language) ? [] : ['--build-mode=none'])], { cwd: ctx.dir, timeoutMs: 1_800_000 });
            if (create.code !== 0) {
                out.notes.push(`CodeQL could not build the ${language} database: ${create.stderr.trim().split('\n').slice(-1)[0]}`);
                continue;
            }
            const sarif = join(work, `${language}.sarif`);
            const pack = `codeql/${language.split('-')[0]}-queries`;
            await run(exe, ['database', 'analyze', db, options.suite ?? pack, '--format=sarif-latest', `--output=${sarif}`, '--download'], { cwd: ctx.dir, timeoutMs: 1_800_000 });
            try {
                out.findings.push(...sarifToFindings(JSON.parse(readFileSync(sarif, 'utf8')), ctx.dir, 'codeql'));
                out.ran.push({ tool: 'CodeQL', version: toolVersion(exe), ms: Date.now() - started, scope: `${language} (${options.suite ?? pack})`, ok: true });
            } catch {
                out.notes.push(`CodeQL produced no results for ${language}.`);
            }
        }
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
    return out;
}
