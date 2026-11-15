/**
 * Code quality beyond behaviour: duplicated code, complexity, naming conventions, practices and code
 * smells (practices.ts), dependencies that exist, and test coverage, with the measures that `pflow compare` puts side by side for two
 * versions of a code base. Test files and generated files are left out of these checks.
 */
import { DEFAULT_COMPLEXITY, limitsFor, type ProvenflowConfig } from '../config.js';
import type { Facts, FunctionFact, Language } from '../ir.js';
import type { Finding } from '../models.js';
import { isTestFile } from '../scan.js';
import { complexityFindings, type ComplexityLimits } from './complexity.js';
import { coveredShare, readCoverage, untestedComplexFunctions, type Coverage } from './coverage.js';
import { dependencyFindings } from './dependencies.js';
import { analyseDuplication, functionLabel, type Clone } from './duplication.js';
import { namingFindings, type Convention } from './naming.js';
import { practiceFindings } from './practices.js';
import { STANDARDS } from './standards.js';
import { codeLines, isGenerated, tokenize, type Token } from './tokens.js';

export { parseCobertura, parseJacoco, parseLcov, readCoverage, uncoveredChanges, type Coverage } from './coverage.js';
export { findClones, functionLabel, similarFunctions, similarToSnippet, type Clone } from './duplication.js';
export { STANDARDS, standardOf, type LanguageStandard } from './standards.js';
export { shapeOf, restyle, dominant } from './naming.js';
export { tokenize } from './tokens.js';
export { deleteLinesEdit, rethrowEdit, uniqueEdit } from './practices.js';

export interface QualityMetrics {
    files: number;
    /** Lines holding code (not blank, not comments, not imports), in source files (tests excluded). */
    codeLines: number;
    testFiles: number;
    testCodeLines: number;
    functions: number;
    duplication: { clones: number; duplicatedLines: number; percent: number; similarFunctions: number };
    complexity: { mean: number; p90: number; max: number; overLimit: number; deepNesting: number; maxNesting: number; cyclomaticMean: number };
    size: { meanFunctionLines: number; longFunctions: number; manyParameters: number };
    naming: { checked: number; inconsistent: number };
    dependencies: { unknown: number; undeclared: number };
    coverage?: { percent: number; covered: number; total: number };
    /** The most complex functions. */
    hotspots: Array<{ name: string; file: string; line: number; cognitive: number; nesting: number }>;
}

export interface QualityResult {
    findings: Finding[];
    metrics: QualityMetrics;
    clones: Clone[];
    conventions: Convention[];
    coverage?: Coverage;
    notes: string[];
}

export interface QualityOptions {
    /** Coverage reports to read, besides config.coverage.reports. */
    coverageReports?: string[];
}

export function complexityLimits(config: ProvenflowConfig): (language: Language | undefined) => ComplexityLimits {
    const declared = config.complexity === false ? undefined : config.complexity;
    return language => {
        const own = language ? config.languages?.[language]?.complexity : undefined;
        const standard = language ? STANDARDS[language]?.limits : undefined;
        return {
            cognitive: own?.cognitive ?? declared?.cognitive ?? standard?.cognitive ?? DEFAULT_COMPLEXITY.cognitive,
            nesting: own?.nesting ?? declared?.nesting ?? standard?.nesting ?? DEFAULT_COMPLEXITY.nesting
        };
    };
}

export function analyseQuality(facts: Facts, config: ProvenflowConfig, read: (file: string) => string | undefined, options: QualityOptions = {}): QualityResult {
    const notes: string[] = [];
    const languageOf = new Map(facts.modules.map(m => [m.file, m.language]));
    const testFiles = new Set(facts.modules.filter(m => m.isTest).map(m => m.file));
    const isTest = (file: string) => testFiles.has(file) || isTestFile(file);
    const texts = new Map<string, string>();
    for (const f of facts.files) {
        const t = read(f);
        // An empty file is one that does not exist in this version (pflow compare --base empties added files).
        if (t?.trim()) texts.set(f, t);
    }
    const generated = new Set([...texts].filter(([, t]) => isGenerated(t)).map(([f]) => f));
    const skip = (file: string) => isTest(file) || generated.has(file);
    const tokens = new Map<string, Token[]>();
    for (const [f, t] of texts) if (!generated.has(f)) tokens.set(f, tokenize(t, f));
    const sourceFiles = [...tokens.keys()].filter(f => !isTest(f));
    const functions = facts.functions.filter(f => !skip(f.loc.file));
    const findings: Finding[] = [];

    // Duplication
    const dup = config.duplication === false ? undefined : config.duplication ?? {};
    const duplicationSources = [...tokens].filter(([f]) => dup?.tests || !isTest(f)).map(([file, toks]) => ({ file, tokens: toks }));
    const duplication = dup ? analyseDuplication(duplicationSources, functions, config.layers, dup) : undefined;
    if (duplication) findings.push(...duplication.findings);

    // Complexity
    const limitsOf = complexityLimits(config);
    if (config.complexity !== false) findings.push(...complexityFindings(functions, limitsOf, f => languageOf.get(f)));

    // Naming
    const naming = namingFindings({ ...facts, classes: facts.classes.filter(c => !skip(c.loc.file)), functions }, config, isTest);
    findings.push(...naming.findings);

    // Practices and code smells (empty handlers, commented-out code, train wrecks, flag arguments, magic numbers)
    findings.push(...practiceFindings(sourceFiles.map(file => ({ file, text: texts.get(file)!, tokens: tokens.get(file)! })), functions));

    // Dependencies
    if (config.dependencies !== false) findings.push(...dependencyFindings(facts, skip));

    // Coverage
    const { coverage, notes: coverageNotes, findings: untested } = coverageFindings(facts, config, options, functions, f => limitsOf(languageOf.get(f.loc.file)).cognitive);
    notes.push(...coverageNotes);
    findings.push(...untested);

    const metrics = measure({ functions, sourceFiles, tokens, isTest, duplication, findings, limitsOf, languageOf, conventions: naming.conventions, coverage, config });
    return { findings, metrics, clones: duplication?.clones ?? [], conventions: naming.conventions, coverage, notes };
}

/** The coverage reports of the config and the options, and the complex functions they leave untested. */
function coverageFindings(facts: Facts, config: ProvenflowConfig, options: QualityOptions, functions: FunctionFact[], cognitiveLimit: (f: FunctionFact) => number): { coverage?: Coverage; notes: string[]; findings: Finding[] } {
    const reports = [...(config.coverage?.reports ?? []), ...(options.coverageReports ?? [])];
    if (!reports.length) return { notes: [], findings: [] };
    const read = readCoverage(facts.root, reports, facts.files);
    return { coverage: read.coverage, notes: read.notes, findings: untestedComplexFunctions(read.coverage, functions, cognitiveLimit) };
}

interface Measured {
    functions: FunctionFact[];
    sourceFiles: string[];
    tokens: Map<string, Token[]>;
    isTest: (file: string) => boolean;
    duplication: ReturnType<typeof analyseDuplication> | undefined;
    findings: Finding[];
    limitsOf: (language: Language | undefined) => ComplexityLimits;
    languageOf: Map<string, Language>;
    conventions: QualityResult['conventions'];
    coverage: Coverage | undefined;
    config: ProvenflowConfig;
}

function measure({ functions, sourceFiles, tokens, isTest, duplication, findings, limitsOf, languageOf, conventions, coverage, config }: Measured): QualityMetrics {
    const lines = sourceFiles.reduce((n, f) => n + codeLines(tokens.get(f) ?? []), 0);
    const testFiles = [...tokens.keys()].filter(isTest);
    const testLines = testFiles.reduce((n, f) => n + codeLines(tokens.get(f) ?? []), 0);
    let duplicated = 0;
    for (const [file, set] of duplication?.duplicatedLines ?? []) {
        const code = new Set((tokens.get(file) ?? []).map(t => t.line));
        for (const l of set) if (code.has(l)) duplicated++;
    }
    const measured = functions.filter(f => f.complexity);
    const cognitive = measured.map(f => f.complexity!.cognitive).sort((a, b) => a - b);
    const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);
    const sizeLimits = (f: FunctionFact) => limitsFor(config, languageOf.get(f.loc.file));
    const count = (rule: string) => findings.filter(f => f.rule === rule).length;
    return {
        files: sourceFiles.length,
        codeLines: lines,
        testFiles: testFiles.length,
        testCodeLines: testLines,
        functions: functions.length,
        duplication: {
            clones: duplication?.clones.length ?? 0,
            duplicatedLines: duplicated,
            percent: lines ? Math.round((duplicated / lines) * 1000) / 10 : 0,
            similarFunctions: duplication?.similar.length ?? 0
        },
        complexity: {
            mean: mean(cognitive),
            p90: cognitive.length ? cognitive[Math.min(cognitive.length - 1, Math.floor(cognitive.length * 0.9))] : 0,
            max: cognitive.length ? cognitive[cognitive.length - 1] : 0,
            overLimit: measured.filter(f => f.complexity!.cognitive > limitsOf(languageOf.get(f.loc.file)).cognitive).length,
            deepNesting: measured.filter(f => f.complexity!.nesting > limitsOf(languageOf.get(f.loc.file)).nesting).length,
            maxNesting: measured.reduce((n, f) => Math.max(n, f.complexity!.nesting), 0),
            cyclomaticMean: mean(measured.map(f => f.complexity!.cyclomatic))
        },
        size: {
            meanFunctionLines: mean(functions.map(f => f.lines)),
            longFunctions: functions.filter(f => f.lines > sizeLimits(f).functionLines).length,
            manyParameters: functions.filter(f => f.params > sizeLimits(f).functionParams).length
        },
        naming: { checked: conventions.reduce((n, c) => n + c.names, 0), inconsistent: count('naming-convention') },
        dependencies: { unknown: count('unknown-dependency'), undeclared: count('undeclared-dependency') },
        coverage: coverage ? (({ covered, total, percent }) => ({ covered, total, percent }))(coveredShare(coverage)) : undefined,
        hotspots: [...measured]
            .sort((a, b) => b.complexity!.cognitive - a.complexity!.cognitive)
            .slice(0, 10)
            .map(f => ({ name: functionLabel(f), file: f.loc.file, line: f.loc.line, cognitive: f.complexity!.cognitive, nesting: f.complexity!.nesting }))
    };
}
