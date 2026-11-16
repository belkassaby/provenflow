/**
 * Coding standards per language: the naming conventions of each language's style guide and the
 * limits of its most used linter (or SonarQube's rule for that language where the linter has none).
 * They are the defaults of the naming and complexity checks, and what `pflow init` writes into a new
 * provenflow.config.json; a project's own config overrides them.
 *
 * Values checked on 14 November 2026 against the style guides and the linters' sources or default
 * configurations (listed in `sources`); the choices are explained in docs/coding-standards.md.
 * Limits are the largest value allowed: a function is reported above them.
 */
import type { NameKind, NamingStyle } from '../config.js';
import type { Language } from '../ir.js';

export interface LanguageStandard {
    /** Style guide the naming comes from. */
    guide: string;
    /** Linters (and rules) the limits come from. */
    linter: string;
    /** Expected style per kind of name; absent where the language has no settled convention. */
    naming: Partial<Record<NameKind, NamingStyle>>;
    limits: {
        functionLines: number;
        functionParams: number;
        cyclomatic: number;
        cognitive: number;
        nesting: number;
    };
    /** Other widely agreed practices (advice; not all are checked). */
    practices: string[];
    sources: string[];
}

const SONAR_RULES = 'https://sonarcloud.io/api/rules/search?q=Cognitive%20Complexity&f=params,lang&organization=sonarsource';

export const STANDARDS: Record<Language, LanguageStandard> = {
    typescript: {
        guide: 'Google TypeScript Style Guide',
        linter: 'ESLint max-lines-per-function 50, complexity 20, max-depth 4; sonarjs cognitive-complexity 15; Sonar S107 7 parameters (ESLint max-params defaults to 3)',
        naming: { class: 'PascalCase', function: 'camelCase', method: 'camelCase', field: 'camelCase', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 50, functionParams: 7, cyclomatic: 20, cognitive: 15, nesting: 4 },
        practices: ['no `any` (typescript-eslint no-explicit-any, in its recommended set): use `unknown`', 'strict compiler options (`strict: true`), no non-null assertions'],
        sources: ['https://google.github.io/styleguide/tsguide.html', 'https://github.com/eslint/eslint/tree/main/lib/rules', 'https://github.com/SonarSource/SonarJS/blob/master/packages/analysis/src/jsts/rules/S3776/rule.ts']
    },
    python: {
        guide: 'PEP 8',
        linter: 'Pylint max-statements 50, max-args 5, max-nested-blocks 5; Ruff C901 max-complexity 10; Sonar python:S3776 15',
        naming: { class: 'PascalCase', function: 'snake_case', method: 'snake_case', field: 'snake_case', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 50, functionParams: 5, cyclomatic: 10, cognitive: 15, nesting: 5 },
        practices: ['type hints on public functions', 'no bare `except:` and no broad `except Exception` (Pylint broad-exception-caught)'],
        sources: ['https://peps.python.org/pep-0008/', 'https://github.com/pylint-dev/pylint/blob/main/pylint/checkers/design_analysis.py', 'https://github.com/astral-sh/ruff/blob/main/crates/ruff_linter/src/rules/pylint/settings.rs']
    },
    java: {
        guide: 'Google Java Style Guide',
        linter: 'Checkstyle MethodLength 150, ParameterNumber 7, CyclomaticComplexity 10; PMD CognitiveComplexity 15; Sonar java:S134 nesting 3',
        naming: { class: 'PascalCase', function: 'camelCase', method: 'camelCase', field: 'camelCase', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 150, functionParams: 7, cyclomatic: 10, cognitive: 15, nesting: 3 },
        practices: ['do not catch generic Exception or Throwable (Checkstyle IllegalCatch, PMD AvoidCatchingGenericException)', 'no empty catch blocks'],
        sources: ['https://google.github.io/styleguide/javaguide.html', 'https://github.com/checkstyle/checkstyle', 'https://github.com/pmd/pmd/blob/main/pmd-java/src/main/resources/category/java/design.xml']
    },
    kotlin: {
        guide: 'Kotlin coding conventions',
        linter: 'detekt LongMethod 60, LongParameterList 5 (functions), CyclomaticComplexMethod 14, CognitiveComplexMethod 15, NestedBlockDepth 4',
        naming: { class: 'PascalCase', function: 'camelCase', method: 'camelCase', field: 'camelCase', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 60, functionParams: 5, cyclomatic: 14, cognitive: 15, nesting: 4 },
        practices: ['no `!!` (detekt UnsafeCallOnNullableType)', 'do not catch generic exceptions (detekt TooGenericExceptionCaught)'],
        sources: ['https://kotlinlang.org/docs/coding-conventions.html', 'https://github.com/detekt/detekt/blob/main/detekt-core/src/main/resources/default-detekt-config.yml']
    },
    groovy: {
        guide: 'Java conventions, as CodeNarc names them (the Groovy style guide has no naming rules)',
        linter: 'CodeNarc MethodSize 100, ParameterCount 5, CyclomaticComplexity 20, NestedBlockDepth 5; Sonar cognitive 15',
        naming: { class: 'PascalCase', function: 'camelCase', method: 'camelCase', field: 'camelCase', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 100, functionParams: 5, cyclomatic: 20, cognitive: 15, nesting: 5 },
        practices: ['do not catch Exception (CodeNarc CatchException)', 'static types (@CompileStatic, typed parameters) on public APIs'],
        sources: ['https://github.com/CodeNarc/CodeNarc/blob/master/docs/codenarc-rules-size.md', 'https://github.com/CodeNarc/CodeNarc/blob/master/docs/codenarc-rules-naming.md', 'https://groovy-lang.org/style-guide.html']
    },
    scala: {
        guide: 'Scala style guide (docs.scala-lang.org)',
        linter: 'Scalastyle method.length 50, parameter.number 8, cyclomatic.complexity 10; Sonar scala:S3776 15, S134 3',
        naming: { class: 'PascalCase', function: 'camelCase', method: 'camelCase', field: 'camelCase', constant: 'PascalCase' },
        limits: { functionLines: 50, functionParams: 8, cyclomatic: 10, cognitive: 15, nesting: 3 },
        practices: ['no `null` (Scalastyle NullChecker)', 'no `return` (Scalastyle ReturnChecker)'],
        sources: ['https://docs.scala-lang.org/style/naming-conventions.html', 'https://github.com/scalastyle/scalastyle/blob/master/src/main/resources/default_config.xml', SONAR_RULES]
    },
    c: {
        guide: 'Linux kernel coding style (practice varies: GNU is also snake_case)',
        linter: 'clang-tidy readability-function-cognitive-complexity 25; Sonar c:S107 7, S1541 20; the kernel guide: two screenfuls (48 lines), 3 levels of indentation',
        naming: { class: 'snake_case', function: 'snake_case', method: 'snake_case', field: 'snake_case', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 48, functionParams: 7, cyclomatic: 20, cognitive: 25, nesting: 3 },
        practices: ['check return values (CERT ERR33-C)', 'no unsafe string functions: strcpy, sprintf, gets (clang-tidy bugprone-unsafe-functions)'],
        sources: ['https://www.kernel.org/doc/html/latest/process/coding-style.html', 'https://github.com/llvm/llvm-project/blob/main/clang-tools-extra/clang-tidy/readability/FunctionCognitiveComplexityCheck.cpp', SONAR_RULES]
    },
    cpp: {
        guide: 'Google C++ Style Guide (the C++ Core Guidelines prefer snake_case; constants are kPascalCase)',
        linter: 'C++ Core Guidelines F.3 (60 lines, 10 paths); clang-tidy cognitive complexity 25; Sonar cpp:S107 7, S134 3',
        naming: { class: 'PascalCase', function: 'PascalCase', method: 'PascalCase', field: 'snake_case', constant: 'PascalCase' },
        limits: { functionLines: 60, functionParams: 7, cyclomatic: 10, cognitive: 25, nesting: 3 },
        practices: ['no owning raw new/delete (Core Guidelines R.11)', 'nullptr, no C-style casts'],
        sources: ['https://google.github.io/styleguide/cppguide.html', 'https://github.com/isocpp/CppCoreGuidelines/blob/master/CppCoreGuidelines.md', 'https://github.com/llvm/llvm-project/blob/main/clang-tools-extra/clang-tidy/readability/FunctionCognitiveComplexityCheck.cpp']
    },
    c_sharp: {
        guide: '.NET Framework Design Guidelines (fields: camelCase when private, PascalCase when public)',
        linter: 'SonarC# S138 80 lines, S107 7, S3776 15, S134 3; .NET CA1502 cyclomatic 25',
        naming: { class: 'PascalCase', function: 'PascalCase', method: 'PascalCase', constant: 'PascalCase' },
        limits: { functionLines: 80, functionParams: 7, cyclomatic: 25, cognitive: 15, nesting: 3 },
        practices: ['nullable reference types enabled', 'do not catch general exceptions (CA1031); no async void outside event handlers'],
        sources: ['https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/capitalization-conventions', 'https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/identifier-names', 'https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1502']
    },
    go: {
        guide: 'Effective Go and Google Go Style (MixedCaps; the first letter is the visibility; no underscores, no ALL_CAPS)',
        linter: 'golangci-lint funlen 60; revive argument-limit 8, max-control-nesting 5; gocyclo/gocognit 15 (golangci recommends 10-20 over its default 30)',
        naming: { class: 'MixedCaps', function: 'MixedCaps', method: 'MixedCaps', field: 'MixedCaps', constant: 'MixedCaps' },
        limits: { functionLines: 60, functionParams: 8, cyclomatic: 15, cognitive: 15, nesting: 5 },
        practices: ['check every error (errcheck, in the default set)', 'do not discard errors with _'],
        sources: ['https://go.dev/doc/effective_go', 'https://google.github.io/styleguide/go/decisions', 'https://github.com/golangci/golangci-lint/blob/main/.golangci.reference.yml', 'https://github.com/mgechev/revive/blob/master/RULES_DESCRIPTIONS.md']
    },
    rust: {
        guide: 'Rust API Guidelines (RFC 430 naming)',
        linter: 'Clippy too_many_lines 100, too_many_arguments 7, cognitive_complexity 25 (Clippy has no cyclomatic or nesting default)',
        naming: { class: 'PascalCase', function: 'snake_case', method: 'snake_case', field: 'snake_case', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 100, functionParams: 7, cyclomatic: 25, cognitive: 25, nesting: 4 },
        practices: ['no unwrap()/expect() in library code (clippy unwrap_used, expect_used)', 'every unsafe block documented with // SAFETY:'],
        sources: ['https://rust-lang.github.io/api-guidelines/naming.html', 'https://github.com/rust-lang/rust-clippy/blob/master/clippy_config/src/conf.rs']
    },
    swift: {
        guide: 'Swift API Design Guidelines (types UpperCamelCase, everything else lowerCamelCase)',
        linter: 'SwiftLint function_body_length 50, function_parameter_count 5, cyclomatic_complexity 10; Sonar swift:S3776 15, S134 3',
        naming: { class: 'PascalCase', function: 'camelCase', method: 'camelCase', field: 'camelCase', constant: 'camelCase' },
        limits: { functionLines: 50, functionParams: 5, cyclomatic: 10, cognitive: 15, nesting: 3 },
        practices: ['no force casts (as!) or force try (try!), both on by default in SwiftLint', 'no force unwrapping'],
        sources: ['https://www.swift.org/documentation/api-design-guidelines/', 'https://github.com/realm/SwiftLint/tree/main/Source/SwiftLintBuiltInRules/Rules/Metrics']
    },
    ruby: {
        guide: 'Ruby Style Guide (rubystyle.guide)',
        linter: 'RuboCop Metrics/MethodLength 10, ParameterLists 5, CyclomaticComplexity 7, BlockNesting 3; Sonar ruby:S3776 15',
        naming: { class: 'PascalCase', function: 'snake_case', method: 'snake_case', field: 'snake_case', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 10, functionParams: 5, cyclomatic: 7, cognitive: 15, nesting: 3 },
        practices: ['frozen string literal comment', 'never rescue Exception (Lint/RescueException)'],
        sources: ['https://rubystyle.guide/', 'https://github.com/rubocop/rubocop/blob/master/config/default.yml']
    },
    php: {
        guide: 'PSR-1 (free functions have no PSR rule)',
        linter: 'PHPMD ExcessiveMethodLength 100, ExcessiveParameterList 10, CyclomaticComplexity 10; PHP_CodeSniffer NestingLevel 5; Sonar php:S3776 15',
        naming: { class: 'PascalCase', method: 'camelCase', field: 'camelCase', constant: 'SCREAMING_SNAKE_CASE' },
        limits: { functionLines: 100, functionParams: 10, cyclomatic: 10, cognitive: 15, nesting: 5 },
        practices: ['declare(strict_types=1) in every file', 'parameter and return types on every function'],
        sources: ['https://www.php-fig.org/psr/psr-1/', 'https://github.com/phpmd/phpmd/blob/master/src/main/resources/rulesets/codesize.xml', 'https://github.com/PHPCSStandards/PHP_CodeSniffer/tree/master/src/Standards/Generic/Sniffs/Metrics']
    },
    r: {
        guide: 'tidyverse style guide (R6 classes PascalCase by common practice)',
        linter: 'lintr cyclocomp_linter 15, object_name_linter snake_case; Sonar R S138 100, S107 7, S134 3, S3776 15',
        naming: { class: 'PascalCase', function: 'snake_case', method: 'snake_case', field: 'snake_case', constant: 'snake_case' },
        limits: { functionLines: 100, functionParams: 7, cyclomatic: 15, cognitive: 15, nesting: 3 },
        practices: ['TRUE/FALSE, not T/F', 'seq_along(x), not 1:length(x)'],
        sources: ['https://style.tidyverse.org/syntax.html', 'https://github.com/r-lib/lintr', SONAR_RULES]
    }
};

export function standardOf(language: Language | undefined): LanguageStandard | undefined {
    return language ? STANDARDS[language] : undefined;
}
