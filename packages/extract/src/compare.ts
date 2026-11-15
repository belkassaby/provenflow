/**
 * Two versions of a code base side by side (`pflow compare`): the quality measures, the findings by
 * rule, the findings fixed and introduced, the duplicated code removed and added, and the functions
 * whose complexity changed. For a refactoring, a pull request, or the effect of a coding agent.
 */
import type { ExtractionResult } from './project.js';
import { findingKey } from './incremental.js';
import type { FunctionFact } from './ir.js';
import type { Finding } from './models.js';
import type { QualityMetrics } from './quality/index.js';

export interface Comparison {
    before: { label: string; metrics: QualityMetrics; counts: Record<Finding['severity'], number> };
    after: { label: string; metrics: QualityMetrics; counts: Record<Finding['severity'], number> };
    rules: Array<{ rule: string; before: number; after: number }>;
    fixed: Finding[];
    introduced: Finding[];
    functions: Array<{ name: string; file: string; before?: number; after?: number }>;
}

type Row = [label: string, before: number | undefined, after: number | undefined, lowerIsBetter: boolean | undefined, unit?: string];

export function compareResults(before: ExtractionResult, after: ExtractionResult, labels: { before: string; after: string }): Comparison {
    const counts = (r: ExtractionResult) => ({ error: r.findings.filter(f => f.severity === 'error').length, warning: r.findings.filter(f => f.severity === 'warning').length, info: r.findings.filter(f => f.severity === 'info').length });
    const rules = new Map<string, { before: number; after: number }>();
    for (const f of before.findings) rules.set(f.rule, { before: (rules.get(f.rule)?.before ?? 0) + 1, after: rules.get(f.rule)?.after ?? 0 });
    for (const f of after.findings) rules.set(f.rule, { before: rules.get(f.rule)?.before ?? 0, after: (rules.get(f.rule)?.after ?? 0) + 1 });
    const keysBefore = countKeys(before.findings);
    const keysAfter = countKeys(after.findings);
    return {
        before: { label: labels.before, metrics: before.quality.metrics, counts: counts(before) },
        after: { label: labels.after, metrics: after.quality.metrics, counts: counts(after) },
        rules: [...rules].map(([rule, n]) => ({ rule, ...n })).sort((a, b) => b.before - b.after - (a.before - a.after) || a.rule.localeCompare(b.rule)),
        fixed: unmatched(before.findings, keysAfter),
        introduced: unmatched(after.findings, keysBefore),
        functions: complexityChanges(before.facts.functions, after.facts.functions)
    };
}

function countKeys(findings: Finding[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const f of findings) m.set(findingKey(f), (m.get(findingKey(f)) ?? 0) + 1);
    return m;
}

function unmatched(findings: Finding[], other: Map<string, number>): Finding[] {
    const left = new Map(other);
    return findings.filter(f => {
        const k = findingKey(f);
        const n = left.get(k) ?? 0;
        if (n > 0) {
            left.set(k, n - 1);
            return false;
        }
        return true;
    });
}

/** Functions whose Cognitive Complexity changed, added or removed (the largest changes first). */
function complexityChanges(before: FunctionFact[], after: FunctionFact[]): Comparison['functions'] {
    const key = (f: FunctionFact) => f.id;
    const was = new Map(before.filter(f => f.complexity).map(f => [key(f), f]));
    const now = new Map(after.filter(f => f.complexity).map(f => [key(f), f]));
    const out: Comparison['functions'] = [];
    for (const [k, f] of was) {
        const g = now.get(k);
        if (g?.complexity!.cognitive === f.complexity!.cognitive) continue;
        out.push({ name: f.name, file: f.loc.file, before: f.complexity!.cognitive, after: g?.complexity!.cognitive });
    }
    for (const [k, g] of now) if (!was.has(k)) out.push({ name: g.name, file: g.loc.file, after: g.complexity!.cognitive });
    return out.sort((a, b) => Math.abs((b.after ?? 0) - (b.before ?? 0)) - Math.abs((a.after ?? 0) - (a.before ?? 0)));
}

function rows(m: QualityMetrics, c: Comparison['before']['counts']): Row[] {
    return [
        ['source files', m.files, undefined, undefined],
        ['lines of code', m.codeLines, undefined, undefined],
        ['lines of test code', m.testCodeLines, undefined, false],
        ['functions', m.functions, undefined, undefined],
        ['duplicated lines', m.duplication.duplicatedLines, undefined, true],
        ['duplicated lines (% of code)', m.duplication.percent, undefined, true, '%'],
        ['clones (copied blocks)', m.duplication.clones, undefined, true],
        ['similar functions', m.duplication.similarFunctions, undefined, true],
        ['Cognitive Complexity, mean per function', m.complexity.mean, undefined, true],
        ['Cognitive Complexity, 90th percentile', m.complexity.p90, undefined, true],
        ['Cognitive Complexity, highest', m.complexity.max, undefined, true],
        ['functions over the complexity limit', m.complexity.overLimit, undefined, true],
        ['functions nested too deeply', m.complexity.deepNesting, undefined, true],
        ['cyclomatic complexity, mean', m.complexity.cyclomaticMean, undefined, true],
        ['mean function length (lines)', m.size.meanFunctionLines, undefined, true],
        ['long functions', m.size.longFunctions, undefined, true],
        ['functions with many parameters', m.size.manyParameters, undefined, true],
        ['names off convention', m.naming.inconsistent, undefined, true],
        ['unknown or undeclared dependencies', m.dependencies.unknown + m.dependencies.undeclared, undefined, true],
        ...(m.coverage ? ([['line coverage', m.coverage.percent, undefined, false, '%']] as Row[]) : []),
        ['errors', c.error, undefined, true],
        ['warnings', c.warning, undefined, true],
        ['notes', c.info, undefined, true]
    ];
}

function change(before: number | undefined, after: number | undefined, lowerIsBetter: boolean | undefined, unit = ''): string {
    if (before === undefined || after === undefined) return '';
    const d = Math.round((after - before) * 100) / 100;
    if (d === 0) return '=';
    const pct = before !== 0 && !unit ? ` (${d > 0 ? '+' : ''}${Math.round((d / before) * 100)}%)` : '';
    const mark = lowerIsBetter === undefined ? '' : (d < 0) === lowerIsBetter ? ' ✓' : ' ✗';
    return `${d > 0 ? '+' : ''}${d}${unit}${pct}${mark}`;
}

export function comparisonMarkdown(c: Comparison): string {
    const out: string[] = [`# Code quality: ${c.before.label} → ${c.after.label}`, ''];
    const b = rows(c.before.metrics, c.before.counts);
    const a = rows(c.after.metrics, c.after.counts);
    out.push(`| measure | ${c.before.label} | ${c.after.label} | change |`, '| --- | ---: | ---: | --- |');
    for (const row of b) {
        const after = a.find(x => x[0] === row[0]);
        out.push(`| ${row[0]} | ${row[1]}${row[4] ?? ''} | ${after?.[1] ?? '-'}${after ? (row[4] ?? '') : ''} | ${change(row[1], after?.[1], row[3], row[4])} |`);
    }
    out.push('', '✓: better, ✗: worse (for measures where lower or higher is better).', '');
    const changedRules = c.rules.filter(r => r.before !== r.after);
    if (changedRules.length) {
        out.push('## Findings by rule', '', '| rule | before | after | change |', '| --- | ---: | ---: | --- |');
        for (const r of changedRules) out.push(`| ${r.rule} | ${r.before} | ${r.after} | ${change(r.before, r.after, true)} |`);
        out.push('');
    }
    const list = (title: string, findings: Finding[]) => {
        if (!findings.length) return;
        out.push(`## ${title} (${findings.length})`, '');
        for (const f of findings.slice(0, 40)) out.push(`- **${f.rule}** ${f.subject}${f.loc ? ` (\`${f.loc.file}:${f.loc.line}\`)` : ''}${f.measure ? `: ${f.measure.name} ${f.measure.value}` : ''}`);
        if (findings.length > 40) out.push(`- … and ${findings.length - 40} more`);
        out.push('');
    };
    list('Findings fixed', c.fixed);
    list('Findings introduced', c.introduced);
    const fns = c.functions.filter(f => f.before !== undefined && f.after !== undefined).slice(0, 25);
    if (fns.length) {
        out.push('## Functions whose complexity changed', '', '| function | file | before | after |', '| --- | --- | ---: | ---: |');
        for (const f of fns) out.push(`| ${f.name} | \`${f.file}\` | ${f.before} | ${f.after} |`);
        out.push('');
    }
    return out.join('\n');
}
