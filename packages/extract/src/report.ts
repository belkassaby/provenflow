/**
 * Outputs of `pflow extract`: the models (.pflow, open them in the editor),
 * a Markdown report for people, JSON for tools, SARIF for code scanning
 * (GitHub shows the findings on the pull request), and a test scenario for
 * each counterexample, to confirm the bug on the real code.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtractionResult } from './index.js';
import { formatLocation } from './ir.js';
import { modelToPflow, slug, type Finding } from './models.js';

export interface WrittenFiles {
    dir: string;
    models: string[];
    scenarios: string[];
    /** One folder per proposed change: the changed files and change.patch. */
    fixes: string[];
    report: string;
}

export function writeOutputs(result: ExtractionResult, dir: string): WrittenFiles {
    mkdirSync(join(dir, 'models'), { recursive: true });
    const models = result.models.map(m => {
        const file = join('models', `${m.id}.pflow`);
        writeFileSync(join(dir, file), modelToPflow(m));
        return file;
    });
    const scenarios: string[] = [];
    const withTrace = result.findings.filter(f => f.counterexample && f.counterexample.length > 1 && f.category !== 'architecture');
    if (withTrace.length > 0) mkdirSync(join(dir, 'scenarios'), { recursive: true });
    withTrace.forEach((f, i) => {
        const python = f.loc?.file.endsWith('.py');
        const base = slug(`${f.model ?? 'finding'}-${f.rule}-${i + 1}`).replace(/[-.]/g, '_');
        const file = join('scenarios', python ? `test_${base}.py` : `${base}.test.ts`);
        writeFileSync(join(dir, file), python ? pytestScenario(f) : vitestScenario(f));
        scenarios.push(file);
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
    writeFileSync(join(dir, 'report.md'), markdownReport(result, models, scenarios));
    writeFileSync(join(dir, 'report.json'), JSON.stringify(jsonReport(result), null, 2));
    writeFileSync(join(dir, 'report.sarif'), JSON.stringify(sarif(result), null, 2));
    return { dir, models, scenarios, fixes, report: join(dir, 'report.md') };
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

function markdownReport(result: ExtractionResult, models: string[], scenarios: string[]): string {
    const s = summary(result);
    const out: string[] = [];
    out.push(`# ProvenFlow code model report`, '');
    out.push(`${result.files} files, ${result.models.length} models (${count(result, 'state-machine')} state machines, ${count(result, 'lifecycle')} resource lifecycles, ${count(result, 'pattern')} pattern contracts${count(result, 'architecture') ? ', 1 architecture' : ''}), ${result.verdicts.length} properties checked with ${result.checkedWith === 'nuxmv' ? 'nuXmv' : 'the explicit-state checker (set NUXMV_PATH to use nuXmv)'}.`, '');
    out.push(`**${s.error} errors, ${s.warning} warnings, ${s.info} notes.**`, '');
    if (result.llm) out.push(`LLM (${result.llm.provider}): ${result.llm.accepted.length} proposals accepted after verification, ${result.llm.rejected.length} rejected; ${result.llm.usage.calls} call(s), ${result.llm.usage.input} input + ${result.llm.usage.output} output tokens${result.llm.usage.cached ? ` (${result.llm.usage.cached} answered from the cache)` : ''}.`, '');
    if (result.tools.length > 0) out.push(`Analysers: ${result.tools.map(t => `${t.tool}${t.version ? ` ${t.version}` : ''} (${t.scope})`).join('; ')}.`, '');
    if (result.changeChecks.length > 0) out.push(`Proposed changes were also checked with: ${result.changeChecks.map(c => `\`${c}\``).join(', ')}.`, '');

    const categories: Array<[Finding['category'], string]> = [
        ['security', 'Security and dataflow'],
        ['memory', 'Memory safety and arithmetic'],
        ['heap', 'Heap (interprocedural)'],
        ['build', 'Build and tests'],
        ['state-machine', 'State machines'],
        ['lifecycle', 'Resource lifecycles'],
        ['pattern', 'Design patterns'],
        ['architecture', 'Architecture'],
        ['paradigm', 'Paradigm and size']
    ];
    for (const [category, title] of categories) {
        const list = result.findings.filter(f => f.category === category);
        if (list.length === 0 && ['security', 'memory', 'heap', 'build'].includes(category) && result.tools.length === 0) continue;
        out.push(`## ${title} (${list.length})`, '');
        if (list.length === 0) out.push('No findings.', '');
        for (const f of list) {
            out.push(`### ${icon(f.severity)} ${f.rule}: ${f.subject}`, '');
            out.push(`${f.loc ? `\`${formatLocation(f.loc)}\` · ` : ''}${f.severity} · ${sourceLabel(f.source)}${f.model ? ` · model \`models/${f.model}.pflow\`` : ''}`, '');
            out.push(f.message, '');
            out.push(`**Fix:** ${f.fix}`, '');
            if (f.spec) out.push(`Property: \`${f.spec}\``, '');
            if (f.confirmation) out.push(`**On the code** (${f.confirmation.by}, ${f.confirmation.status}): ${f.confirmation.detail}`, '');
            if (f.counterexample && f.counterexample.length > 1) {
                out.push('| step | state | code |', '| --- | --- | --- |');
                f.counterexample.forEach((c, i) => out.push(`| ${i} | ${c.state} | ${c.event ? `${c.event}${c.loc ? ` (\`${formatLocation(c.loc)}\`)` : ''}` : 'start'} |`));
                out.push('');
            }
            if (f.suggestedPatch) {
                out.push(`**Suggested change** (${f.suggestedPatch.by ?? 'LLM'}, ${f.suggestedPatch.verified ? '✓ verified' : '✗ not verified'}): ${f.suggestedPatch.note}`, '', '```diff', f.suggestedPatch.diff.trim(), '```', '');
                if (f.suggestedPatch.checks?.length) out.push(`Checks on the changed copy: ${f.suggestedPatch.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join(', ')}`, '');
            }
        }
    }

    out.push('## Patterns found', '');
    if (result.patterns.length === 0) out.push('None.', '');
    else {
        out.push('| pattern | subject | evidence | recognised | contract model |', '| --- | --- | --- | --- | --- |');
        for (const p of result.patterns) out.push(`| ${p.pattern} | ${p.subject} (\`${formatLocation(p.loc)}\`) | ${p.evidence} | ${p.confidence ?? '-'} | ${p.model ? `\`models/${p.model}.pflow\`` : '-'} |`);
        out.push('');
    }

    if (result.proofs.length > 0) {
        out.push('## Proofs about the code', '', 'Each function model checked for every input, loops unwound up to the bound.', '', '| function | property | tool | bound | result |', '| --- | --- | --- | --- | --- |');
        for (const p of result.proofs) out.push(`| ${p.subject}${p.loc ? ` (\`${formatLocation(p.loc)}\`)` : ''} | ${p.property} | ${p.tool} | ${p.bound ?? '-'} | ${p.status}${p.detail ? `: ${p.detail.replace(/\|/g, '\\|')}` : ''} |`);
        out.push('');
    }

    out.push('## Paradigm', '');
    out.push('| part | declared | detected | files | classes | methods | free functions | pure | higher-order | mutations/100 lines | mutable globals |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const p of result.paradigm) out.push(`| ${p.part} | ${p.declared ?? '-'} | ${p.detected} | ${p.files} | ${p.classes} | ${p.methods} | ${p.freeFunctions} | ${p.pureFunctions} | ${p.higherOrderFunctions} | ${p.mutationDensity} | ${p.mutableGlobals} |`);
    out.push('');

    if (result.architecture.edges.length > 0) {
        out.push('## Dependencies between parts', '', '| from | to | imports | example |', '| --- | --- | --- | --- |');
        for (const e of result.architecture.edges) out.push(`| ${e.from} | ${e.to} | ${e.count}${e.typeOnly ? ' (types)' : ''} | \`${formatLocation(e.example)}\` |`);
        out.push('');
    }

    out.push('## Models', '', 'Open any of them in the ProvenFlow editor (Open .pflow) to see the diagram and replay counterexamples.', '');
    out.push('| model | properties | false |', '| --- | --- | --- |');
    for (const m of result.models) {
        const verdicts = result.verdicts.filter(v => v.model === m.id);
        out.push(`| \`${models.find(x => x.includes(`${m.id}.pflow`)) ?? m.id}\` ${m.subject} | ${verdicts.length} | ${verdicts.filter(v => v.verdict === 'false').map(v => v.spec).join(', ') || '-'} |`);
    }
    out.push('');
    if (scenarios.length > 0) {
        out.push('## Scenarios', '', 'A test skeleton per counterexample: replay it on the real code. If the expectation fails, the bug is real; if it passes, the model is coarser than the code (declare the missing guard or terminal state in provenflow.config.json).', '');
        scenarios.forEach(s => out.push(`- \`${s}\``));
        out.push('');
    }
    if (result.llm && (result.llm.accepted.length || result.llm.rejected.length)) {
        out.push('## LLM proposals', '');
        result.llm.accepted.forEach(a => out.push(`- ✓ ${a}`));
        result.llm.rejected.forEach(r => out.push(`- ✗ ${r}`));
        out.push('');
    }
    if (result.notes.length > 0) {
        out.push('## Notes', '');
        result.notes.forEach(n => out.push(`- ${n}`));
        out.push('');
    }
    return out.join('\n');
}

function count(result: ExtractionResult, kind: string): number {
    return result.models.filter(m => m.kind === kind).length;
}

function icon(severity: Finding['severity']): string {
    return severity === 'error' ? '⛔' : severity === 'warning' ? '⚠️' : 'ℹ️';
}

function sourceLabel(source: Finding['source']): string {
    const tools: Partial<Record<Finding['source'], string>> = { semgrep: 'Semgrep', codeql: 'CodeQL', infer: 'Infer', esbmc: 'proved by ESBMC on the code', cbmc: 'proved by CBMC on the code', kani: 'proved by Kani on the code', sarif: 'SARIF import', build: 'build' };
    return source === 'nuxmv' ? 'proved by nuXmv' : source === 'graph' ? 'found on the model graph' : source === 'llm' ? 'LLM' : (tools[source] ?? 'static analysis');
}

/** Everything the editor shows for an imported code base, including the .pflow text of every model. */
export function webReport(result: ExtractionResult): unknown {
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
        markdown: markdownReport(result, models, [])
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

function sarif(result: ExtractionResult): unknown {
    const rules = [...new Set(result.findings.map(f => f.rule))];
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: { driver: { name: 'ProvenFlow', informationUri: 'https://github.com/belkassaby/provenflow', rules: rules.map(id => ({ id, shortDescription: { text: id.replace(/-/g, ' ') } })) } },
                results: result.findings.map(f => ({
                    ruleId: f.rule,
                    level: f.severity === 'info' ? 'note' : f.severity,
                    message: { text: `${f.message}\nFix: ${f.fix}` },
                    locations: f.loc ? [{ physicalLocation: { artifactLocation: { uri: f.loc.file }, region: { startLine: f.loc.line } } }] : [],
                    relatedLocations: (f.related ?? []).slice(0, 10).map((l, i) => ({ id: i, physicalLocation: { artifactLocation: { uri: l.file }, region: { startLine: l.line } } }))
                }))
            }
        ]
    };
}

function steps(f: Finding, comment: string): string {
    return (f.counterexample ?? []).map((c, i) => `${comment}   ${i}. ${c.event ? `${c.event}${c.loc ? ` (${formatLocation(c.loc)})` : ''} -> ` : 'start: '}${c.state}`).join('\n');
}

function vitestScenario(f: Finding): string {
    const title = `${f.subject}: ${f.rule}`.replace(/'/g, "\\'");
    return `// Scenario generated by pflow extract from a counterexample.
// ${f.message.replace(/\n/g, ' ')}
// Property: ${f.spec ?? '-'}
// Replay these steps on the real code:
${steps(f, '//')}
// If the final expectation fails, the bug is real: apply the fix
//   ${f.fix}
// If it passes, the model is coarser than the code: declare the guard or terminal state in provenflow.config.json.
import { describe, it } from 'vitest';

describe('${title}', () => {
    it.todo('drives the code along the counterexample and expects the property to hold');
});
`;
}

function pytestScenario(f: Finding): string {
    return `"""Scenario generated by pflow extract from a counterexample.

${f.message}
Property: ${f.spec ?? '-'}
Replay these steps on the real code:
${steps(f, '')}
If the final assertion fails, the bug is real: ${f.fix}
If it passes, the model is coarser than the code: declare the guard or terminal state in provenflow.config.json.
"""
import pytest


@pytest.mark.skip(reason="fill in the steps above, then remove this mark")
def test_counterexample():
    ...
`;
}
