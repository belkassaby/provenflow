/**
 * `provenflow.config.json`: what the project promises about itself. Every
 * part is optional; without it `pflow extract` still extracts the models and
 * runs the checks that need no declared intent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from './ir.js';

export type Style = 'functional' | 'object-oriented' | 'any';

export const PATTERNS = ['singleton', 'observer', 'factory', 'strategy', 'builder', 'adapter', 'decorator', 'state', 'command', 'facade'] as const;
export type PatternName = (typeof PATTERNS)[number];

export interface LayerConfig {
    name: string;
    /** Globs of the files in the layer. */
    paths: string[];
    /** Layers this layer may import (itself is always allowed). */
    mayImport?: string[];
    /** Programming style the layer follows; checked by the paradigm rules. */
    style?: Style;
}

export interface MachineConfig {
    /** States in which the machine may stop (overrides the naming heuristic). */
    terminal?: string[];
    /** Extra LTL/CTL properties, over `state = <value>`, e.g. "AG (state = closed -> AG state = closed)". */
    specs?: string[];
    /** Do not report this machine. */
    ignore?: boolean;
}

export interface PatternExpectation {
    /** Class, interface or function name. */
    subject: string;
    pattern: PatternName;
}

export interface IgnoreRule {
    rule: string;
    /** Subject (machine, class, file) the finding is about; all subjects when omitted. */
    subject?: string;
    /** Glob of files. */
    file?: string;
    reason?: string;
}

export interface Limits {
    classMethods: number;
    classLines: number;
    functionLines: number;
    inheritanceDepth: number;
    functionParams: number;
}

/** External analysers: each runs when its tool is installed, unless turned off (CodeQL is opt-in: it is slow). */
export interface AnalyzersConfig {
    /** Security and dataflow rules. `config`: extra Semgrep configs (e.g. "p/default", a rules folder); the bundled rules always run. */
    semgrep?: boolean | { config?: string[]; bundled?: boolean };
    /** CodeQL security queries (needs the codeql CLI; opt-in). */
    codeql?: boolean | { suite?: string };
    /** Infer: interprocedural heap analysis (null dereferences, leaks) of C, C++, Objective-C and Java. */
    infer?: boolean | { build?: string };
    /** Bounded model checking of C/C++ functions (memory safety, overflows): ESBMC or CBMC. */
    bmc?: boolean | { tool?: 'esbmc' | 'cbmc'; unwind?: number; timeoutSec?: number; maxFunctions?: number };
    /** Kani: bounded model checking of Rust (cargo kani autoharness). */
    kani?: boolean;
    /** SARIF reports of other tools to include (paths relative to the project). */
    sarif?: string[];
}

/** How a proposed change is checked on a copy of the project, besides re-running the analysis. */
export interface VerificationConfig {
    /** Build or type-check command (default: detected: tsc --noEmit, py_compile, go build, cargo check, mvn compile...; "" to skip). */
    build?: string;
    /** Test command (default: none for proposed changes; "auto" detects npm test, pytest, go test, cargo test, mvn test). */
    test?: string;
    timeoutSec?: number;
}

/** Duplicated code: copied blocks (clones) and functions that re-implement another one. */
export interface DuplicationConfig {
    /** Smallest clone reported, in tokens (default 100, as SonarQube). */
    minTokens?: number;
    /** Smallest clone reported, in lines (default 10). */
    minLines?: number;
    /** Also look for clones in test files (default false). */
    tests?: boolean;
    /** Token-bag overlap from which two functions are reported as similar (default 0.8). */
    similarity?: number;
    /** Smallest function compared for similarity, in tokens (default 50). */
    minFunctionTokens?: number;
}

/** Limits per function. */
export interface ComplexityConfig {
    /** Cognitive Complexity (SonarSource whitepaper) above which a function is reported (default 15). */
    cognitive?: number;
    /** Nesting depth of control structures above which a function is reported (default 4). */
    nesting?: number;
}

/** `MixedCaps`: camelCase or PascalCase (Go, where the case of the first letter is the visibility). */
export type NamingStyle = 'camelCase' | 'PascalCase' | 'snake_case' | 'SCREAMING_SNAKE_CASE' | 'MixedCaps';
export type NameKind = 'class' | 'function' | 'method' | 'field' | 'constant';

/** Test coverage reports to read (LCOV, Cobertura XML, JaCoCo XML), produced by the project's own test run. */
export interface CoverageConfig {
    reports?: string[];
    /** Severity of changed lines no test runs (default warning). */
    severity?: 'error' | 'warning' | 'info';
}

/** Mutation testing of changed lines (`pflow mutate`, `pflow review --mutate`). */
export interface MutationConfig {
    /** Test command (default: detected, as for "verification": { "test": "auto" }). */
    test?: string;
    /** At most this many mutants (default 20). */
    max?: number;
    timeoutSec?: number;
}

/** Stricter rules for lines written by coding agents (detected from commit trailers and Git AI notes). */
export interface AgentPolicyConfig {
    /** Severity at or above which findings on agent-written lines fail the check (default: warning). */
    failOn?: 'error' | 'warning' | 'info';
    /** Agent-written source changes must come with a changed test or covered lines (default true). */
    requireTests?: boolean;
    /** Extra author patterns (regular expressions) to recognise agents by. */
    authors?: string[];
}

/**
 * Coding standards of one language: limits, complexity and naming. `pflow init` writes them from the
 * language's style guide and main linter (quality/standards.ts); they take precedence over the
 * project-wide `limits`, `complexity` and `naming`.
 */
export interface LanguageConfig {
    limits?: Partial<Limits>;
    complexity?: ComplexityConfig;
    naming?: Partial<Record<NameKind, NamingStyle>>;
}

export interface ChecksConfig {
    /** Catalogue entries to check, instead of the default selection. */
    select?: string[];
    /** Catalogue entries not to check. */
    skip?: string[];
}

export interface AdvisoriesConfig {
    /** Ask osv.dev about the dependencies' versions. */
    osv?: boolean;
    /** Package names never sent (private packages), as globs: "@acme/*". Local and workspace packages are never sent. */
    private?: string[];
    /** The OSV API (default https://api.osv.dev). */
    url?: string;
}

export interface ProvenflowConfig {
    include?: string[];
    exclude?: string[];
    layers?: LayerConfig[];
    /** Imports between packages go through their entry point (index), not deep paths. */
    packageEntries?: boolean;
    machines?: Record<string, MachineConfig>;
    patterns?: PatternExpectation[];
    ignore?: IgnoreRule[];
    limits?: Partial<Limits>;
    analyzers?: AnalyzersConfig;
    verification?: VerificationConfig;
    /** `false` turns the duplication checks off. */
    duplication?: DuplicationConfig | false;
    /** `false` turns the complexity checks off. */
    complexity?: ComplexityConfig | false;
    /** Naming conventions per language and kind of name; inferred from the code when omitted. `false` turns the check off. */
    naming?: Partial<Record<string, Partial<Record<NameKind, NamingStyle>>>> | false;
    /** `false` turns off the check that imported packages are declared and exist. */
    dependencies?: boolean;
    coverage?: CoverageConfig;
    /** Hotspots: complexity weighed by the commits of the last `months` (default 12). `false` leaves git history out. */
    hotspots?: { months?: number } | false;
    /** Known vulnerabilities of the dependencies, from the OSV database (off by default: it sends package names and versions to osv.dev). */
    advisories?: AdvisoriesConfig;
    /** The code base's C4 model to compare with its code (default: docs/c4/workspace.dsl and the like); `false` turns the comparison off. */
    c4?: { model?: string } | false;
    /** Where each run's measures are kept for `pflow trends` (default .provenflow/history.jsonl); `false` keeps none. */
    history?: string | false;
    mutation?: MutationConfig;
    /** File of accepted findings (default provenflow-baseline.json when it exists): only findings not in it fail. */
    baseline?: string;
    agents?: AgentPolicyConfig;
    /**
     * Which entries of the patterns and practices catalogue to check (`pflow catalogue` lists them):
     * `select` replaces the default selection, `skip` removes entries from it. Findings of rules no
     * entry owns (security, state machines, dependencies...) are not affected.
     */
    checks?: ChecksConfig;
    /** Standards per language (typescript, python, java, kotlin, groovy, scala, c, cpp, c_sharp, go, rust, swift, ruby, php, r). */
    languages?: Partial<Record<Language, LanguageConfig>>;
}

/** The size limits that apply to a file of a language: the language's own, then the project's, then the defaults. */
export function limitsFor(config: ProvenflowConfig, language: Language | undefined): Limits {
    return { ...DEFAULT_LIMITS, ...config.limits, ...(language ? config.languages?.[language]?.limits : undefined) };
}

export const DEFAULT_LIMITS: Limits = { classMethods: 30, classLines: 600, functionLines: 80, inheritanceDepth: 3, functionParams: 6 };
export const DEFAULT_DUPLICATION: Required<DuplicationConfig> = { minTokens: 100, minLines: 10, tests: false, similarity: 0.8, minFunctionTokens: 50 };
export const DEFAULT_COMPLEXITY: Required<ComplexityConfig> = { cognitive: 15, nesting: 4 };

export const CONFIG_FILE = 'provenflow.config.json';

export function loadConfig(root: string, file?: string): ProvenflowConfig {
    const path = file ?? join(root, CONFIG_FILE);
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as ProvenflowConfig;
    } catch (error) {
        throw new Error(`${path}: ${(error as Error).message}`);
    }
}
