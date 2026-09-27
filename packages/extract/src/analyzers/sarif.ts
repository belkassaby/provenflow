/** SARIF (the standard report of static analysers: CodeQL, ESLint, Semgrep, ...) to findings. */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Category, Finding, Severity } from '../models.js';
import { emptyOutput, loc, type AnalyzerContext, type AnalyzerOutput } from './types.js';

interface SarifLocation {
    physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } };
}

interface SarifLog {
    runs?: Array<{
        tool?: { driver?: { name?: string; rules?: Array<{ id?: string; shortDescription?: { text?: string }; help?: { text?: string }; properties?: { tags?: string[]; 'security-severity'?: string } }> } };
        results?: Array<{
            ruleId?: string;
            level?: string;
            message?: { text?: string };
            locations?: SarifLocation[];
            relatedLocations?: SarifLocation[];
            codeFlows?: Array<{ threadFlows?: Array<{ locations?: Array<{ location?: SarifLocation }> }> }>;
        }>;
    }>;
}

export function sarifToFindings(log: SarifLog, root: string, source: Finding['source'], defaultCategory: Category = 'security'): Finding[] {
    const findings: Finding[] = [];
    for (const run of log.runs ?? []) {
        const tool = run.tool?.driver?.name ?? source;
        const rules = new Map((run.tool?.driver?.rules ?? []).map(r => [r.id, r]));
        for (const r of run.results ?? []) {
            const rule = rules.get(r.ruleId);
            const at = (l?: SarifLocation) => {
                const uri = decodeURIComponent((l?.physicalLocation?.artifactLocation?.uri ?? '').replace(/^file:\/\//, ''));
                if (!uri) return undefined;
                const file = isAbsolute(uri) ? relative(root, uri) : uri;
                return loc(file.split('\\').join('/'), l?.physicalLocation?.region?.startLine);
            };
            const flow = (r.codeFlows ?? []).flatMap(c => c.threadFlows ?? []).flatMap(t => t.locations ?? []).map(x => at(x.location)).filter((x): x is NonNullable<typeof x> => !!x);
            const tags = rule?.properties?.tags ?? [];
            const securitySeverity = Number(rule?.properties?.['security-severity'] ?? 0);
            const level: Severity = r.level === 'error' || securitySeverity >= 7 ? 'error' : r.level === 'note' || r.level === 'none' ? 'info' : 'warning';
            findings.push({
                rule: `${source}:${r.ruleId ?? 'result'}`,
                category: tags.some(t => /security|cwe/i.test(t)) || defaultCategory === 'security' ? 'security' : defaultCategory,
                severity: level,
                subject: rule?.shortDescription?.text ?? r.ruleId ?? tool,
                message: `${r.message?.text ?? rule?.shortDescription?.text ?? ''}${flow.length > 1 ? ` (data flows through ${flow.length} steps)` : ''}`.trim(),
                fix: rule?.help?.text?.split('\n').find(l => l.trim()) ?? 'See the rule documentation of the tool.',
                loc: at(r.locations?.[0]),
                related: [...flow, ...(r.relatedLocations ?? []).map(at).filter((x): x is NonNullable<typeof x> => !!x)].slice(0, 20),
                source
            });
        }
    }
    return findings;
}

/** SARIF files named in the config (reports of other tools, e.g. from CI). */
export async function importSarif(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const out = emptyOutput();
    for (const file of ctx.config.analyzers?.sarif ?? []) {
        const started = Date.now();
        try {
            const log = JSON.parse(readFileSync(isAbsolute(file) ? file : join(ctx.root, file), 'utf8')) as SarifLog;
            out.findings.push(...sarifToFindings(log, ctx.root, 'sarif'));
            out.ran.push({ tool: `SARIF ${file}`, ms: Date.now() - started, scope: file, ok: true });
        } catch (error) {
            out.notes.push(`SARIF ${file}: ${(error as Error).message}`);
        }
    }
    return out;
}
