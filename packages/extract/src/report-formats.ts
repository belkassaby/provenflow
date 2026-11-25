/**
 * Machine-readable outputs of the findings, for CI systems:
 * - SARIF 2.1.0 for GitHub code scanning (and any SARIF viewer), with stable fingerprints so an alert
 *   keeps its identity when lines move, rule help, end lines and a `category` per run;
 * - GitLab Code Quality (`artifacts:reports:codequality`), the CodeClimate-style JSON array;
 * - reviewdog's rdjson, which reviewdog posts to GitHub, GitLab, Gerrit, Bitbucket and Gitea.
 */
import { createHash } from 'node:crypto';
import type { ExtractionResult } from './project.js';
import { findingKey } from './incremental.js';
import type { Category, Finding } from './models.js';
import { PROVENFLOW_VERSION } from './version.js';

const DOCS = 'https://github.com/belkassaby/provenflow/blob/main/docs/code-model-checking.md';

const CATEGORY_DOCS: Record<Category, string> = {
    'state-machine': '#state-machines',
    lifecycle: '#resource-lifecycles-typestate',
    pattern: '#design-patterns',
    paradigm: '#paradigm',
    architecture: '#architecture',
    security: '#security-heap-and-memory-safety-the-analysers-provenflow-drives',
    memory: '#security-heap-and-memory-safety-the-analysers-provenflow-drives',
    heap: '#security-heap-and-memory-safety-the-analysers-provenflow-drives',
    build: '#code-changes-quick-fixes-review-apply',
    duplication: '#duplicated-code',
    complexity: '#complexity',
    naming: '#naming-conventions',
    tests: '#tests-and-coverage',
    dependencies: '#dependencies',
    practice: '#patterns-and-practices-the-catalogue'
};

/** A finding's identity across runs (rule, subject, file: no line), hashed. */
export function fingerprint(f: Finding): string {
    return createHash('sha256').update(findingKey(f)).digest('hex');
}

/** Fingerprints numbered when several findings share one (the same rule twice on one subject). */
function numbered(findings: Finding[]): Array<{ f: Finding; hash: string; occurrence: number }> {
    const seen = new Map<string, number>();
    return findings.map(f => {
        const hash = fingerprint(f);
        const occurrence = (seen.get(hash) ?? 0) + 1;
        seen.set(hash, occurrence);
        return { f, hash, occurrence };
    });
}

export function sarif(result: ExtractionResult): unknown {
    const byRule = new Map<string, Finding>();
    for (const f of result.findings) if (!byRule.has(f.rule)) byRule.set(f.rule, f);
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: { driver: { name: 'ProvenFlow', informationUri: 'https://github.com/belkassaby/provenflow', semanticVersion: PROVENFLOW_VERSION, rules: [...byRule.values()].map(sarifRule) } },
                automationDetails: { id: 'provenflow/' },
                results: numbered(result.findings).map(sarifResult)
            }
        ]
    };
}

const PROVED = new Set<Finding['source']>(['nuxmv', 'esbmc', 'cbmc', 'kani']);
const SECURITY_SEVERITY = { error: '8.0', warning: '5.0', info: '2.0' } as const;

/** A rule's metadata, from its first finding: help text, documentation, tags, precision. */
function sarifRule(f: Finding): unknown {
    const security = f.category === 'security';
    return {
        id: f.rule,
        name: f.rule.replace(/(^|[-:])(\w)/g, (_, _sep: string, c: string) => c.toUpperCase()),
        shortDescription: { text: f.rule.replace(/[-:]/g, ' ') },
        help: { text: f.fix, markdown: `**Fix:** ${f.fix}` },
        helpUri: `${DOCS}${CATEGORY_DOCS[f.category]}`,
        defaultConfiguration: { level: level(f.severity) },
        properties: {
            tags: ['provenflow', f.category, ...(security ? ['security'] : [])],
            precision: PROVED.has(f.source) ? 'very-high' : 'high',
            ...(security ? { 'security-severity': SECURITY_SEVERITY[f.severity] } : {})
        }
    };
}

function sarifResult({ f, hash, occurrence }: { f: Finding; hash: string; occurrence: number }): unknown {
    const region = (line: number, endLine?: number) => ({ startLine: line, ...(endLine && endLine > line ? { endLine } : {}) });
    return {
        ruleId: f.rule,
        level: level(f.severity),
        message: { text: `${f.message}\nFix: ${f.fix}` },
        locations: f.loc ? [{ physicalLocation: { artifactLocation: { uri: f.loc.file }, region: region(f.loc.line, f.endLine) } }] : [],
        relatedLocations: (f.related ?? []).slice(0, 10).map((l, i) => ({ id: i, physicalLocation: { artifactLocation: { uri: l.file }, region: region(l.line) } })),
        partialFingerprints: { 'provenflow/v1': hash, primaryLocationLineHash: `${hash.slice(0, 16)}:${occurrence}` },
        ...(f.measure ? { properties: { measure: f.measure } } : {})
    };
}

function level(severity: Finding['severity']): 'error' | 'warning' | 'note' {
    return severity === 'info' ? 'note' : severity;
}

/** GitLab Code Quality report: https://docs.gitlab.com/ci/testing/code_quality/ */
export function codeQuality(result: ExtractionResult): unknown {
    const severity = { error: 'critical', warning: 'major', info: 'minor' } as const;
    return numbered(result.findings.filter(f => f.loc)).map(({ f, hash, occurrence }) => ({
        description: `${f.message} Fix: ${f.fix}`,
        check_name: f.rule,
        fingerprint: createHash('md5').update(`${hash}:${occurrence}`).digest('hex'),
        severity: severity[f.severity],
        categories: [CODE_CLIMATE[f.category]],
        location: { path: f.loc!.file, lines: { begin: f.loc!.line, ...(f.endLine ? { end: f.endLine } : {}) } }
    }));
}

const CODE_CLIMATE: Record<Category, string> = {
    'state-machine': 'Bug Risk',
    lifecycle: 'Bug Risk',
    pattern: 'Bug Risk',
    paradigm: 'Style',
    architecture: 'Clarity',
    security: 'Security',
    memory: 'Bug Risk',
    heap: 'Bug Risk',
    build: 'Bug Risk',
    duplication: 'Duplication',
    complexity: 'Complexity',
    naming: 'Style',
    tests: 'Bug Risk',
    dependencies: 'Security',
    practice: 'Clarity'
};

/** reviewdog Diagnostic Format (rdjson): https://github.com/reviewdog/reviewdog/tree/master/proto/rdf */
export function rdjson(result: ExtractionResult): unknown {
    const severity = { error: 'ERROR', warning: 'WARNING', info: 'INFO' } as const;
    return {
        source: { name: 'ProvenFlow', url: 'https://github.com/belkassaby/provenflow' },
        diagnostics: result.findings
            .filter(f => f.loc)
            .map(f => {
                const patch = f.suggestedPatch?.verified ? f.suggestedPatch.edits?.filter(e => e.file === f.loc!.file) : undefined;
                return {
                    message: `${f.message}\nFix: ${f.fix}`,
                    location: { path: f.loc!.file, range: { start: { line: f.loc!.line }, ...(f.endLine ? { end: { line: f.endLine } } : {}) } },
                    severity: severity[f.severity],
                    code: { value: f.rule, url: `${DOCS}${CATEGORY_DOCS[f.category]}` },
                    ...(patch?.length && f.suggestedPatch?.files ? { suggestions: suggestionsFor(f, patch) } : {})
                };
            })
    };
}

/** A verified search/replace edit as an rdjson suggestion over the lines it replaces. */
function suggestionsFor(f: Finding, edits: Array<{ file: string; search: string; replace: string }>): unknown[] {
    const before = f.suggestedPatch!.files!.find(p => p.file === f.loc!.file)?.before;
    if (!before) return [];
    return edits.flatMap(e => {
        const at = before.indexOf(e.search);
        if (at < 0) return [];
        const end = at + e.search.length;
        const lineStart = before.lastIndexOf('\n', at - 1) + 1;
        const next = before.indexOf('\n', end);
        const lineEnd = next < 0 ? before.length : next;
        const startLine = before.slice(0, at).split('\n').length;
        const endLine = before.slice(0, lineEnd).split('\n').length;
        return [{ range: { start: { line: startLine }, end: { line: endLine } }, text: `${before.slice(lineStart, at)}${e.replace}${before.slice(end, lineEnd)}` }];
    });
}
