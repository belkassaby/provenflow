# Coding standards per language

*Checked on 14 November 2026 against each language's style guide and the default configuration of
its most used linter (their source code or default config files where possible). The values live in
`packages/extract/src/quality/standards.ts`.*

ProvenFlow starts every project from the coding standards of its languages. `pflow init` writes them
into `provenflow.config.json` (under `languages`), and the naming and complexity checks use them
when the config says nothing. A project's own config always wins. When the project consistently
names things otherwise (at least 80% of 8 or more names), its own convention is used instead of the
style guide's, and `pflow init` says so: consistency with the code base matters more than the
guide.

## Naming

| language | class / type | function | method | field | constant | style guide |
| --- | --- | --- | --- | --- | --- | --- |
| TypeScript / JavaScript | PascalCase | camelCase | camelCase | camelCase | SCREAMING_SNAKE_CASE | Google TypeScript Style Guide |
| Python | PascalCase | snake_case | snake_case | snake_case | SCREAMING_SNAKE_CASE | PEP 8 |
| Java | PascalCase | camelCase | camelCase | camelCase | SCREAMING_SNAKE_CASE | Google Java Style Guide |
| Kotlin | PascalCase | camelCase | camelCase | camelCase | SCREAMING_SNAKE_CASE | Kotlin coding conventions |
| Groovy | PascalCase | camelCase | camelCase | camelCase | SCREAMING_SNAKE_CASE | Java conventions, as CodeNarc's naming rules spell them |
| Scala | PascalCase | camelCase | camelCase | camelCase | PascalCase | Scala style guide |
| C | snake_case | snake_case | — | snake_case | SCREAMING_SNAKE_CASE | Linux kernel coding style |
| C++ | PascalCase | PascalCase | PascalCase | snake_case | PascalCase (`kName`) | Google C++ Style Guide |
| C# | PascalCase | PascalCase | PascalCase | (camelCase private, PascalCase public) | PascalCase | .NET Framework Design Guidelines |
| Go | MixedCaps | MixedCaps | MixedCaps | MixedCaps | MixedCaps | Effective Go, Google Go Style |
| Rust | PascalCase | snake_case | snake_case | snake_case | SCREAMING_SNAKE_CASE | Rust API Guidelines (RFC 430) |
| Swift | PascalCase | camelCase | camelCase | camelCase | camelCase | Swift API Design Guidelines |
| Ruby | PascalCase | snake_case | snake_case | snake_case | SCREAMING_SNAKE_CASE | Ruby Style Guide |
| PHP | PascalCase | (no rule) | camelCase | camelCase | SCREAMING_SNAKE_CASE | PSR-1 |
| R | PascalCase | snake_case | snake_case | snake_case | snake_case | tidyverse style guide |

Where the guides leave a choice, ProvenFlow checks what can be checked:
- **Go:** the case of the first letter is the visibility, so either camelCase or PascalCase is
  accepted (`MixedCaps`). Only underscores and ALL_CAPS are reported.
- **C#:** fields are camelCase when private and PascalCase when public, so fields are not checked.
- **PHP:** PSR-1 has no rule for free functions, so they are not checked.
- **C++:** practice varies. The C++ Core Guidelines prefer snake_case, and a project that
  consistently uses it is checked against its own style.

## Limits

Each limit is the largest value allowed; a function above it is reported.

| language | function lines | parameters | cyclomatic | Cognitive Complexity | nesting | from |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| TypeScript / JavaScript | 50 | 7 | 20 | 15 | 4 | ESLint `max-lines-per-function`, `complexity`, `max-depth`; sonarjs `cognitive-complexity`; Sonar S107 |
| Python | 50 | 5 | 10 | 15 | 5 | Pylint `max-statements`, `max-args`, `max-nested-blocks`; Ruff C901; Sonar S3776 |
| Java | 150 | 7 | 10 | 15 | 3 | Checkstyle `MethodLength`, `ParameterNumber`, `CyclomaticComplexity`; PMD `CognitiveComplexity`; Sonar S134 |
| Kotlin | 60 | 5 | 14 | 15 | 4 | detekt `LongMethod`, `LongParameterList`, `CyclomaticComplexMethod`, `CognitiveComplexMethod`, `NestedBlockDepth` |
| Groovy | 100 | 5 | 20 | 15 | 5 | CodeNarc `MethodSize`, `ParameterCount`, `CyclomaticComplexity`, `NestedBlockDepth` |
| Scala | 50 | 8 | 10 | 15 | 3 | Scalastyle `method.length`, `parameter.number`, `cyclomatic.complexity`; Sonar S3776, S134 |
| C | 48 | 7 | 20 | 25 | 3 | Linux kernel guide (two screens, three levels); clang-tidy cognitive complexity; Sonar S107, S1541 |
| C++ | 60 | 7 | 10 | 25 | 3 | C++ Core Guidelines F.3; clang-tidy cognitive complexity; Sonar S107, S134 |
| C# | 80 | 7 | 25 | 15 | 3 | SonarC# S138, S107, S3776, S134; .NET CA1502 |
| Go | 60 | 8 | 15 | 15 | 5 | golangci-lint `funlen`; revive `argument-limit`, `max-control-nesting`; `gocyclo`/`gocognit` at 15 |
| Rust | 100 | 7 | 25 | 25 | 4 | Clippy `too_many_lines`, `too_many_arguments`, `cognitive_complexity` |
| Swift | 50 | 5 | 10 | 15 | 3 | SwiftLint `function_body_length`, `function_parameter_count`, `cyclomatic_complexity`; Sonar S3776, S134 |
| Ruby | 10 | 5 | 7 | 15 | 3 | RuboCop `Metrics/MethodLength`, `ParameterLists`, `CyclomaticComplexity`, `BlockNesting`; Sonar S3776 |
| PHP | 100 | 10 | 10 | 15 | 5 | PHPMD `ExcessiveMethodLength`, `ExcessiveParameterList`, `CyclomaticComplexity`; PHP_CodeSniffer `NestingLevel`; Sonar S3776 |
| R | 100 | 7 | 15 | 15 | 3 | lintr `cyclocomp_linter`; Sonar S138, S107, S134, S3776 |

Decisions where a linter's default is a poor starting point, or where a linter has no such rule:
- **TypeScript parameters: 7 (Sonar S107), not ESLint's 3.** `max-params` defaults to 3, which
  most TypeScript code exceeds without being hard to read.
- **Go complexity: 15, not golangci-lint's 30.** golangci-lint's own reference config recommends
  10–20 for `gocyclo` and `gocognit`, and Sonar uses 15.
- **Cognitive Complexity where the main linter has none: Sonar's value.** That is 15 for Groovy,
  Scala, Ruby, PHP and R, and 25 for C and C++ (clang-tidy and Sonar agree).
- **Swift nesting: 3, from Sonar S134.** SwiftLint's `nesting` rule counts nested types and
  functions, not control structures.
- **Ruby function lines: 10, RuboCop's default (the Ruby Style Guide says the same).** RuboCop's
  development branch says its Metrics cops will be disabled by default in its next major release.
  Long functions are notes, not warnings; raise the limit in `languages.ruby.limits` if the team
  prefers.
- **Python function lines: 50, from Pylint's `max-statements`.** ProvenFlow counts lines, so the
  limit is stricter than Pylint's.

Cognitive Complexity follows the SonarSource whitepaper (v1.7) and is computed by each front end
(see [code-model-checking.md](code-model-checking.md#complexity)).

## Other practices of each language

Widely agreed practices that a linter checks. ProvenFlow lists them as advice in
`STANDARDS[language].practices`; the security ones are covered by the Semgrep rules it bundles.

| language | practices |
| --- | --- |
| TypeScript | no `any` (`@typescript-eslint/no-explicit-any`, in its recommended set); `strict: true`; no non-null assertions |
| Python | type hints on public functions; no bare `except:` or broad `except Exception` |
| Java | do not catch `Exception`/`Throwable` (Checkstyle `IllegalCatch`); no empty catch blocks |
| Kotlin | no `!!` (detekt `UnsafeCallOnNullableType`); no generic exception catches |
| Groovy | no `catch (Exception)` (CodeNarc `CatchException`); static types on public APIs |
| Scala | no `null`, no `return` (Scalastyle) |
| C | check return values (CERT ERR33-C); no `strcpy`, `sprintf`, `gets` |
| C++ | no owning raw `new`/`delete` (Core Guidelines R.11); `nullptr`; no C-style casts |
| C# | nullable reference types; no general exception catches (CA1031); no `async void` outside event handlers |
| Go | check every error (errcheck); do not discard errors with `_` |
| Rust | no `unwrap()`/`expect()` in library code; every `unsafe` block documented |
| Swift | no `as!` or `try!`; no force unwrapping |
| Ruby | frozen string literal comment; never `rescue Exception` |
| PHP | `declare(strict_types=1)`; parameter and return types |
| R | `TRUE`/`FALSE`, not `T`/`F`; `seq_along(x)`, not `1:length(x)` |

## Sources

All checked on 14 November 2026. Linter values come from their source or default config at the
version given; style guides from their published pages.

- **TypeScript:**
  - https://google.github.io/styleguide/tsguide.html
  - ESLint v10.15.0 rules (https://github.com/eslint/eslint/tree/main/lib/rules), none of them in `@eslint/js` recommended
  - SonarJS S3776 (https://github.com/SonarSource/SonarJS/blob/master/packages/analysis/src/jsts/rules/S3776/rule.ts)
  - typescript-eslint recommended config
- **Python:**
  - PEP 8 (https://peps.python.org/pep-0008/)
  - Pylint 4.1.3 (`pylint/checkers/design_analysis.py`)
  - Ruff 0.17.5 (`crates/ruff_linter/src/rules/pylint/settings.rs`, `rules/mccabe/settings.rs`); C901 and PLR09xx are not in Ruff's default selection
- **Java:**
  - https://google.github.io/styleguide/javaguide.html
  - Checkstyle 14.4.0 (`checks/sizes`, `checks/metrics`)
  - PMD 7.29.0 (`category/java/design.xml`)
- **Kotlin:**
  - https://kotlinlang.org/docs/coding-conventions.html
  - detekt default config (`default-detekt-config.yml`, main and v1.23.8)
- **Groovy:**
  - CodeNarc v4.0.0 (https://github.com/CodeNarc/CodeNarc/blob/master/docs/codenarc-rules-size.md, `codenarc-rules-naming.md`)
  - https://groovy-lang.org/style-guide.html
- **Scala:**
  - https://docs.scala-lang.org/style/naming-conventions.html
  - Scalastyle `default_config.xml`
- **C:**
  - https://www.kernel.org/doc/html/latest/process/coding-style.html
  - clang-tidy `FunctionCognitiveComplexityCheck.cpp` (default 25) and `FunctionSizeCheck.h`
- **C++:**
  - https://google.github.io/styleguide/cppguide.html
  - https://github.com/isocpp/CppCoreGuidelines (F.3, NL.10)
- **C#:**
  - https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/capitalization-conventions
  - https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/identifier-names
  - CA1502 (https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1502; not enabled by default)
- **Go:**
  - https://go.dev/doc/effective_go
  - https://google.github.io/styleguide/go/decisions
  - golangci-lint v2.15.0 `.golangci.reference.yml`
  - revive `RULES_DESCRIPTIONS.md`
- **Rust:**
  - https://rust-lang.github.io/api-guidelines/naming.html
  - Clippy `clippy_config/src/conf.rs`
- **Swift:**
  - https://www.swift.org/documentation/api-design-guidelines/
  - SwiftLint 0.65.1 metrics rules
- **Ruby:**
  - https://rubystyle.guide/
  - RuboCop `config/default.yml` (release 1.92.2)
- **PHP:**
  - https://www.php-fig.org/psr/psr-1/
  - PHPMD `rulesets/codesize.xml`
  - PHP_CodeSniffer 4.0.4 `Generic/Sniffs/Metrics`
- **R:**
  - https://style.tidyverse.org/syntax.html
  - lintr 3.4.0 (`cyclocomp_linter` left the default linters in 3.2.0)
- **SonarQube rule defaults** (S3776, S107, S138, S134, S1541 per language): the public SonarCloud rules API, https://sonarcloud.io/api/rules/search
