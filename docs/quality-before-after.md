# ProvenFlow checked by ProvenFlow: before and after

*Measured on 14 November 2026 with `pflow compare . --base 1a5447c --analyzers` (Semgrep, Infer and
CBMC installed; without nuXmv, so the explicit-state checker decided the model properties). Both
versions were analysed with the same `provenflow.config.json`, so only the code differs.*

`1a5447c` is the code base before the work described in
[ai-code-guardrails.md](ai-code-guardrails.md). The new checks were added, ProvenFlow was run on
itself, and the worst findings were fixed. "After" also contains the new code that implements the
checks, which is held to the same rules. Lines of code grew by 18% because of it: duplication,
complexity, naming, dependency, coverage and mutation checks; baselines; new-code gating; the MCP
server and agent hooks; and new CI outputs.

## What changed

| measure | before | after |
| --- | ---: | ---: |
| duplicated lines | 74 (1 clone) | 0 |
| highest Cognitive Complexity of a function | 189 | 93 |
| mean Cognitive Complexity per function | 3.65 | 3.35 |
| functions over their language's complexity limit | 133 | 118 |
| functions nested too deeply | 13 | 10 |
| long functions (over 50 lines in TypeScript and Python) | 48 | 38 |
| warnings / notes | 147 / 59 | 128 / 49 |
| errors | 0 | 0 |
| tests (language, extract, server, editor) | 89 extract tests, 28 server | 109 extract, 33 server; language 127 and editor 30 unchanged, all passing |

What was done, finding by finding:

| finding (before) | change |
| --- | --- |
| `duplicated-code`: `isApplied` and `onlyDuplicates`, 41 lines copied between `packages/extract/src/fixes.ts` and `packages/app/src/app/code-import/already-applied.ts` | The layer rules let neither package import the other, and both may import `language`: the function moved to `packages/language/src/text-edits.ts`, and both use it from there. |
| `cognitive-complexity` 189: `createApp` (`packages/server/src/app.ts`), every route of the server in one function | Split by concern: `context.ts` (shared state, folder and upload handling, run slots), and `routes/analysis.ts`, `routes/apply.ts`, `routes/models.ts`, `routes/live.ts`. `createApp` now only wires them (complexity 4). |
| `cognitive-complexity` 189: the CLI's `main` (`packages/server/src/cli.ts`) | One module per command group: `commands/diagram.ts` (a table of diagram commands), `commands/code.ts`, `commands/agents.ts`, `commands/shared.ts`. `main` dispatches (10). |
| `cognitive-complexity` 101 and nesting 8: `find_state_vars` (Python front end) | Split into `class_attributes`, `self_assignments`, `written_domain` and `add_state_var` (17). |
| `cognitive-complexity` 96: `collectDeclarations` (tree-sitter front end) | Split into `collectClasses`, `collectFields`/`bodyFields`, `collectGlobals`, `collectRubyFields` (10). |
| `cognitive-complexity` 92: `markdownReport` | One function per section of the report (0). |
| `cognitive-complexity` 68: `extractProject` | The pipeline in phases: `startRun`, `readFacts`, `analyses`, `analyzersPhase`, `fixesPhase`, `confirmPhase`, `resultOf`. The package entry `index.ts` is now only the facade; the pipeline is in `project.ts`, which also removed an import cycle. |
| `cognitive-complexity` 65 and 59: `analyseArchitecture`, `analyseParadigm` | One function per rule family (layer edges, layer model, violations, facade bypasses, cycles; profile, functional rules, object-oriented rules, size rules). |
| `cognitive-complexity` 53: `detectChecks` | The build and test commands as two tables of detection rules. |
| `cognitive-complexity` 38, 19, 18: `reviewComments`, `parseUnifiedDiff`, `publishReview` | Comment body, hunk parsing, GitHub API, earlier comments, posting and summary each in their own function. |
| `naming-convention`: `ScopeComputation`, `StateDiagramValidator` (Langium module) | Kept: Langium's dependency-injection modules name factories after their service. Recorded in `ignore` with that reason. |

The rest is accepted in `provenflow-baseline.json`: 177 findings, 118 of them functions over the
complexity limit, mostly in the language front ends. CI fails on anything beyond it, and on any
accepted function whose complexity rises. `pflow baseline --update` removes entries as they are
fixed, so the file can only shrink.

Introducing the checks also found problems in the new code before it was merged:
- an import cycle between the package entry and the review pipeline;
- 21 new functions over the complexity limit, including the tokenizer at 105;
- a `measure` function with 11 parameters;
- a temporary folder released in a `catch` instead of a `finally`.

Each was fixed; "Findings introduced" in the report below is empty.

## Reproduce it

```sh
npm install && npm run build
node packages/server/out/cli.js compare . --base 1a5447c --analyzers -o quality.md
node packages/server/out/cli.js extract . --fail-on warning    # the CI gate: 0 new findings
```

## The report

| measure | before (1a5447c) | after | change |
| --- | ---: | ---: | --- |
| source files | 114 | 142 | +28 (+25%) |
| lines of code | 16471 | 19493 | +3022 (+18%) |
| lines of test code | 2276 | 2564 | +288 (+13%) ✓ |
| functions | 2104 | 2462 | +358 (+17%) |
| duplicated lines | 74 | 0 | -74 (-100%) ✓ |
| duplicated lines (% of code) | 0.4% | 0% | -0.4% ✓ |
| clones (copied blocks) | 1 | 0 | -1 (-100%) ✓ |
| similar functions | 0 | 0 | = |
| Cognitive Complexity, mean per function | 3.65 | 3.35 | -0.3 (-8%) ✓ |
| Cognitive Complexity, 90th percentile | 10 | 10 | = |
| Cognitive Complexity, highest | 189 | 93 | -96 (-51%) ✓ |
| functions over the complexity limit | 133 | 118 | -15 (-11%) ✓ |
| functions nested too deeply | 13 | 10 | -3 (-23%) ✓ |
| cyclomatic complexity, mean | 3.77 | 3.72 | -0.05 (-1%) ✓ |
| mean function length (lines) | 7.64 | 7.38 | -0.26 (-3%) ✓ |
| long functions | 48 | 38 | -10 (-21%) ✓ |
| functions with many parameters | 3 | 3 | = |
| names off convention | 0 | 0 | = |
| unknown or undeclared dependencies | 0 | 0 | = |
| errors | 0 | 0 | = |
| warnings | 147 | 128 | -19 (-13%) ✓ |
| notes | 59 | 49 | -10 (-17%) ✓ |

✓: better, ✗: worse (for measures where lower or higher is better).

### Findings by rule

| rule | before | after | change |
| --- | ---: | ---: | --- |
| cognitive-complexity | 133 | 118 | -15 (-11%) ✓ |
| long-function | 48 | 38 | -10 (-21%) ✓ |
| deep-nesting | 13 | 10 | -3 (-23%) ✓ |
| duplicated-code | 1 | 0 | -1 (-100%) ✓ |

### Findings fixed (29)

- **cognitive-complexity** onlyDuplicates (`packages/app/src/app/code-import/already-applied.ts:13`): cognitive complexity 30
- **cognitive-complexity** analyseArchitecture (`packages/extract/src/architecture.ts:25`): cognitive complexity 65
- **cognitive-complexity** detectChecks (`packages/extract/src/buildcheck.ts:28`): cognitive complexity 53
- **cognitive-complexity** onlyDuplicates (`packages/extract/src/fixes.ts:83`): cognitive complexity 30
- **cognitive-complexity** extractProject (`packages/extract/src/index.ts:118`): cognitive complexity 68
- **cognitive-complexity** analyseParadigm (`packages/extract/src/paradigm.ts:37`): cognitive complexity 59
- **deep-nesting** find_state_vars (`packages/extract/src/python_facts.py:152`): nesting depth 8
- **cognitive-complexity** markdownReport (`packages/extract/src/report.ts:73`): cognitive complexity 92
- **deep-nesting** markdownReport (`packages/extract/src/report.ts:73`): nesting depth 5
- **cognitive-complexity** parseUnifiedDiff (`packages/extract/src/review.ts:18`): cognitive complexity 19
- **cognitive-complexity** reviewComments (`packages/extract/src/review.ts:84`): cognitive complexity 38
- **cognitive-complexity** publishReview (`packages/extract/src/review.ts:202`): cognitive complexity 18
- **cognitive-complexity** collectDeclarations (`packages/extract/src/treesitter/declarations.ts:63`): cognitive complexity 96
- **deep-nesting** collectDeclarations (`packages/extract/src/treesitter/declarations.ts:63`): nesting depth 5
- **cognitive-complexity** createApp (`packages/server/src/app.ts:45`): cognitive complexity 189
- **cognitive-complexity** folderOf (`packages/server/src/app.ts:98`): cognitive complexity 21
- **cognitive-complexity** singleChange (`packages/server/src/app.ts:201`): cognitive complexity 33
- **cognitive-complexity** main (`packages/server/src/cli.ts:58`): cognitive complexity 189
- **duplicated-code** isApplied = isApplied (`packages/extract/src/fixes.ts:76`): duplicated lines 41
- **long-function** analyseArchitecture (`packages/extract/src/architecture.ts:25`)
- **long-function** extractProject (`packages/extract/src/index.ts:118`)
- **long-function** analyseParadigm (`packages/extract/src/paradigm.ts:37`)
- **long-function** find_state_vars (`packages/extract/src/python_facts.py:152`)
- **long-function** markdownReport (`packages/extract/src/report.ts:73`)
- **long-function** publishReview (`packages/extract/src/review.ts:202`)
- **long-function** collectDeclarations (`packages/extract/src/treesitter/declarations.ts:63`)
- **long-function** createApp (`packages/server/src/app.ts:45`)
- **long-function** singleChange (`packages/server/src/app.ts:201`)
- **long-function** main (`packages/server/src/cli.ts:58`)

### Functions whose complexity changed

| function | file | before | after |
| --- | --- | ---: | ---: |
| createApp | `packages/server/src/app.ts` | 189 | 4 |
| main | `packages/server/src/cli.ts` | 189 | 10 |
| markdownReport | `packages/extract/src/report.ts` | 92 | 0 |
| collectDeclarations | `packages/extract/src/treesitter/declarations.ts` | 96 | 10 |
| find_state_vars | `packages/extract/src/python_facts.py` | 101 | 17 |
| analyseArchitecture | `packages/extract/src/architecture.ts` | 65 | 6 |
| analyseParadigm | `packages/extract/src/paradigm.ts` | 59 | 7 |
| detectChecks | `packages/extract/src/buildcheck.ts` | 53 | 6 |
| reviewComments | `packages/extract/src/review.ts` | 38 | 10 |
| publishReview | `packages/extract/src/review.ts` | 18 | 3 |
| parseUnifiedDiff | `packages/extract/src/review.ts` | 19 | 11 |
| listSourceFiles | `packages/extract/src/scan.ts` | 1 | 0 |
| extractTypeScript | `packages/extract/src/typescript-frontend.ts` | 10 | 11 |
| reviewSummary | `packages/extract/src/review.ts` | 6 | 7 |
