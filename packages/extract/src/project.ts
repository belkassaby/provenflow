/**
 * `pflow extract`: models of a code base, verified.
 *
 *   facts (TypeScript checker, Python ast)
 *     -> state machines, resource lifecycles, pattern contracts, architecture (models)
 *     -> nuXmv (or explicit-state checks)            -> findings with counterexamples
 *     -> paradigm and structural rules               -> findings
 *     -> optional LLM: computed writes, properties, fixes (each verified)
 */
import { join, resolve } from 'node:path';
import { CONFIG_FILE, loadConfig, type ChecksConfig, type ProvenflowConfig } from './config.js';
import { mergeFacts, type Facts } from './ir.js';
import { analyseArchitecture, type ArchitectureResult } from './architecture.js';
import { buildLifecycles } from './lifecycles.js';
import { vulnerableDependencies, type AdvisoryResult } from './advisories/osv.js';
import { modelDrift } from './c4/index.js';
import { confirmUnreachableInC, runAnalyzers, type AnalyzerOutput, type ToolRun } from './analyzers/index.js';
import { ChangeChecker, detectChecks } from './buildcheck.js';
import { quickFixes, readSafe, verifyProposals, type Proposal, type Rerun } from './fixes.js';
import type { ChangeContext } from './single-change.js';
import { confirmFindings } from './replay.js';
import { reporter, type OnProgress } from './progress.js';
import { changedFiles, findingKey, fingerprints, isToolFinding, settingsKey, touches, type IncrementalInfo, type PreviousRun } from './incremental.js';
import { findTool } from './tools/process.js';
import { materialize } from './tools/workspace.js';
import { cachedProvider, metered, resolveDynamicWrites, suggestFixes, suggestProperties, type LlmLog, type LlmProvider, type LlmUsage } from './llm.js';
import { buildStateMachines } from './machines.js';
import type { CodeProof, ExtractedModel, Finding } from './models.js';
import { analyseParadigm, type ParadigmProfile } from './paradigm.js';
import { analysePatterns, checkExpectations, declaredInCode, gradePatternFindings, type PatternInstance } from './patterns.js';
import { extractPython } from './python-frontend.js';
import { analyseQuality, readChurn, type Churn, type QualityMetrics, type QualityResult } from './quality/index.js';
import { selectFindings, selectionNotes, selectPatterns } from './catalogue/index.js';
import { listSourceFiles, matchesAny, sourceFilter } from './scan.js';
import { extractTreeSitter, TREE_SITTER_EXTENSIONS } from './treesitter/frontend.js';
import { extractTypeScript } from './typescript-frontend.js';
import { verifyModels, type Checker, type SpecVerdict } from './verify.js';

import { fixWithoutLlm as fixFromAnalysis, type ChangeEvent as SingleChangeEvent, type SingleChange as SingleChangeResult } from './single-change.js';

export interface ExtractOptions {
    config?: ProvenflowConfig;
    /** Path of the config file (default: <root>/provenflow.config.json). */
    configFile?: string;
    /** Catalogue entries to check, over the config's `checks` (its `select` and `skip`, each when given). */
    checks?: ChecksConfig;
    /** Runs nuXmv; without it the standard properties are checked explicitly. */
    checker?: Checker;
    llm?: LlmProvider;
    /** Ask the LLM for fixes of the first N warnings/errors (0: none). */
    llmFixes?: number;
    /** Propose deterministic quick fixes (verified by re-running the checks) for up to N findings (0: none). */
    quickFixes?: number;
    /** Where LLM answers are cached (default: <root>/.provenflow/cache). */
    cacheDir?: string;
    /** Files whose text replaces the file on disk (used to check fixes). */
    overrides?: Map<string, string>;
    /** Run the external analysers that are installed (Semgrep, Infer, ESBMC/CBMC, Kani, CodeQL, SARIF). Default true. */
    analyzers?: boolean;
    /** Replay counterexamples on the real code / check them with a code model checker. Default true. */
    confirm?: boolean;
    /** How many counterexamples are replayed at most (default 12; `pflow bench` replays them all). */
    replayLimit?: number;
    /** Build/type-check (and tests, when configured) proposed changes on a copy of the project. Default true. */
    buildChecks?: boolean;
    /** Internal: this run checks a proposed change (only the changed files are re-analysed by the tools). */
    rerunOf?: string[];
    /** Told what the analysis is doing, with an overall percentage (for long runs). */
    onProgress?: OnProgress;
    /** Coverage reports (LCOV, Cobertura, JaCoCo) to read besides config.coverage.reports. */
    coverage?: string[];
    /** Ask osv.dev about the locked dependency versions (besides config.advisories.osv). */
    osv?: boolean;
    /** The fetch used for osv.dev (tests). */
    fetch?: typeof fetch;
    /**
     * The previous run of the same folder (its `previous`): only what the files changed since can
     * affect is redone. Ignored when the config or the options differ.
     */
    previous?: PreviousRun;
}

export interface ExtractionResult {
    root: string;
    files: number;
    config: ProvenflowConfig;
    facts: Facts;
    models: ExtractedModel[];
    findings: Finding[];
    verdicts: SpecVerdict[];
    patterns: PatternInstance[];
    paradigm: ParadigmProfile[];
    architecture: Pick<ArchitectureResult, 'edges'>;
    /** LLM proposals kept and rejected, and the tokens used (`cached`: calls answered from the cache). */
    llm?: LlmLog & { provider: string; usage: LlmUsage & { calls: number; cached: number } };
    /** Quick fixes proposed and whether each was verified. */
    quickFixes?: LlmLog;
    /** Notes about the run (skipped files, nuXmv errors, analysers not installed). */
    notes: string[];
    checkedWith: 'nuxmv' | 'explicit';
    /** External analysers that ran. */
    tools: ToolRun[];
    /** Properties of the code proved or refuted by code model checkers (ESBMC/CBMC, Kani). */
    proofs: CodeProof[];
    /** Build/test commands used to check proposed changes. */
    changeChecks: string[];
    /** Set when the run was incremental: what changed, and what was reused. */
    incremental?: IncrementalInfo;
    /** Duplication, complexity, naming, dependency and coverage measures, and the naming conventions applied. */
    quality: Pick<QualityResult, 'metrics' | 'conventions' | 'clones'>;
    /** What a later run of the same folder can reuse (pass it as `options.previous`). */
    previous: PreviousRun;
}

export async function extractProject(folder: string, options: ExtractOptions = {}): Promise<ExtractionResult> {
    const run = startRun(folder, options);
    const { root, config, progress } = run;
    const llmLog: LlmLog = { accepted: [], rejected: [] };
    const record = (log: LlmLog) => {
        llmLog.accepted.push(...log.accepted);
        llmLog.rejected.push(...log.rejected);
    };
    const llm = options.llm ? metered(cachedProvider(options.llm, options.cacheDir ?? join(root, '.provenflow', 'cache'))) : undefined;
    const facts = await readFacts(run, llm, record);

    await progress('models', `Building models from ${facts.stateVariables.length} state variable(s), ${facts.resources.length} resource operation(s) and ${facts.classes.length} class(es)…`);
    const { machines, lifecycles, patterns, architecture, paradigm, quality } = analyses(run, facts);
    const instances = [...patterns.instances, ...architecture.facades];
    let models = [...machines.models, ...lifecycles.models, ...patterns.models, ...architecture.models];
    if (llm) {
        await progress('models', `Asking ${llm.name} for requirements of ${models.length} model(s)…`, 1, 2);
        const suggested = await suggestProperties(models, root, llm);
        record(suggested.log);
        models = suggested.models;
    }
    const verification = await verifyModels(models, options.checker, (m, i, n) =>
        progress('verify', `Checking model ${i + 1}/${n} with ${options.checker ? 'nuXmv' : 'the explicit-state checker'}: ${m.subject} (${m.model.specs.length} properties)…`, i, n)
    );
    const drift = driftPhase(run);
    const analysed = withAdvisories(await analyzersPhase(run, facts), await advisoriesPhase(run));
    const tools = { ...analysed, notes: [...analysed.notes, ...drift.notes] };

    let findings = dedupe([
        ...machines.findings,
        ...lifecycles.findings,
        ...patterns.findings,
        ...checkExpectations(config, instances, declaredInCode(facts)),
        ...architecture.findings,
        ...paradigm.findings,
        ...quality.findings,
        ...verification.findings,
        ...tools.findings,
        ...drift.findings
    ]);
    findings = selectFindings(applyIgnores(gradePatternFindings(findings, instances), config), config).sort(bySeverity);
    const fixes = await fixesPhase(run, findings, { facts, models, verification, tools, llm, record });
    findings = await confirmPhase(run, fixes.findings, models, facts);

    options.onProgress?.({ phase: 'done', message: `Done: ${findings.length} finding(s) on ${models.length} model(s).`, percent: 100 });
    return resultOf(run, { facts, models, findings, verification, instances, paradigm, architecture, quality, tools, fixes, llm: llm ? { provider: llm.name, ...llmLog, usage: llm.usage() } : undefined });
}

interface Outcome {
    facts: Facts;
    models: ExtractedModel[];
    findings: Finding[];
    verification: { verdicts: SpecVerdict[]; errors: string[] };
    instances: PatternInstance[];
    paradigm: { profiles: ParadigmProfile[] };
    architecture: Pick<ArchitectureResult, 'edges'>;
    quality: QualityResult;
    tools: AnalyzerOutput;
    fixes: { log: LlmLog; checks: string[] };
    llm: ExtractionResult['llm'];
}

function resultOf(run: Run, o: Outcome): ExtractionResult {
    const { options } = run;
    return {
        root: run.root,
        files: o.facts.files.length,
        config: run.config,
        facts: o.facts,
        models: o.models,
        findings: o.findings,
        verdicts: o.verification.verdicts,
        patterns: o.instances,
        paradigm: o.paradigm.profiles,
        architecture: { edges: o.architecture.edges },
        llm: o.llm,
        quickFixes: (options.quickFixes ?? 0) > 0 ? o.fixes.log : undefined,
        notes: [...o.facts.notes, ...o.verification.errors, ...uncheckedNote(o.verification.verdicts), ...o.tools.notes, ...o.quality.notes, ...selectionNotes(run.config)],
        checkedWith: options.checker && o.verification.errors.length < o.models.length ? 'nuxmv' : 'explicit',
        tools: o.tools.ran,
        proofs: o.tools.proofs,
        changeChecks: o.fixes.checks,
        incremental: run.changed ? { changed: [...run.changed].sort(), reused: run.reused } : undefined,
        quality: { metrics: reported(o.quality.metrics, o.findings), conventions: o.quality.conventions, clones: o.quality.clones },
        previous: { fingerprints: run.prints, settings: run.settings, findings: o.findings, proofs: o.tools.proofs, tools: o.tools.ran, models: o.models, verdicts: o.verification.verdicts }
    };
}

/** The measures counting findings, after the config's `ignore` entries (what is reported). */
function reported(metrics: QualityMetrics, findings: Finding[]): QualityMetrics {
    const count = (rule: string) => findings.filter(f => f.rule === rule).length;
    return { ...metrics, naming: { ...metrics.naming, inconsistent: count('naming-convention') }, dependencies: { unknown: count('unknown-dependency'), undeclared: count('undeclared-dependency') } };
}

/** The analyses of the facts: models of state machines, lifecycles, patterns and layers; paradigm and quality rules. */
function analyses(run: Run, facts: Facts) {
    const { config } = run;
    return {
        machines: buildStateMachines(facts, config),
        lifecycles: buildLifecycles(facts),
        patterns: selectPatterns(analysePatterns(facts, config), config),
        architecture: selectPatterns(analyseArchitecture(facts, config), config),
        paradigm: analyseParadigm(facts, config),
        quality: analyseQuality(facts, config, run.readFile, { coverageReports: run.options.coverage, churn: churnOf(run) })
    };
}

/** The commits per file, for the hotspots; not for a check of a proposed change or another version (overrides). */
function churnOf(run: Run): Churn | undefined {
    const { config, options } = run;
    if (config.hotspots === false || options.rerunOf || options.overrides?.size) return undefined;
    return readChurn(run.root, config.hotspots?.months);
}

/** One analysis: its folder, config and files, and what it can reuse from the previous run. */
interface Run {
    root: string;
    options: ExtractOptions;
    config: ProvenflowConfig;
    files: string[];
    readFile: (file: string) => string | undefined;
    progress: ReturnType<typeof reporter>;
    prints: Record<string, string>;
    settings: string;
    previous?: PreviousRun;
    /** Files changed since the previous run (incremental runs only). */
    changed?: Set<string>;
    prevByKey: Map<string, Finding>;
    reused: { patches: number; confirmations: number; toolFindings: number };
}

function startRun(folder: string, options: ExtractOptions): Run {
    const root = resolve(folder);
    const config = withChecks(options.config ?? loadConfig(root, options.configFile), options.checks);
    const listed = listSourceFiles(root, config.include, config.exclude);
    // Files given only as overrides (a version where they existed: pflow compare --base) are analysed too.
    const isSource = sourceFilter(config.include, config.exclude);
    const restored = [...(options.overrides ?? [])].filter(([f, text]) => text.trim() && isSource(f) && !listed.includes(f)).map(([f]) => f);
    const files = [...listed, ...restored].sort();
    const readFile = (file: string) => options.overrides?.get(file) ?? readSafe(join(root, file));
    const prints = options.rerunOf ? {} : fingerprints(files, readFile);
    const settings = settingsKey(config, { quickFixes: options.quickFixes ?? 0, llm: options.llm?.name, llmFixes: options.llmFixes ?? 0, analyzers: options.analyzers !== false, confirm: options.confirm !== false, buildChecks: options.buildChecks !== false, nuxmv: !!options.checker });
    const previous = !options.rerunOf && options.previous?.settings === settings ? options.previous : undefined;
    return {
        root,
        options,
        config,
        files,
        readFile,
        progress: reporter(options.onProgress),
        prints,
        settings,
        previous,
        changed: previous ? changedFiles(previous.fingerprints, prints) : undefined,
        prevByKey: new Map((previous?.findings ?? []).map(f => [findingKey(f), f])),
        reused: { patches: 0, confirmations: 0, toolFindings: 0 }
    };
}

/** The facts of every file, from the front end of its language (and the LLM's values for computed writes). */
async function readFacts(run: Run, llm: (LlmProvider & { usage(): LlmUsage & { calls: number; cached: number } }) | undefined, record: (log: LlmLog) => void): Promise<Facts> {
    const { root, files, options, progress } = run;
    const isTypeScript = (f: string) => /\.(ts|tsx|mts|cts)$/.test(f);
    const ts = files.filter(isTypeScript);
    const py = files.filter(f => f.endsWith('.py'));
    const other = files.filter(f => !isTypeScript(f) && !f.endsWith('.py') && TREE_SITTER_EXTENSIONS.some(e => f.endsWith(e)));
    await progress('parse', `Found ${files.length} source files${run.changed ? ` (${run.changed.size} changed since the last run)` : ''}. Reading ${ts.length} TypeScript file(s) with the type checker…`, 0, 3);
    const tsFacts = extractTypeScript(root, ts, options.overrides);
    await progress('parse', `Reading ${py.length} Python file(s)…`, 1, 3);
    const pyFacts = extractPython(root, py, options.overrides);
    await progress('parse', `Reading ${other.length} file(s) of the other languages (tree-sitter)…`, 2, 3);
    const parsed = mergeFacts(mergeFacts(tsFacts, pyFacts), await extractTreeSitter(root, other, options.overrides));
    if (!llm) return parsed;
    await progress('parse', `Asking ${llm.name} which values the computed writes can set…`, 3, 3);
    const resolved = await resolveDynamicWrites(parsed, llm);
    record(resolved.log);
    return { ...parsed, writes: resolved.writes };
}

/** External analysers: security and dataflow (Semgrep, CodeQL), heap (Infer), code model checking (ESBMC/CBMC, Kani). */
async function analyzersPhase(run: Run, facts: Facts): Promise<AnalyzerOutput> {
    const { options, config, files, changed } = run;
    const none: AnalyzerOutput = { findings: [], proofs: [], fixes: [], notes: [], ran: [] };
    const mayRun = analyzersMayRun(config, files);
    if (options.analyzers === false) return none;
    if (!mayRun) return options.rerunOf ? none : { ...none, notes: missingAnalyzers(config, files) };
    const changedSources = changed ? [...changed].filter(f => files.includes(f)) : undefined;
    // Incremental, and no source changed: the previous results stand.
    const tools = changedSources?.length === 0 ? none : await runInstalledAnalyzers(run, facts, changedSources);
    return run.previous && changed ? withPreviousTools(run, tools) : tools;
}

async function runInstalledAnalyzers(run: Run, facts: Facts, changedSources: string[] | undefined): Promise<AnalyzerOutput> {
    const { root, options, config, progress } = run;
    const workspace = options.overrides?.size ? materialize(root, options.overrides) : undefined;
    try {
        await progress('analyzers', changedSources ? `Running the installed analysers on the ${changedSources.length} changed file(s)…` : 'Running the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani)…');
        let finished = 0;
        return await runAnalyzers({ root, dir: workspace?.dir ?? root, facts, config, env: process.env, onlyFiles: options.rerunOf ?? changedSources }, (name, running, out) => {
            finished++;
            if (out.ran.length) void progress('analyzers', `${name} finished (${out.findings.length} finding(s)${out.proofs.length ? `, ${out.proofs.length} proof(s)` : ''})${running.length ? `; still running: ${running.join(', ')}` : ''}…`, finished, 6);
        });
    } finally {
        workspace?.dispose();
    }
}

/** Where the code base's own C4 model (workspace.dsl) and its code disagree; not for a proposed change or another version. */
function driftPhase(run: Run): { findings: Finding[]; notes: string[] } {
    const { config, options } = run;
    if (config.c4 === false || options.rerunOf || options.overrides?.size) return { findings: [], notes: [] };
    try {
        const drift = modelDrift(run.root, config.c4?.model);
        return { findings: drift.findings, notes: drift.notes };
    } catch (error) {
        return { findings: [], notes: [`C4 model not compared with the code: ${(error as Error).message}`] };
    }
}

/** Known vulnerabilities of the locked dependency versions (osv.dev), when asked for; not when checking a proposed change. */
async function advisoriesPhase(run: Run): Promise<AdvisoryResult | undefined> {
    const { root, config, options, progress } = run;
    const advisories = { ...config.advisories, osv: options.osv || config.advisories?.osv };
    if (!advisories.osv || options.rerunOf) return undefined;
    await progress('analyzers', 'Asking the OSV database about the locked dependency versions…');
    return vulnerableDependencies(root, advisories, { fetch: options.fetch, cacheDir: options.cacheDir ? join(options.cacheDir, 'osv') : join(root, '.provenflow', 'cache', 'osv'), exclude: config.exclude });
}

function withAdvisories(tools: AnalyzerOutput, advisories: AdvisoryResult | undefined): AnalyzerOutput {
    return advisories ? { ...tools, findings: [...tools.findings, ...advisories.findings], notes: [...tools.notes, ...advisories.notes] } : tools;
}

/** Analyser results on unchanged files are still valid. */
function withPreviousTools(run: Run, tools: AnalyzerOutput): AnalyzerOutput {
    const previous = run.previous!;
    const changed = run.changed!;
    const kept = previous.findings.filter(f => isToolFinding(f) && f.loc && !changed.has(f.loc.file) && run.files.includes(f.loc.file)).map(({ suggestedPatch: _p, confirmation: _c, ...f }) => f as Finding);
    run.reused.toolFindings = kept.length;
    return { ...tools, findings: [...tools.findings, ...kept], proofs: [...tools.proofs, ...previous.proofs.filter(p => !p.loc || !changed.has(p.loc.file))], ran: tools.ran.length ? tools.ran : previous.tools };
}

interface FixInputs {
    facts: Facts;
    models: ExtractedModel[];
    verification: { verdicts: SpecVerdict[] };
    tools: AnalyzerOutput;
    llm?: LlmProvider;
    record: (log: LlmLog) => void;
}

/** Proposed changes: quick fixes (and analyser autofixes), then LLM patches; each verified. */
async function fixesPhase(run: Run, initial: Finding[], inputs: FixInputs): Promise<{ findings: Finding[]; log: LlmLog; checks: string[] }> {
    const { root, options, config, files, progress } = run;
    const log: LlmLog = { accepted: [], rejected: [] };
    const rerun = rerunner(root, config, options);
    const proposing = (options.quickFixes ?? 0) > 0 || (!!inputs.llm && (options.llmFixes ?? 0) > 0);
    const detected = proposing && options.buildChecks !== false && !options.rerunOf ? detectChecks(root, files, config) : { build: [], test: [] };
    const changeChecker = new ChangeChecker(root, [...detected.build, ...detected.test], config.verification?.timeoutSec ?? 300);
    const buildCheck = changeChecker.enabled ? (overrides: Map<string, string>) => changeChecker.check(overrides) : undefined;
    const baseline = { models: inputs.models, verdicts: inputs.verification.verdicts };
    let findings = initial;
    if ((options.quickFixes ?? 0) > 0) {
        const proposals = proposalsFor(run, findings, inputs);
        if (run.previous && run.changed) findings = findings.map(f => reusePatch(f, run.prevByKey.get(findingKey(f)), run.changed!, run.reused));
        const fixed = await verifyProposals(findings, proposals(findings), root, rerun, run.readFile, baseline, buildCheck, (p, i, n) =>
            progress('fixes', `Verifying proposed change ${i + 1}/${n}: ${p.finding.rule} on ${p.finding.subject} (re-running the analysis${buildCheck ? ' and the build' : ''})…`, i, n)
        );
        log.accepted.push(...fixed.accepted);
        log.rejected.push(...fixed.rejected);
        findings = fixed.findings;
    }
    if (inputs.llm && (options.llmFixes ?? 0) > 0) {
        const llm = inputs.llm;
        await progress('llm', `Asking ${llm.name} for patches (up to ${options.llmFixes})…`);
        const fixed = await suggestFixes(findings, root, llm, rerun, options.llmFixes, baseline, buildCheck, (p, i, n) => progress('llm', `Verifying ${llm.name}'s patch ${i + 1}/${n}: ${p.finding.rule} on ${p.finding.subject}…`, i, n));
        inputs.record(fixed.log);
        findings = fixed.findings;
    }
    return { findings, log, checks: [...detected.build, ...detected.test].map(c => `${c.name}: ${c.command}`) };
}

/** The quick fixes and analyser autofixes to verify, for the findings without a proposal (new ones only, on an incremental run). */
function proposalsFor(run: Run, initial: Finding[], inputs: FixInputs): (findings: Finding[]) => Proposal[] {
    const byFinding = new Set(initial);
    const toolProposals: Proposal[] = inputs.tools.fixes
        .map(fx => ({ finding: initial.find(f => f.rule === fx.finding.rule && f.loc?.file === fx.finding.loc?.file && f.loc?.line === fx.finding.loc?.line) ?? fx.finding, edits: [{ file: fx.file, search: fx.search, replace: fx.replace }], explanation: fx.explanation, by: 'semgrep autofix' }))
        .filter(p => byFinding.has(p.finding));
    const fresh = (p: Proposal) => !run.previous || !run.changed || !run.prevByKey.has(findingKey(p.finding)) || touches(p.finding, run.changed) || p.edits.some(e => run.changed!.has(e.file));
    return findings => [...quickFixes(findings, inputs.facts, inputs.models, run.readFile, run.config), ...toolProposals].filter(p => !p.finding.suggestedPatch && fresh(p)).slice(0, run.options.quickFixes);
}

/** Findings checked on the code itself: counterexamples replayed, C state machines model checked. */
const DEFAULT_REPLAYS = 12;

async function confirmPhase(run: Run, findings: Finding[], models: ExtractedModel[], facts: Facts): Promise<Finding[]> {
    const { options, progress, root, config } = run;
    if (options.confirm === false || options.rerunOf) return findings;
    await progress('confirm', 'Replaying counterexamples on the real code…');
    // Incremental: a finding on an unchanged file keeps its confirmation.
    const keep = new Map<Finding, Finding>();
    for (const f of run.previous && run.changed ? findings : []) {
        const before = run.prevByKey.get(findingKey(f));
        if (before?.confirmation && !touches(f, run.changed!)) keep.set(f, { ...f, confirmation: before.confirmation });
    }
    run.reused.confirmations = keep.size;
    const replayed = await confirmFindings(findings.filter(f => !keep.has(f)), models, facts, root, options.replayLimit ?? DEFAULT_REPLAYS, (f, i, n) => progress('confirm', `Replaying on the real code ${i + 1}/${n}: ${f.rule} on ${f.subject}…`, i, n));
    let next = 0;
    const confirmed = findings.map(f => keep.get(f) ?? replayed[next++]);
    await progress('confirm', 'Checking C state machines on the code…', 9, 10);
    return confirmInC(confirmed, models, facts, root, config);
}

/** Re-runs the analysis with some files replaced (in memory), to check a change. */
function rerunner(root: string, config: ProvenflowConfig, options: ExtractOptions): Rerun {
    return async overrides => {
        // A change of provenflow.config.json is part of the change being checked.
        const changedConfig = overrides.get(CONFIG_FILE);
        const r = await extractProject(root, {
            config: changedConfig ? (JSON.parse(changedConfig) as ProvenflowConfig) : config,
            checker: options.checker,
            overrides: new Map([...(options.overrides ?? []), ...overrides]),
            analyzers: options.analyzers,
            confirm: false,
            rerunOf: [...overrides.keys()]
        });
        return { findings: r.findings, models: r.models, verdicts: r.verdicts };
    };
}

/**
 * What checking one change of a project needs (for fixWithLlm and verifyVersion): its last results
 * (`options.previous`, or a new analysis without proposals), the re-run, and its build checks.
 */
export async function changeContext(root: string, options: ExtractOptions = {}): Promise<ChangeContext> {
    const config = options.config ?? loadConfig(root, options.configFile);
    const baseline = options.previous ?? (await extractProject(root, { ...options, previous: undefined, quickFixes: 0, llmFixes: 0, confirm: false })).previous;
    const files = listSourceFiles(root, config.include, config.exclude);
    const detected = options.buildChecks !== false ? detectChecks(root, files, config) : { build: [], test: [] };
    const checker = new ChangeChecker(root, [...detected.build, ...detected.test], config.verification?.timeoutSec ?? 300);
    return { root, baseline, rerun: rerunner(root, config, options), buildCheck: checker.enabled ? overrides => checker.check(overrides) : undefined };
}

/** The fix the analysis can make for one finding, without an LLM (a verified quick fix, or a draft to complete). */
export async function fixWithoutLlm(ctx: ChangeContext, finding: Finding, options: ExtractOptions = {}, onEvent?: (e: SingleChangeEvent) => void): Promise<SingleChangeResult> {
    onEvent?.({ type: 'stage', text: 'Analysing the project again to compute the fix…' });
    const config = options.config ?? loadConfig(ctx.root, options.configFile);
    const r = await extractProject(ctx.root, { ...options, config, previous: undefined, analyzers: false, confirm: false, quickFixes: 0, llm: undefined, llmFixes: 0 });
    return fixFromAnalysis(ctx, finding, { findings: r.findings, facts: r.facts, models: r.models, config }, onEvent);
}

/** The previous proposal for a finding, when neither the finding nor the proposal touches a changed file. */
function reusePatch(f: Finding, before: Finding | undefined, changed: Set<string>, reused: { patches: number }): Finding {
    if (f.suggestedPatch || !before?.suggestedPatch || touches(f, changed) || touches(before, changed)) return f;
    reused.patches++;
    return { ...f, suggestedPatch: before.suggestedPatch };
}

/** Whether any external analyser can run here (avoids copying the project for nothing). */
function analyzersMayRun(config: ProvenflowConfig, files: string[]): boolean {
    const a = config.analyzers ?? {};
    if (a.sarif?.length) return true;
    if (a.semgrep !== false && findTool('semgrep')) return true;
    if (a.infer !== false && findTool('infer') && files.some(f => /\.(c|cc|cpp|cxx|m|mm|java)$/.test(f))) return true;
    if (a.bmc !== false && (findTool('esbmc') || findTool('cbmc')) && files.some(f => /\.(c|cc|cpp|cxx)$/.test(f))) return true;
    if (a.kani !== false && findTool('cargo') && files.some(f => f.endsWith('.rs'))) return true;
    if (a.codeql && findTool('codeql')) return true;
    return false;
}

/** What installing an analyser would add, for the languages of the project. */
function missingAnalyzers(config: ProvenflowConfig, files: string[]): string[] {
    const a = config.analyzers ?? {};
    const has = (re: RegExp) => files.some(f => re.test(f));
    const missing: string[] = [];
    if (a.semgrep !== false) missing.push('Semgrep is not installed (brew install semgrep or pip install semgrep, or set SEMGREP_PATH): security and dataflow rules were not run.');
    if (a.infer !== false && has(/\.(c|cc|cpp|cxx|m|mm|java)$/)) missing.push('Infer is not installed (github.com/facebook/infer releases, or set INFER_PATH): no interprocedural heap analysis (null dereferences, leaks).');
    if (a.bmc !== false && has(/\.(c|cc|cpp|cxx)$/)) missing.push('Neither ESBMC nor CBMC is installed (brew install cbmc esbmc, the CBMC .deb on Ubuntu, or set ESBMC_PATH or CBMC_PATH): memory safety and overflows of the C/C++ code were not model checked.');
    if (a.kani !== false && has(/\.rs$/)) missing.push('Kani is not installed (cargo install --locked kani-verifier; cargo kani setup): the Rust code was not model checked.');
    return missing;
}

/** Unreachable values of C state variables, checked on the code by ESBMC/CBMC with a harness. */
async function confirmInC(findings: Finding[], models: ExtractedModel[], facts: Facts, root: string, config: ProvenflowConfig): Promise<Finding[]> {
    if (config.analyzers?.bmc === false || (!findTool('esbmc') && !findTool('cbmc'))) return findings;
    const out: Finding[] = [];
    for (const f of findings) {
        const model = models.find(m => m.id === f.model);
        const variable = facts.stateVariables.find(v => v.id === model?.variableId);
        const value = f.states?.[0];
        if (f.rule !== 'unreachable-state' || !variable || !value || f.confirmation || !/\.c$/.test(variable.loc.file) || variable.owner === undefined) {
            out.push(f);
            continue;
        }
        const functions = facts.functions.filter(fn => fn.loc.file === variable.loc.file && fn.free && fn.params === 0 && fn.name !== 'main').map(fn => fn.name);
        const field = variable.name.split('.').pop()!;
        const r = await confirmUnreachableInC({ root, dir: root, facts, config, env: process.env }, variable.loc.file, field, value, functions);
        out.push(r ? { ...f, confirmation: { by: 'bounded model checking', ...r } } : f);
    }
    return out;
}

function uncheckedNote(verdicts: SpecVerdict[]): string[] {
    const unchecked = verdicts.filter(v => v.by === 'none');
    return unchecked.length > 0 ? [`${unchecked.length} declared or suggested propert${unchecked.length === 1 ? 'y was' : 'ies were'} not checked without nuXmv (${unchecked.slice(0, 3).map(v => `${v.model}: ${v.spec}`).join(', ')}${unchecked.length > 3 ? ', ...' : ''}). Set NUXMV_PATH.`] : [];
}

const ORDER = { error: 0, warning: 1, info: 2 } as const;

function bySeverity(a: Finding, b: Finding): number {
    return ORDER[a.severity] - ORDER[b.severity] || a.category.localeCompare(b.category) || (a.loc?.file ?? '').localeCompare(b.loc?.file ?? '') || (a.loc?.line ?? 0) - (b.loc?.line ?? 0);
}

/** The same problem found twice (e.g. by the graph check and by nuXmv) is reported once, keeping the proof. */
function dedupe(findings: Finding[]): Finding[] {
    const result: Finding[] = [];
    for (const f of findings) {
        const same = result.findIndex(x => x.rule === f.rule && x.subject === f.subject && x.loc?.file === f.loc?.file && x.loc?.line === f.loc?.line);
        if (same < 0) result.push(f);
        else if (f.source === 'nuxmv' || (f.counterexample && !result[same].counterexample)) result[same] = f;
    }
    return result;
}

/** The config with `checks` overridden by the options' select and skip lists (each one only when given). */
function withChecks(config: ProvenflowConfig, checks: ChecksConfig | undefined): ProvenflowConfig {
    if (!checks?.select && !checks?.skip) return config;
    return { ...config, checks: { ...config.checks, ...(checks.select ? { select: checks.select } : {}), ...(checks.skip ? { skip: checks.skip } : {}) } };
}

function applyIgnores(findings: Finding[], config: ProvenflowConfig): Finding[] {
    const rules = config.ignore ?? [];
    return findings.filter(
        f => !rules.some(r => (r.rule === '*' || r.rule === f.rule) && (!r.subject || f.subject === r.subject || f.subject.startsWith(`${r.subject}.`) || f.subject.startsWith(`${r.subject} `)) && (!r.file || (f.loc && matchesAny(f.loc.file, [r.file]))))
    );
}
