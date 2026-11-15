/**
 * @provenflow/extract: the facade of the package (other packages import only from here).
 * The pipeline is in project.ts; each analysis in its own module.
 */
export * from './project.js';
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
export * from './quality/index.js';
export * from './gate.js';
export { compareResults, comparisonMarkdown, type Comparison } from './compare.js';
export { proposeConfig, type ProposedConfig } from './init.js';
export { readInstructions, rulesFromInstructions, validateFragment, mergeConfigs, INSTRUCTION_FILES, type InstructionResult } from './instructions.js';
export { mutateLine, planMutants, runMutation, type MutationRun, type MutantResult } from './mutation.js';
export { runReview, projectReader, type ReviewOptions, type ReviewRun } from './review-run.js';
export type { QualityMetrics, QualityResult } from './quality/index.js';
export { fixWithLlm, verifyVersion, type ChangeContext, type ChangeEvent, type SingleChange } from './single-change.js';
export * from './report.js';
export { listSourceFiles } from './scan.js';
export { LANGUAGES } from './treesitter/frontend.js';
export type { Checker, SpecVerdict } from './verify.js';
export type { PatternInstance } from './patterns.js';
export type { ParadigmProfile } from './paradigm.js';
