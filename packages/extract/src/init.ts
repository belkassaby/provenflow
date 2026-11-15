/**
 * `pflow init`: a provenflow.config.json proposed from the code as it is, so that the project's
 * conventions become deterministic checks instead of something an assistant has to guess:
 *
 * - the coding standards of each language the project uses (style guide naming, linter limits:
 *   quality/standards.ts), adjusted where the project consistently does otherwise;
 * - layers from the current import graph, with the dependencies they have now and the style each
 *   follows (functional or object-oriented);
 * - the design patterns recognised from types and language constructs (not from names);
 * - coverage reports found in the usual places.
 *
 * Each entry comes with the evidence for it, for the team to review before committing the file.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, DEFAULT_DUPLICATION, PATTERNS, type LanguageConfig, type PatternName, type ProvenflowConfig } from './config.js';
import { BASELINE_FILE } from './gate.js';
import type { ExtractionResult } from './project.js';
import type { Language } from './ir.js';
import { LANGUAGE_NAMES } from './quality/naming.js';
import { STANDARDS } from './quality/standards.js';

export interface ProposedConfig {
    config: ProvenflowConfig;
    /** Why each part was proposed. */
    evidence: string[];
}

const COVERAGE_REPORTS = ['coverage/lcov.info', 'coverage/cobertura-coverage.xml', 'coverage.xml', 'coverage/coverage.xml', 'build/reports/jacoco/test/jacocoTestReport.xml', 'target/site/jacoco/jacoco.xml', 'lcov.info'];

export function proposeConfig(result: ExtractionResult, existing: ProvenflowConfig = {}): ProposedConfig {
    const evidence: string[] = [];
    const config: ProvenflowConfig = {};
    if (existing.include) config.include = existing.include;
    if (existing.exclude) config.exclude = existing.exclude;

    config.layers = existing.layers ?? proposeLayers(result, evidence);
    if (!config.layers?.length) delete config.layers;
    if (existing.packageEntries !== undefined) config.packageEntries = existing.packageEntries;

    const patterns = existing.patterns ?? proposePatterns(result, evidence);
    if (patterns.length) config.patterns = patterns;
    if (existing.machines) config.machines = existing.machines;

    config.languages = proposeLanguages(result, existing, evidence);
    config.duplication = existing.duplication ?? { ...DEFAULT_DUPLICATION };
    evidence.push(`duplication: clones of at least ${DEFAULT_DUPLICATION.minTokens} tokens over ${DEFAULT_DUPLICATION.minLines} lines (SonarQube's thresholds), functions sharing ${DEFAULT_DUPLICATION.similarity * 100}% of their tokens; the code has ${result.quality.metrics.duplication.duplicatedLines} duplicated lines now.`);

    const reports = COVERAGE_REPORTS.filter(r => existsSync(join(result.root, r)));
    if (existing.coverage) config.coverage = existing.coverage;
    else if (reports.length) {
        config.coverage = { reports };
        evidence.push(`coverage: found ${reports.join(', ')} (keep it up to date: run the tests with coverage before pflow).`);
    }
    if (existing.analyzers) config.analyzers = existing.analyzers;
    if (existing.verification) config.verification = existing.verification;
    if (existing.ignore) config.ignore = existing.ignore;
    if (existing.limits) config.limits = existing.limits;
    config.baseline = existing.baseline ?? BASELINE_FILE;
    evidence.push(`baseline: ${config.baseline} (write it with pflow baseline: the findings the code has today are accepted; only new ones fail).`);
    config.agents = existing.agents ?? { failOn: 'warning', requireTests: true };
    evidence.push('agents: lines written by coding agents fail on warnings, and need a test change or coverage.');
    return { config, evidence };
}

function proposeLayers(result: ExtractionResult, evidence: string[]): ProvenflowConfig['layers'] {
    const parts = result.paradigm.filter(p => p.part !== '(no layer)' && p.part !== '.' && p.files > 0);
    if (parts.length < 2) return undefined;
    // Short names (packages/app -> app), unless two parts would share one.
    const short = (part: string) => part.split('/').pop()!;
    const nameOf = (part: string) => (parts.filter(q => short(q.part) === short(part)).length > 1 ? part : short(part));
    return parts.map(p => {
        const uses = [...new Set(result.architecture.edges.filter(e => e.from === p.part && parts.some(q => q.part === e.to)).map(e => e.to))].sort();
        const style = p.detected === 'mixed' ? undefined : p.detected;
        evidence.push(`layer ${p.part}: ${p.files} files; imports ${uses.length ? uses.join(', ') : 'no other layer'} today${style ? `; ${style} (detected from ${p.classes} classes, ${p.freeFunctions} free functions)` : ''}.`);
        return { name: nameOf(p.part), paths: [`${p.part}/**`], mayImport: uses.map(nameOf), ...(style ? { style } : {}) };
    });
}

function proposePatterns(result: ExtractionResult, evidence: string[]): Array<{ subject: string; pattern: PatternName }> {
    const out: Array<{ subject: string; pattern: PatternName }> = [];
    for (const p of result.patterns) {
        if (p.confidence !== 'structural' || !(PATTERNS as readonly string[]).includes(p.pattern) || out.some(o => o.subject === p.subject)) continue;
        out.push({ subject: p.subject, pattern: p.pattern as PatternName });
        evidence.push(`pattern ${p.pattern} ${p.subject}: ${p.evidence} (${p.loc.file}:${p.loc.line}).`);
        if (out.length >= 25) break;
    }
    return out;
}

/** The standards of each language with source files, adjusted to the project's consistent naming. */
function proposeLanguages(result: ExtractionResult, existing: ProvenflowConfig, evidence: string[]): ProvenflowConfig['languages'] {
    const lines = new Map<Language, number>();
    for (const m of result.facts.modules) if (!m.isTest) lines.set(m.language, (lines.get(m.language) ?? 0) + m.lines);
    const languages: NonNullable<ProvenflowConfig['languages']> = {};
    for (const [language] of [...lines].sort((a, b) => b[1] - a[1])) {
        const standard = STANDARDS[language];
        if (!standard) continue;
        const own: LanguageConfig = existing.languages?.[language] ?? {};
        const naming = { ...standard.naming };
        for (const c of result.quality.conventions.filter(c => c.language === language)) {
            if (c.from === 'project' && naming[c.kind] !== c.style) {
                evidence.push(`${LANGUAGE_NAMES[language]} ${c.kind} names: ${c.style}, as ${c.fitting} of ${c.names} in the project (the style guide asks for ${naming[c.kind] ?? 'nothing specific'}).`);
                naming[c.kind] = c.style;
            }
        }
        const { functionLines, functionParams, cognitive, nesting } = standard.limits;
        languages[language] = {
            limits: own.limits ?? { functionLines, functionParams },
            complexity: own.complexity ?? { cognitive, nesting },
            naming: own.naming ?? naming
        };
        evidence.push(`${LANGUAGE_NAMES[language]} (${lines.get(language)} lines): naming from ${standard.guide}; limits from ${standard.linter}.`);
    }
    return languages;
}

export { CONFIG_FILE };
