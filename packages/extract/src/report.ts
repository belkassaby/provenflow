/**
 * Outputs of `pflow extract`: the models (.pflow, open them in the editor),
 * a Markdown report for people, JSON for tools, SARIF for code scanning
 * (GitHub shows the findings on the pull request), GitLab Code Quality and
 * reviewdog's rdjson for other CI systems, and a test scenario for each
 * counterexample, to confirm the bug on the real code.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ExtractionResult } from './project.js';
import { formatLocation } from './ir.js';
import { modelToPflow, slug, type Finding } from './models.js';
import { codeQuality, rdjson, sarif } from './report-formats.js';
import { scenarioFor } from './scenarios.js';
import { trendTable, type HistoryEntry } from './history.js';

export { codeQuality, fingerprint, rdjson, sarif } from './report-formats.js';

export interface WrittenFiles {
    dir: string;
    models: string[];
    scenarios: string[];
    /** The scenarios that are skeletons to fill in (the others drive the real code). */
    skeletons: string[];
    /** One folder per proposed change: the changed files and change.patch. */
    fixes: string[];
    report: string;
}

/** Writes the outputs of a run; `history` (this code base's earlier runs and this one) adds a section of trends to report.md. */
export function writeOutputs(result: ExtractionResult, dir: string, history: HistoryEntry[] = []): WrittenFiles {
    mkdirSync(join(dir, 'models'), { recursive: true });
    const models = result.models.map(m => {
        const file = join('models', `${m.id}.pflow`);
        writeFileSync(join(dir, file), modelToPflow(m));
        return file;
    });
    const scenarios: string[] = [];
    const skeletons: string[] = [];
    const withTrace = result.findings.filter(f => f.counterexample && f.counterexample.length > 1 && f.category !== 'architecture');
    if (withTrace.length > 0) mkdirSync(join(dir, 'scenarios'), { recursive: true });
    const context = { models: result.models, facts: result.facts, root: resolve(result.root), folder: resolve(dir, 'scenarios') };
    withTrace.forEach((f, i) => {
        const python = f.loc?.file.endsWith('.py');
        const base = slug(`${f.model ?? 'finding'}-${f.rule}-${i + 1}`).replace(/[-.]/g, '_');
        const file = join('scenarios', python ? `test_${base}.py` : `${base}.test.ts`);
        const scenario = scenarioFor(f, context);
        writeFileSync(join(dir, file), scenario.text);
        scenarios.push(file);
        if (!scenario.runnable) skeletons.push(file);
    });
    const fixes: string[] = [];
    result.findings.filter(f => f.suggestedPatch?.files?.length).forEach((f, i) => {
        const folder = join('fixes', `${String(i + 1).padStart(2, '0')}-${slug(f.rule)}${f.suggestedPatch!.verified ? '' : '-not-verified'}`);
        for (const pf of f.suggestedPatch!.files!) {
            mkdirSync(dirname(join(dir, folder, pf.file)), { recursive: true });
            writeFileSync(join(dir, folder, pf.file), pf.after);
        }
        writeFileSync(join(dir, folder, 'change.patch'), f.suggestedPatch!.diff);
        fixes.push(folder);
    });
    writeFileSync(join(dir, 'report.md'), markdownReport(result, models, scenarios, skeletons, history));
    writeFileSync(join(dir, 'report.json'), JSON.stringify(jsonReport(result), null, 2));
    writeFileSync(join(dir, 'report.sarif'), JSON.stringify(sarif(result), null, 2));
    writeFileSync(join(dir, 'report.codequality.json'), JSON.stringify(codeQuality(result), null, 2));
    writeFileSync(join(dir, 'report.rdjson'), JSON.stringify(rdjson(result), null, 2));
    return { dir, models, scenarios, skeletons, fixes, report: join(dir, 'report.md') };
}

export function summary(result: ExtractionResult): { error: number; warning: number; info: number } {
    const count = (s: Finding['severity']) => result.findings.filter(f => f.severity === s).length;
    return { error: count('error'), warning: count('warning'), info: count('info') };
}

/** Terminal output: one block per finding. */
export function formatFindings(result: ExtractionResult, minimum: Finding['severity'] = 'info'): string {
    const order = { error: 0, warning: 1, info: 2 };
    const lines: string[] = [];
    for (const f of result.findings.filter(x => order[x.severity] <= order[minimum])) {
        lines.push(`${f.loc ? formatLocation(f.loc) : '-'}: ${f.severity} [${f.rule}] ${f.message}`);
        lines.push(`    fix: ${f.fix}`);
        if (f.confirmation) lines.push(`    on the code (${f.confirmation.by}): ${f.confirmation.status}: ${f.confirmation.detail}`);
        if (f.suggestedPatch) lines.push(`    patch (${f.suggestedPatch.verified ? 'verified' : 'not verified'}): ${f.suggestedPatch.note}`);
    }
    return lines.join('\n');
}

function markdownReport(result: ExtractionResult, models: string[], scenarios: string[], skeletons: string[] = [], history: HistoryEntry[] = []): string {
    return [header(result), ...findingSections(result), patternsSection(result), qualitySection(result), trendsSection(history), proofsSection(result), paradigmSection(result), dependenciesSection(result), modelsSection(result, models), scenariosSection(scenarios, skeletons), llmSection(result), notesSection(result)]
        .filter(Boolean)
        .join('\n');
}

function header(result: ExtractionResult): string {
    const s = summary(result);
    const out: string[] = [`# ProvenFlow code model report`, ''];
    out.push(`${result.files} files, ${result.models.length} models (${count(result, 'state-machine')} state machines, ${count(result, 'lifecycle')} resource lifecycles, ${count(result, 'pattern')} pattern contracts${count(result, 'architecture') ? ', 1 architecture' : ''}), ${result.verdicts.length} properties checked with ${result.checkedWith === 'nuxmv' ? 'nuXmv' : 'the explicit-state checker (set NUXMV_PATH to use nuXmv)'}.`, '');
    out.push(`**${s.error} errors, ${s.warning} warnings, ${s.info} notes.**`, '');
    if (result.llm) out.push(`LLM (${result.llm.provider}): ${result.llm.accepted.length} proposals accepted after verification, ${result.llm.rejected.length} rejected; ${result.llm.usage.calls} call(s), ${result.llm.usage.input} input + ${result.llm.usage.output} output tokens${result.llm.usage.cached ? ` (${result.llm.usage.cached} answered from the cache)` : ''}.`, '');
    if (result.tools.length > 0) out.push(`Analysers: ${result.tools.map(t => `${t.tool}${t.version ? ` ${t.version}` : ''} (${t.scope})`).join('; ')}.`, '');
    if (result.changeChecks.length > 0) out.push(`Proposed changes were also checked with: ${result.changeChecks.map(c => `\`${c}\``).join(', ')}.`, '');
    return out.join('\n');
}

export const CATEGORY_TITLES: Array<[Finding['category'], string]> = [
    ['security', 'Security and dataflow'],
    ['memory', 'Memory safety and arithmetic'],
    ['heap', 'Heap (interprocedural)'],
    ['build', 'Build and tests'],
    ['dependencies', 'Dependencies'],
    ['state-machine', 'State machines'],
    ['lifecycle', 'Resource lifecycles'],
    ['pattern', 'Design patterns'],
    ['architecture', 'Architecture'],
    ['duplication', 'Duplicated code'],
    ['complexity', 'Complexity'],
    ['tests', 'Tests and coverage'],
    ['paradigm', 'Paradigm and size'],
    ['practice', 'Practices and anti-patterns'],
    ['naming', 'Naming']
];

const TOOL_CATEGORIES = new Set<Finding['category']>(['security', 'memory', 'heap', 'build']);
const QUIET_CATEGORIES = new Set<Finding['category']>(['dependencies', 'duplication', 'complexity', 'tests', 'naming', 'practice']);

function findingSections(result: ExtractionResult): string[] {
    const sections: string[] = [];
    for (const [category, title] of CATEGORY_TITLES) {
        const list = result.findings.filter(f => f.category === category);
        if (list.length === 0 && ((TOOL_CATEGORIES.has(category) && result.tools.length === 0) || QUIET_CATEGORIES.has(category))) continue;
        const out = [`## ${title} (${list.length})`, ''];
        if (list.length === 0) out.push('No findings.', '');
        for (const f of list) out.push(...findingBlock(f));
        sections.push(out.join('\n'));
    }
    return sections;
}

function findingBlock(f: Finding): string[] {
    const out: string[] = [`### ${icon(f.severity)} ${f.rule}: ${f.subject}`, ''];
    out.push(`${f.loc ? `\`${formatLocation(f.loc)}\` · ` : ''}${f.severity} · ${sourceLabel(f.source)}${f.model ? ` · model \`models/${f.model}.pflow\`` : ''}`, '');
    out.push(f.message, '', `**Fix:** ${f.fix}`, '');
    if (f.spec) out.push(`Property: \`${f.spec}\``, '');
    if (f.confirmation) out.push(`**On the code** (${f.confirmation.by}, ${f.confirmation.status}): ${f.confirmation.detail}`, '');
    return [...out, ...counterexampleTable(f), ...patchBlock(f)];
}

function counterexampleTable(f: Finding): string[] {
    if (!f.counterexample || f.counterexample.length <= 1) return [];
    const step = (c: NonNullable<Finding['counterexample']>[number]) => (c.event ? `${c.event}${c.loc ? ` (\`${formatLocation(c.loc)}\`)` : ''}` : 'start');
    return ['| step | state | code |', '| --- | --- | --- |', ...f.counterexample.map((c, i) => `| ${i} | ${c.state} | ${step(c)} |`), ''];
}

function patchBlock(f: Finding): string[] {
    const p = f.suggestedPatch;
    if (!p) return [];
    const out = [`**Suggested change** (${p.by ?? 'LLM'}, ${p.verified ? '✓ verified' : '✗ not verified'}): ${p.note}`, '', '```diff', p.diff.trim(), '```', ''];
    if (p.checks?.length) out.push(`Checks on the changed copy: ${p.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join(', ')}`, '');
    return out;
}

function patternsSection(result: ExtractionResult): string {
    const out = ['## Patterns found', ''];
    if (result.patterns.length === 0) out.push('None.', '');
    else {
        out.push('| pattern | subject | evidence | recognised | contract model |', '| --- | --- | --- | --- | --- |');
        for (const p of result.patterns) out.push(`| ${p.pattern} | ${p.subject} (\`${formatLocation(p.loc)}\`) | ${p.evidence} | ${p.confidence ?? '-'} | ${p.model ? `\`models/${p.model}.pflow\`` : '-'} |`);
        out.push('');
    }
    return out.join('\n');
}

/** Duplication, complexity, size, naming, dependency and coverage measures. */
export function qualitySection(result: Pick<ExtractionResult, 'quality'>): string {
    const m = result.quality?.metrics;
    if (!m) return '';
    const out = ['## Code quality', ''];
    out.push('| measure | value |', '| --- | --- |');
    out.push(`| source files / lines of code | ${m.files} / ${m.codeLines} |`);
    out.push(`| test files / lines of test code | ${m.testFiles} / ${m.testCodeLines} |`);
    out.push(`| functions | ${m.functions} (mean ${m.size.meanFunctionLines} lines) |`);
    out.push(`| duplicated lines | ${m.duplication.duplicatedLines} (${m.duplication.percent}%), in ${m.duplication.clones} clone(s) |`);
    out.push(`| similar functions (probable re-implementations) | ${m.duplication.similarFunctions} |`);
    out.push(`| Cognitive Complexity per function | mean ${m.complexity.mean}, 90th percentile ${m.complexity.p90}, max ${m.complexity.max} |`);
    out.push(`| functions over the complexity limit | ${m.complexity.overLimit} |`);
    out.push(`| functions nested too deeply | ${m.complexity.deepNesting} (deepest ${m.complexity.maxNesting}) |`);
    out.push(`| long functions / many parameters | ${m.size.longFunctions} / ${m.size.manyParameters} |`);
    out.push(`| names off convention | ${m.naming.inconsistent} of ${m.naming.checked} |`);
    out.push(`| unknown / undeclared dependencies | ${m.dependencies.unknown} / ${m.dependencies.undeclared} |`);
    if (m.coverage) out.push(`| line coverage | ${m.coverage.percent}% (${m.coverage.covered} of ${m.coverage.total} lines) |`);
    out.push('');
    out.push(...hotspotsTable(m));
    const conventions = result.quality.conventions.filter(c => c.names > 0);
    if (conventions.length) {
        out.push('Naming conventions applied (from the config, the project itself, or the language\'s style guide):', '', '| language | kind | style | from | names fitting |', '| --- | --- | --- | --- | --- |');
        for (const c of conventions) out.push(`| ${c.language} | ${c.kind} | ${c.style} | ${c.from} | ${c.fitting} of ${c.names} |`);
        out.push('');
    }
    return out.join('\n');
}

function proofsSection(result: ExtractionResult): string {
    if (result.proofs.length === 0) return '';
    const out = ['## Proofs about the code', '', 'Each function model checked for every input, loops unwound up to the bound.', '', '| function | property | tool | bound | result |', '| --- | --- | --- | --- | --- |'];
    for (const p of result.proofs) out.push(`| ${p.subject}${p.loc ? ` (\`${formatLocation(p.loc)}\`)` : ''} | ${p.property} | ${p.tool} | ${p.bound ?? '-'} | ${p.status}${p.detail ? `: ${p.detail.replace(/\|/g, '\\|')}` : ''} |`);
    out.push('');
    return out.join('\n');
}

function paradigmSection(result: ExtractionResult): string {
    const out = ['## Paradigm', ''];
    out.push('| part | declared | detected | files | classes | methods | free functions | pure | higher-order | mutations/100 lines | mutable globals |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const p of result.paradigm) out.push(`| ${p.part} | ${p.declared ?? '-'} | ${p.detected} | ${p.files} | ${p.classes} | ${p.methods} | ${p.freeFunctions} | ${p.pureFunctions} | ${p.higherOrderFunctions} | ${p.mutationDensity} | ${p.mutableGlobals} |`);
    out.push('');
    return out.join('\n');
}

function dependenciesSection(result: ExtractionResult): string {
    if (result.architecture.edges.length === 0) return '';
    const out = ['## Dependencies between parts', '', '| from | to | imports | example |', '| --- | --- | --- | --- |'];
    for (const e of result.architecture.edges) out.push(`| ${e.from} | ${e.to} | ${e.count}${e.typeOnly ? ' (types)' : ''} | \`${formatLocation(e.example)}\` |`);
    out.push('');
    return out.join('\n');
}

function modelsSection(result: ExtractionResult, models: string[]): string {
    const out = ['## Models', '', 'Open any of them in the ProvenFlow editor (Open .pflow) to see the diagram and replay counterexamples.', ''];
    out.push('| model | properties | false |', '| --- | --- | --- |');
    for (const m of result.models) {
        const verdicts = result.verdicts.filter(v => v.model === m.id);
        out.push(`| \`${models.find(x => x.includes(`${m.id}.pflow`)) ?? m.id}\` ${m.subject} | ${verdicts.length} | ${verdicts.filter(v => v.verdict === 'false').map(v => v.spec).join(', ') || '-'} |`);
    }
    out.push('');
    return out.join('\n');
}

function trendsSection(history: HistoryEntry[]): string {
    return history.length ? ['## Trends', '', ...trendTable(history)].join('\n') : '';
}

/** The functions to simplify first: complex, in files that change often. */
function hotspotsTable(m: ExtractionResult['quality']['metrics']): string[] {
    if (!m.hotspots.length) return [];
    if (!m.churn) {
        const rows = m.hotspots.map(h => `| ${h.name} | \`${h.file}:${h.line}\` | ${h.cognitive} | ${h.nesting} |`);
        return ['Most complex functions (no git history to weigh them with):', '', '| function | file | Cognitive Complexity | nesting |', '| --- | --- | --- | --- |', ...rows, ''];
    }
    const rows = m.hotspots.map(h => `| ${h.name} | \`${h.file}:${h.line}\` | ${h.cognitive} | ${h.changes} | ${h.score} |`);
    return [
        `Hotspots: complex functions in files that change often (${m.churn.commits} commit(s) in the last ${m.churn.months} months). Simplify these first.`,
        '',
        '| function | file | Cognitive Complexity | commits to the file | score |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
        ''
    ];
}

function scenariosSection(scenarios: string[], skeletons: string[]): string {
    if (scenarios.length === 0) return '';
    const out = [
        '## Scenarios',
        '',
        'A test per counterexample. Most drive the real code along the counterexample and check the property: they fail while the bug is there and pass once it is fixed, so they can join the project\'s tests as regression tests. A test that passes before any fix means the model is coarser than the code (declare the missing guard or terminal state in provenflow.config.json). Skeletons list the steps to write by hand.',
        ''
    ];
    scenarios.forEach(s => out.push(`- \`${s}\`${skeletons.includes(s) ? ' (skeleton)' : ''}`));
    out.push('');
    return out.join('\n');
}

function llmSection(result: ExtractionResult): string {
    if (!result.llm || (!result.llm.accepted.length && !result.llm.rejected.length)) return '';
    const out = ['## LLM proposals', ''];
    result.llm.accepted.forEach(a => out.push(`- ✓ ${a}`));
    result.llm.rejected.forEach(r => out.push(`- ✗ ${r}`));
    out.push('');
    return out.join('\n');
}

function notesSection(result: ExtractionResult): string {
    if (result.notes.length === 0) return '';
    const out = ['## Notes', ''];
    result.notes.forEach(n => out.push(`- ${n}`));
    out.push('');
    return out.join('\n');
}

function count(result: ExtractionResult, kind: string): number {
    return result.models.filter(m => m.kind === kind).length;
}

function icon(severity: Finding['severity']): string {
    return severity === 'error' ? '⛔' : severity === 'warning' ? '⚠️' : 'ℹ️';
}

function sourceLabel(source: Finding['source']): string {
    const tools: Partial<Record<Finding['source'], string>> = { semgrep: 'Semgrep', codeql: 'CodeQL', infer: 'Infer', esbmc: 'proved by ESBMC on the code', cbmc: 'proved by CBMC on the code', kani: 'proved by Kani on the code', sarif: 'SARIF import', build: 'build', osv: 'OSV database' };
    return source === 'nuxmv' ? 'proved by nuXmv' : source === 'graph' ? 'found on the model graph' : source === 'llm' ? 'LLM' : (tools[source] ?? 'static analysis');
}

/** Everything the editor shows for an imported code base, including the .pflow text of every model. */
export function webReport(result: ExtractionResult, history: HistoryEntry[] = []): unknown {
    const models = result.models.map(m => `models/${m.id}.pflow`);
    return {
        ...(jsonReport(result) as object),
        models: result.models.map(m => ({
            id: m.id,
            kind: m.kind,
            subject: m.subject,
            loc: m.loc,
            states: m.model.states.length,
            transitions: m.model.transitions.length,
            properties: result.verdicts.filter(v => v.model === m.id).length,
            failed: result.verdicts.filter(v => v.model === m.id && v.verdict === 'false').map(v => v.spec),
            notes: m.notes,
            pflow: modelToPflow(m)
        })),
        markdown: markdownReport(result, models, [], [], history)
    };
}

function jsonReport(result: ExtractionResult): unknown {
    const { facts, models, previous: _previous, ...rest } = result;
    return {
        ...rest,
        summary: summary(result),
        facts: { stateVariables: facts.stateVariables.length, writes: facts.writes.length, resources: facts.resources.length, classes: facts.classes.length, functions: facts.functions.length, modules: facts.modules.length },
        models: models.map(m => ({ id: m.id, kind: m.kind, subject: m.subject, loc: m.loc, states: m.model.states.length, transitions: m.model.transitions.length, specs: m.model.specs.map(s => `${s.name} := ${s.expression}`), notes: m.notes }))
    };
}
