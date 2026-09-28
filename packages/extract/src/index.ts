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
import { CONFIG_FILE, loadConfig, type ProvenflowConfig } from './config.js';
import { mergeFacts, type Facts } from './ir.js';
import { analyseArchitecture, type ArchitectureResult } from './architecture.js';
import { buildLifecycles } from './lifecycles.js';
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
import { listSourceFiles, matchesAny } from './scan.js';
import { extractTreeSitter, TREE_SITTER_EXTENSIONS } from './treesitter/frontend.js';
import { extractTypeScript } from './typescript-frontend.js';
import { verifyModels, type Checker, type SpecVerdict } from './verify.js';

export * from './config.js';
export * from './ir.js';
export * from './models.js';
export * from './llm.js';
export { isApplied, lineDiff, quickFixes, verifyProposals, type Edit, type Proposal } from './fixes.js';
export { BUNDLED_RULES, parseCbmcJson, parseEsbmc, parseKani, sarifToFindings, type ToolRun } from './analyzers/index.js';
export { detectChecks, runChecks, type CheckCommand, type CheckResult } from './buildcheck.js';
export * from './review.js';
export { cleanStaleWorkspaces, materialize } from './tools/workspace.js';
export type { OnProgress, Progress, ProgressPhase } from './progress.js';
export type { IncrementalInfo, PreviousRun } from './incremental.js';
export { findingKey } from './incremental.js';
export { fixWithLlm, verifyVersion, type ChangeContext, type ChangeEvent, type SingleChange } from './single-change.js';
import { fixWithoutLlm as fixFromAnalysis, type ChangeEvent as SingleChangeEvent, type SingleChange as SingleChangeResult } from './single-change.js';
export * from './report.js';
export { listSourceFiles } from './scan.js';
export { LANGUAGES } from './treesitter/frontend.js';
export type { Checker, SpecVerdict } from './verify.js';
export type { PatternInstance } from './patterns.js';
export type { ParadigmProfile } from './paradigm.js';

export interface ExtractOptions {
    config?: ProvenflowConfig;
    /** Path of the config file (default: <root>/provenflow.config.json). */
    configFile?: string;
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
    /** Build/type-check (and tests, when configured) proposed changes on a copy of the project. Default true. */
    buildChecks?: boolean;
    /** Internal: this run checks a proposed change (only the changed files are re-analysed by the tools). */
    rerunOf?: string[];
    /** Told what the analysis is doing, with an overall percentage (for long runs). */
    onProgress?: OnProgress;
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
    /** What a later run of the same folder can reuse (pass it as `options.previous`). */
    previous: PreviousRun;
}

export async function extractProject(folder: string, options: ExtractOptions = {}): Promise<ExtractionResult> {
    const root = resolve(folder);
    const progress = reporter(options.onProgress);
    const config = options.config ?? loadConfig(root, options.configFile);
    const files = listSourceFiles(root, config.include, config.exclude);
    const isTypeScript = (f: string) => /\.(ts|tsx|mts|cts)$/.test(f);
    const isTreeSitter = (f: string) => !isTypeScript(f) && !f.endsWith('.py') && TREE_SITTER_EXTENSIONS.some(e => f.endsWith(e));
    const ts = files.filter(isTypeScript);
    const py = files.filter(f => f.endsWith('.py'));
    const other = files.filter(isTreeSitter);
    const readFile = (file: string) => options.overrides?.get(file) ?? readSafe(join(root, file));
    const prints = options.rerunOf ? {} : fingerprints(files, readFile);
    const settings = settingsKey(config, { quickFixes: options.quickFixes ?? 0, llm: options.llm?.name, llmFixes: options.llmFixes ?? 0, analyzers: options.analyzers !== false, confirm: options.confirm !== false, buildChecks: options.buildChecks !== false, nuxmv: !!options.checker });
    const previous = !options.rerunOf && options.previous?.settings === settings ? options.previous : undefined;
    const changed = previous ? changedFiles(previous.fingerprints, prints) : undefined;
    const prevByKey = new Map((previous?.findings ?? []).map(f => [findingKey(f), f]));
    const reused = { patches: 0, confirmations: 0, toolFindings: 0 };
    await progress('parse', `Found ${files.length} source files${changed ? ` (${changed.size} changed since the last run)` : ''}. Reading ${ts.length} TypeScript file(s) with the type checker…`, 0, 3);
    const tsFacts = extractTypeScript(root, ts, options.overrides);
    await progress('parse', `Reading ${py.length} Python file(s)…`, 1, 3);
    const pyFacts = extractPython(root, py, options.overrides);
    await progress('parse', `Reading ${other.length} file(s) of the other languages (tree-sitter)…`, 2, 3);
    const parsed = mergeFacts(mergeFacts(tsFacts, pyFacts), await extractTreeSitter(root, other, options.overrides));

    const llmLog: LlmLog = { accepted: [], rejected: [] };
    const fixLog: LlmLog = { accepted: [], rejected: [] };
    const record = (log: LlmLog) => {
        llmLog.accepted.push(...log.accepted);
        llmLog.rejected.push(...log.rejected);
    };
    const llm = options.llm ? metered(cachedProvider(options.llm, options.cacheDir ?? join(root, '.provenflow', 'cache'))) : undefined;
    let facts = parsed;
    if (llm) {
        await progress('parse', `Asking ${llm.name} which values the computed writes can set…`, 3, 3);
        const resolved = await resolveDynamicWrites(parsed, llm);
        record(resolved.log);
        facts = { ...parsed, writes: resolved.writes };
    }

    await progress('models', `Building models from ${facts.stateVariables.length} state variable(s), ${facts.resources.length} resource operation(s) and ${facts.classes.length} class(es)…`);
    const machines = buildStateMachines(facts, config);
    const lifecycles = buildLifecycles(facts);
    const patterns = analysePatterns(facts, config);
    const architecture = analyseArchitecture(facts, config);
    const instances = [...patterns.instances, ...architecture.facades];
    const paradigm = analyseParadigm(facts, config);
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

    // External analysers: security and dataflow (Semgrep, CodeQL), heap (Infer), code model checking (ESBMC/CBMC, Kani).
    let tools: AnalyzerOutput = { findings: [], proofs: [], fixes: [], notes: [], ran: [] };
    if (options.analyzers !== false && !options.rerunOf && !analyzersMayRun(config, files)) tools.notes.push(...missingAnalyzers(config, files));
    const changedSources = changed ? [...changed].filter(f => files.includes(f)) : undefined;
    if (options.analyzers !== false && analyzersMayRun(config, files) && changedSources?.length !== 0) {
        const workspace = options.overrides?.size ? materialize(root, options.overrides) : undefined;
        try {
            await progress('analyzers', changedSources ? `Running the installed analysers on the ${changedSources.length} changed file(s)…` : 'Running the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani)…');
            let finished = 0;
            tools = await runAnalyzers({ root, dir: workspace?.dir ?? root, facts, config, env: process.env, onlyFiles: options.rerunOf ?? changedSources }, (name, running, out) => {
                finished++;
                if (out.ran.length === 0) return;
                void progress('analyzers', `${name} finished (${out.findings.length} finding(s)${out.proofs.length ? `, ${out.proofs.length} proof(s)` : ''})${running.length ? `; still running: ${running.join(', ')}` : ''}…`, finished, 6);
            });
        } finally {
            workspace?.dispose();
        }
    }
    if (previous && changed) {
        // Analyser results on unchanged files are still valid.
        const kept = previous.findings.filter(f => isToolFinding(f) && f.loc && !changed.has(f.loc.file) && files.includes(f.loc.file)).map(({ suggestedPatch: _p, confirmation: _c, ...f }) => f as Finding);
        reused.toolFindings = kept.length;
        tools = {
            ...tools,
            findings: [...tools.findings, ...kept],
            proofs: [...tools.proofs, ...previous.proofs.filter(p => !p.loc || !changed.has(p.loc.file))],
            ran: tools.ran.length ? tools.ran : previous.tools
        };
    }

    let findings = dedupe([
        ...machines.findings,
        ...lifecycles.findings,
        ...patterns.findings,
        ...checkExpectations(config, instances, declaredInCode(facts)),
        ...architecture.findings,
        ...paradigm.findings,
        ...verification.findings,
        ...tools.findings
    ]);
    findings = applyIgnores(gradePatternFindings(findings, instances), config).sort(bySeverity);

    const rerun = rerunner(root, config, options);
    const proposing = (options.quickFixes ?? 0) > 0 || (!!llm && (options.llmFixes ?? 0) > 0);
    const detected = proposing && options.buildChecks !== false && !options.rerunOf ? detectChecks(root, files, config) : { build: [], test: [] };
    const changeChecker = new ChangeChecker(root, [...detected.build, ...detected.test], config.verification?.timeoutSec ?? 300);
    const buildCheck = changeChecker.enabled ? (overrides: Map<string, string>) => changeChecker.check(overrides) : undefined;
    const read = (file: string) => options.overrides?.get(file) ?? readSafe(join(root, file));
    if ((options.quickFixes ?? 0) > 0) {
        const byFinding = new Map(findings.map(f => [f, f]));
        const toolProposals: Proposal[] = tools.fixes
            .map(fx => ({ finding: findings.find(f => f.rule === fx.finding.rule && f.loc?.file === fx.finding.loc?.file && f.loc?.line === fx.finding.loc?.line) ?? fx.finding, edits: [{ file: fx.file, search: fx.search, replace: fx.replace }], explanation: fx.explanation, by: 'semgrep autofix' }))
            .filter(p => byFinding.has(p.finding));
        // Incremental: findings untouched by the change keep the proposal verified last time.
        if (previous && changed) findings = findings.map(f => reusePatch(f, prevByKey.get(findingKey(f)), changed, reused));
        const fresh = (p: Proposal) => !previous || !changed || !prevByKey.has(findingKey(p.finding)) || touches(p.finding, changed) || p.edits.some(e => changed.has(e.file));
        const proposals = [...quickFixes(findings, facts, models, read, config), ...toolProposals].filter(p => !p.finding.suggestedPatch && fresh(p)).slice(0, options.quickFixes);
        const fixed = await verifyProposals(findings, proposals, root, rerun, read, { models, verdicts: verification.verdicts }, buildCheck, (p, i, n) =>
            progress('fixes', `Verifying proposed change ${i + 1}/${n}: ${p.finding.rule} on ${p.finding.subject} (re-running the analysis${buildCheck ? ' and the build' : ''})…`, i, n)
        );
        fixLog.accepted.push(...fixed.accepted);
        fixLog.rejected.push(...fixed.rejected);
        findings = fixed.findings;
    }
    if (llm && (options.llmFixes ?? 0) > 0) {
        await progress('llm', `Asking ${llm.name} for patches (up to ${options.llmFixes})…`);
        const fixed = await suggestFixes(findings, root, llm, rerun, options.llmFixes, { models, verdicts: verification.verdicts }, buildCheck, (p, i, n) =>
            progress('llm', `Verifying ${llm.name}'s patch ${i + 1}/${n}: ${p.finding.rule} on ${p.finding.subject}…`, i, n)
        );
        record(fixed.log);
        findings = fixed.findings;
    }

    // Findings checked on the code itself: counterexamples replayed, C state machines model checked.
    if (options.confirm !== false && !options.rerunOf) {
        await progress('confirm', 'Replaying counterexamples on the real code…');
        // Incremental: a finding on an unchanged file keeps its confirmation.
        const keep = new Map<Finding, Finding>();
        if (previous && changed) {
            for (const f of findings) {
                const before = prevByKey.get(findingKey(f));
                if (before?.confirmation && !touches(f, changed)) keep.set(f, { ...f, confirmation: before.confirmation });
            }
            reused.confirmations = keep.size;
        }
        const replayed = await confirmFindings(findings.filter(f => !keep.has(f)), models, facts, root, 12, (f, i, n) => progress('confirm', `Replaying on the real code ${i + 1}/${n}: ${f.rule} on ${f.subject}…`, i, n));
        let next = 0;
        findings = findings.map(f => keep.get(f) ?? replayed[next++]);
        await progress('confirm', 'Checking C state machines on the code…', 9, 10);
        findings = await confirmInC(findings, models, facts, root, config);
    }

    options.onProgress?.({ phase: 'done', message: `Done: ${findings.length} finding(s) on ${models.length} model(s).`, percent: 100 });
    return {
        root,
        files: facts.files.length,
        config,
        facts,
        models,
        findings,
        verdicts: verification.verdicts,
        patterns: instances,
        paradigm: paradigm.profiles,
        architecture: { edges: architecture.edges },
        llm: llm ? { provider: llm.name, ...llmLog, usage: llm.usage() } : undefined,
        quickFixes: (options.quickFixes ?? 0) > 0 ? fixLog : undefined,
        notes: [...facts.notes, ...verification.errors, ...uncheckedNote(verification.verdicts), ...tools.notes],
        checkedWith: options.checker && verification.errors.length < models.length ? 'nuxmv' : 'explicit',
        tools: tools.ran,
        proofs: tools.proofs,
        changeChecks: [...detected.build, ...detected.test].map(c => `${c.name}: ${c.command}`),
        incremental: changed ? { changed: [...changed].sort(), reused } : undefined,
        previous: { fingerprints: prints, settings, findings, proofs: tools.proofs, tools: tools.ran, models, verdicts: verification.verdicts }
    };
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

function applyIgnores(findings: Finding[], config: ProvenflowConfig): Finding[] {
    const rules = config.ignore ?? [];
    return findings.filter(
        f => !rules.some(r => (r.rule === '*' || r.rule === f.rule) && (!r.subject || f.subject === r.subject || f.subject.startsWith(`${r.subject}.`) || f.subject.startsWith(`${r.subject} `)) && (!r.file || (f.loc && matchesAny(f.loc.file, [r.file]))))
    );
}
