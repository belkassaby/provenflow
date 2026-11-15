# Guardrails for AI-generated code: research and roadmap

*Research date: 14 November 2026. Sections 1–3 summarise published research and tool documentation.
Section 4 describes ProvenFlow as it was when the research was done. Sections 5–6 list what it needed
to become the standard CI/CD check for existing code bases, open pull requests and pull requests
written by agents. Section 6 now gives each item's status: most are implemented
([code-model-checking.md](code-model-checking.md)), and their effect on ProvenFlow's own code is
measured in [quality-before-after.md](quality-before-after.md).*

*Claims about other tools and papers were checked against their pages on 14 November 2026.
Claims marked "not verified" come from search results or secondary coverage and should be
re-checked before being relied on. Vendor studies are marked as such.*

ProvenFlow already reviews code written by AI assistants: it checks behaviour (state machines,
resource lifecycles, pattern contracts, layers) and runs security and memory-safety analysers
(see [code-model-checking.md](code-model-checking.md)). This document looks at the other half of
the request: AI-generated code that works but does not fit the code base. Such code:
- ignores existing patterns;
- duplicates helpers that already exist;
- adds complexity;
- is hard to read;
- is poorly tested.

The question is which deterministic checks catch these problems, and where in the pipeline
they should run.

- [1. What the evidence says about AI-generated code](#1-what-the-evidence-says-about-ai-generated-code)
- [2. Where a guardrail can act](#2-where-a-guardrail-can-act)
- [3. Research and practice by goal](#3-research-and-practice-by-goal)
- [4. ProvenFlow before this work, against those goals](#4-provenflow-before-this-work-against-those-goals)
- [5. What ProvenFlow needs as a CI/CD check](#5-what-provenflow-needs-as-a-cicd-check)
- [6. Roadmap](#6-roadmap)
- [7. Not planned, and why](#7-not-planned-and-why)
- [Research list](#research-list)
- [Sources](#sources)

## 1. What the evidence says about AI-generated code

| Finding | Source |
| --- | --- |
| Copy/pasted lines grew from 8.3% to 12.3% of changed lines (2021–2024), and moved (refactored) lines fell from about 25% to under 10% (211M changed lines). | GitClear, 2025 report |
| Duplicated blocks rose 81% (40.3 → 73.0 per million changed lines); copy/paste is now about 5× more common than refactoring, and calls between functions fell 35% (623M changes, 2023 to mid-2026). The page mixes units ("per thousand" and "per million"). | GitClear, *The Maintainability Gap*, 2026 |
| Functions added by agents are about 1.87× more redundant with the existing code than functions added by people (617 crewAI PRs). Agents re-implement helpers that already exist. These are semantic (Type-4) clones, which token-matching tools miss. Reviewers did not object to them. | Huang et al., *More Code, Less Reuse*, MSR 2026 |
| AI-co-authored PRs had about 1.7× more issues: more than 3× the readability issues, about 2× the naming inconsistencies and about 2× the error-handling gaps (470 PRs; authorship inferred). | CodeRabbit, Dec 2025 (vendor) |
| Merged agent bug-fix PRs most often add code smells; "merge success does not reliably reflect post-merge code quality" (1,210 PRs, SonarQube). | arXiv 2601.20109, Jan 2026 |
| Agent PR quality is "vendor-specific rather than uniform": Codex PRs were reverted 6.1% of the time, human PRs 11.5% and Devin's 14.5% (37,623 PRs). | arXiv 2609.17598, Sep 2026 |
| Agent PRs merge less often than human ones: 76.8% for people, 38.2–65.3% for agents. Unmerged agent PRs are larger and often fail CI. | arXiv 2507.15003; arXiv 2601.15195 (MSR 2026) |
| About 44% of generated code still introduces a vulnerability (56% pass rate, flat since 2025). Coding-specialised models do no better than general models. | Veracode, Jul 2026 |
| Every 25% rise in AI adoption went with −7.2% delivery stability (2024). In 2025, AI raised throughput but stability stayed lower: "AI amplifies existing conditions". | DORA 2024, 2025 |
| Experienced developers were 19% slower with AI while believing they were 20% faster. METR's late-2025 rerun found a speed-up, but METR calls that data unreliable. | METR, Jul 2025 and Feb 2026 |
| LLMs and developers have systematically different coding styles. | arXiv 2407.00456 (FSE) |

What follows: AI code fails less often on syntax and tests than on **fit**. It duplicates
instead of reusing, adds smells, drifts in naming and error handling, and degrades stability.
Passing tests and getting merged are weak signals of quality. Several of these problems can be
checked deterministically.

## 2. Where a guardrail can act

| When | Mechanism | Deterministic? | Examples |
| --- | --- | --- | --- |
| Before writing | Instruction and context files | No, advisory text | AGENTS.md (60k+ projects, read by about 25 tools), CLAUDE.md, Copilot `.github/copilot-instructions.md` and `*.instructions.md` with `applyTo`, Cursor rules, Kiro steering files, Spec Kit's "constitution" |
| While writing | Hooks and MCP tools the agent calls | Yes, if the tool is | Claude Code `PostToolUse` hooks (exit 2 or `additionalContext` feeds results back; a `Stop` hook can refuse to finish); Semgrep Guardian; SonarQube Agentic Analysis (beta); Codacy Guardrails; CodeScene MCP |
| Before the PR opens | The agent's own validation | Partly | Copilot coding agent runs tests, linters, CodeQL, secret scanning and Copilot review on its own work. Since June 2026 this also covers third-party agents. Its tools are pre-installed with `copilot-setup-steps.yml`. |
| At review | Review bots on the diff | Mixed | Copilot code review (LLM plus CodeQL/ESLint), CodeRabbit (LLM plus 40+ analysers), Greptile, Bugbot, Qodo, Graphite, Claude Code Review (LLM agents with a verification step; a check that never fails) |
| At merge | Required checks, quality gates | Yes | Rulesets with required status checks; code-scanning merge protection; SonarQube "Sonar way for Agentic AI" (no new issues, coverage ≥ 80%, duplication ≤ 3% on new code) |

Two results matter for the design:
- **Context files help less than expected.** Across agents and models they "do not generally
  improve task success" and cost over 20% more inference. They do help with *non-standard*
  practices, and agents do follow them, but nothing checks that they did (arXiv 2602.11988).
- **Analyser feedback in the loop works.** Feeding Bandit and Pylint results back to GPT-4o cut
  security issues from over 40% to 13% and readability violations from over 80% to 11%
  (arXiv 2508.14419). By contrast, LLM judges of code show "significant randomness" and depend on
  the order of their inputs (CodeJudgeBench). A pass/fail gate should therefore be
  deterministic, and an LLM should only propose things that the gate then checks. This is the
  rule ProvenFlow already follows for fixes.

## 3. Research and practice by goal

### 3.1 Follow the existing patterns and conventions

- **Learning conventions from the repository itself.** NATURALIZE learns identifier and
  formatting conventions from the code base (94% top-suggestion accuracy for names; 14 of 18
  patches accepted). Qodo's Rules Miner mines patterns from code and PR history into rules
  (June 2026). Cursor Bugbot turns reviewers' reactions into candidate rules, promotes them, and
  disables them when they get negative feedback (110k repositories, 44k rules). Greptile builds a
  graph of the repository and points to similar existing code. All of these except NATURALIZE
  are LLM-based, and none is deterministic.
- **Declared rules as checks ("fitness functions").** Architecture rules that "we will never
  disagree on the result" (*Building Evolutionary Architectures*, not verified):
  - ArchUnit and dependency-cruiser;
  - Python's import-linter: *Protected*, *Layers*, *Independence* and *Acyclic siblings*
    contracts;
  - Tach: public interfaces per module;
  - Nx `enforce-module-boundaries` and eslint-plugin-boundaries;
  - Deptrac (not verified);
  - SonarQube Server 2026.4, which added architecture rules.
- **Repository context for generation.** Retrieving code from the repository improves completion
  (RepoCoder, more than 10% over in-file context). Retrieving documentation helps with rare APIs
  but can hurt common ones, so it should be triggered selectively (CloudAPIBench).
- **Instruction files as an input.** CodeRabbit reads AGENTS.md, CLAUDE.md, Cursor and Copilot
  rule files as review guidelines. Claude Code Review reads `REVIEW.md` only from the **base**
  branch, never from the PR, so a PR cannot weaken its own review.

### 3.2 Avoid duplication

- **Clone types and techniques.**
  - Type-1 (identical) and Type-2 (renamed identifiers and literals) clones are found by token
    hashing (PMD CPD, jscpd) or AST-subtree fingerprints. Qlty's tree-sitter engine hashes each
    node from its kind and its children, ignoring names and literals, and keeps only the largest
    matches.
  - Type-3 (statements added or removed) needs token-bag overlap (SourcererCC, about 85%
    similarity; not verified) or tree similarity.
  - Type-4 (same behaviour, different code) needs semantic or embedding methods. Published
    accuracy figures for Type-4 detection are doubtful: about 94% of the sampled BigCloneBench
    pairs used to evaluate it are mislabelled (Krinke & Ragkhitwetsagul, 2025–2026).
- **Thresholds in use.** SonarQube counts at least 10 statements (Java), or 100 tokens over 10
  lines. Its gate allows at most 3% duplication on new code, and is skipped below 20 new lines.
- **New duplication only.** jscpd v5.4 has `--baseline-from-ref origin/main
  --fail-on-new-clones 0`, `--changed`, Type-2/3 options, an experimental `--semantic` mode, and
  `boundaries` rules that flag copies of a module's code outside that module (Sep–Nov 2026).
  Codacy's gate counts clones "introduced" by the change.

### 3.3 Avoid complexity, improve readability

- **Cognitive Complexity** (SonarSource whitepaper v1.7, 2023; full specification in Appendix B):
  - +1 for each break in linear flow, plus extra increments for nesting;
  - Sonar's default limit is 15 per method;
  - it is validated against comprehension time and perceived understandability (Muñoz Barón et
    al., ESEM 2020: about 24,000 evaluations), but no threshold is validated.
- **Cyclomatic complexity** measures testability rather than understandability. ESLint's default
  limit is 20. lizard computes it for about 30 languages, including all 15 that ProvenFlow reads.
- **The Maintainability Index** should not be used: its formula has no rationale, it mostly tracks
  size, and it was calibrated on a small, old data set (van Deursen, 2014). radon itself calls it
  "very experimental".
- **Readability models** (Buse & Weimer; Scalabrino et al.) correlate weakly with developers'
  judgements, so a readability score should not be a gate. Naming consistency can be checked
  against the repository's own conventions (NATURALIZE) and reported as advice.
- **Code health and AI.** Low-quality code has 15× more defects (*Code Red*, 2022). Whether an LLM
  refactoring preserves behaviour is associated with the health of the code it changes
  (FORGE 2026, 5,000 Python files). CodeScene's Code Health is computed from more than 25 smells
  (Brain Method, Bumpy Road, nested complexity, DRY violations...). These are CodeScene's own
  studies.

### 3.4 Improve test coverage, and the quality of tests

- **Coverage of the changed lines**, not of the whole project:
  - diff-cover (LCOV, Cobertura, JaCoCo, Clover);
  - Codecov's `patch` status;
  - GitHub's native PR coverage (Cobertura, public preview May 2026), with a ruleset condition
    "Restrict code coverage" (API since September 2026).
- **Coverage is a weak oracle.** One cited suite has 100% coverage and a 4% mutation score
  (not verified). LLM-written test assertions catch about as many mutants as human ones
  (43% against 45%; not verified).
- **Mutation testing at review time** (Google, *Practical Mutation Testing at Scale*):
  - at most one mutant per changed line;
  - "arid" nodes (logging and similar) suppressed, which raised the share of useful mutants from
    15% to 89%;
  - a median of 2 surviving mutants shown per change.

  StrykerJS `--incremental` and cargo-mutants `--in-diff` do diff-scoped runs.
- **Trustworthy generated tests** pass a chain of filters:
  - they build;
  - they pass several runs (not flaky);
  - they fail on the old code or a mutant, and pass on the new code;
  - they add coverage;
  - they have no test smells;
  - a person accepts them.

  Meta's TestGen-LLM: 75% built, 57% passed reliably, 25% added coverage, and 73% of its proposals
  were accepted. Meta's ACH generates tests that kill given mutants (not verified).
- **Property-based testing** finds real bugs when an agent writes it: 56% of reports valid on 100
  Python packages (arXiv 2510.09907). OpenSSF Scorecard counts property-based tests as fuzzing.

### 3.5 Best practices that can be checked

- **Security.** About 44% of generated code introduces a vulnerability (Veracode). Analysers fed
  back to the model reduce this (section 2).
- **Hallucinated dependencies and APIs.**
  - 5.2% (commercial) and 21.7% (open-source models) of generated code samples reference packages
    that do not exist (USENIX Security 2025).
  - 43% of hallucinated names come back on every repeat of the prompt, and such names are
    registered by attackers ("slopsquatting", CSA, April 2026).
  - Recommended checks: lockfiles with hashes, the package exists in the registry, packages
    registered recently are flagged.
- **Gate only what is new.** The common way to adopt a checker on an existing code base:
  - SonarQube's *new code* (the PR diff, or since a version, date or branch);
  - Semgrep's `SEMGREP_BASELINE_REF`;
  - reviewdog's `-filter-mode=added`;
  - baseline files: PHPStan and Psalm report baseline entries that no longer occur; detekt keys
    them by rule, file and signature, not line;
  - Betterer: a ratchet, so results may only improve.

  On GitHub, code scanning tracks an alert across runs only through
  `partialFingerprints.primaryLocationLineHash` and a stable `ruleId`.

## 4. ProvenFlow before this work, against those goals

| Goal | What exists (with file) | What is missing |
| --- | --- | --- |
| Existing patterns | Layer rules and their cycles, proved by nuXmv; facade bypass; import cycles (`architecture.ts`). Ten design patterns recognised, with a confidence level, and checked against their contracts (`patterns.ts`). Declared paradigm per layer (`paradigm.ts`). | Conventions must be **declared** by hand in `provenflow.config.json`; nothing proposes them from the code. Naming conventions are not checked. Instruction files (AGENTS.md, CLAUDE.md) are not read. |
| Duplication | None. Function facts (`ir.ts` `FunctionFact`) have name, size, parameters, mutation and effects, but no body fingerprint. | Clone detection; "an existing helper already does this"; copies of a module's internals elsewhere. |
| Complexity, readability | `god-class`, `deep-inheritance` (warnings); `long-function`, `many-parameters` (notes); thresholds in `limits`. | Cognitive or cyclomatic complexity, nesting depth; gating on the *increase* of a measure; naming consistency. |
| Tests | Fixes can be verified with the project's tests (`"verification": { "test": "auto" }`). Counterexamples are replayed on real TypeScript and Python classes (`replay.ts`). Each counterexample gets a vitest/pytest **skeleton** (`it.todo` / `skip`, `report.ts`). Hypothesis tests are generated for drawn diagrams. | No coverage input (LCOV, Cobertura, JaCoCo); no check that changed code has tests; the replays are not written out as runnable regression tests; no mutation testing. |
| Best practices, security | Semgrep (24 bundled rules), CodeQL, Infer, ESBMC/CBMC, Kani, SARIF import. Fixes are kept only after re-running the analysis and the build. | Hallucinated packages and imports are not checked (a missing module only fails the build check when one runs). |
| Gate only what is new | `pflow review --base` keeps the findings on changed lines (`review.ts` `onChanged`). Re-pushes only comment on findings not reported before (key: rule, subject, file). `ignore` entries with a reason. | No comparison with the findings **at the base**: a finding that already existed is new to the review as soon as its line is edited. No baseline file that can only shrink. SARIF results have no `partialFingerprints`, rule help or end lines (`report.ts` `sarif`). |
| CI platforms | GitHub Action: PR review with suggestions, annotations, step summary, Actions-cache incremental state, fork PRs through `workflow_run`. SARIF for code scanning. `--fail-on`, exit code 5. | GitLab Code Quality, Bitbucket, Azure DevOps and reviewdog (rdjson) outputs; documented `merge_group` trigger; a prebuilt release or image (the Action runs `npm ci` and builds three packages on every run); actions pinned by SHA. |
| Agents | The LLM fix loop; `/api/fix` and `/api/verify-change`. | An MCP server or hook mode an agent can call before pushing; a `copilot-setup-steps` recipe; any awareness of which lines an agent wrote. |

One more constraint matters for adoption: **nuXmv is free only for non-commercial and academic
use**, and the Action does not install it. Without nuXmv, an explicit-state checker decides the
standard properties, and properties from the config or the LLM are reported as not checked.
Commercial users need to know exactly what that fallback covers.

## 5. What ProvenFlow needs as a CI/CD check

### 5.1 For an existing code base (first adoption)

1. **A baseline that can only shrink.** `pflow baseline` writes the current findings, keyed by
   rule, subject, file and enclosing symbol (no line numbers, as detekt does), to a committed
   file. Later runs fail only on findings missing from it, and report entries that are gone, so
   the file can be tightened (as PHPStan, Psalm and Betterer do). This is the prerequisite for
   gating a legacy repository without blocking every PR.
2. **A proposed config.** Proposed command: `pflow init`. It would infer `provenflow.config.json`
   from the code as it is, each entry with the evidence for it:
   - layers from the current import graph;
   - the dominant style per layer;
   - structurally recognised patterns;
   - terminal states that look final;
   - naming conventions.

   The team reviews and commits it, and from then on the conventions are checked
   deterministically. This is the deterministic counterpart of Qodo's and Bugbot's mined rules.
3. **Stable SARIF.** `partialFingerprints` from the finding key, rule metadata (`help`,
   `helpUri`, `properties.tags`, `security-severity` for security rules), end lines, one
   `category` per run. Stay within GitHub's limits: 25,000 results per run, 10 MB, and since
   July 2025 no multiple runs of one tool and category in a file (not verified).
4. **Clear licensing and fallback.** Document what the explicit-state checker proves without
   nuXmv, so a commercial team knows what it gets.

### 5.2 For pull requests in progress

5. **New-code gating against the base.** A finding fails the check only if it is on changed
   lines *and* not present at the base, or not in the baseline. The incremental state the Action
   already keeps between pushes can hold the base's results.
6. **Quality checks on the diff** (section 6, phase 2): new clones, re-implemented helpers,
   complexity increases, untested changed code. They are gated on *what the PR adds*, never on
   absolute totals, and percentage gates are skipped on very small changes (Sonar skips below 20
   new lines).
7. **Coverage of the changed lines.** Read LCOV, Cobertura and JaCoCo produced by the project's
   own test job, and report changed lines that no test runs. Lines on a counterexample path come
   first. GitHub's native coverage gate takes Cobertura, so ProvenFlow should read, not replace,
   that pipeline.
8. **Merge queues and required checks.** Document the `merge_group` trigger (a required check
   that never reports fails the merge). Keep a stable check name that rulesets can require. Send
   annotations in batches of 50 (Checks API), and back off on review comments (secondary rate
   limits).
9. **More platforms.** GitLab Code Quality JSON (with `fingerprint`), rdjson for reviewdog
   (Gerrit, Gitea, Bitbucket, GitLab discussions), and an Azure DevOps PR status.
10. **A faster, hardened Action.**
    - Ship a prebuilt bundle or container instead of building on every run.
    - Pin every `uses:` inside `action.yml` by SHA: organisations that enforce SHA pinning
      reject tags, reportedly even inside composite actions (not verified).
    - Publish immutable releases with SLSA provenance, and add SECURITY.md.
    - Run OpenSSF Scorecard on the repository, since a security tool is judged on its own
      hygiene.

### 5.3 For future pull requests written by agents

11. **Run the same check inside the agent's loop.**
    - A `pflow mcp` server exposing: review the working tree against a base, explain a
      finding, propose and verify a fix.
    - A documented Claude Code hook: `PostToolUse` on `Edit|Write` runs a fast incremental
      `pflow review --files` and returns the findings through exit 2 or `additionalContext`, and
      a `Stop` hook refuses to finish while errors remain.
    - A `copilot-setup-steps.yml` recipe that installs `pflow`.
    - An AGENTS.md snippet telling agents to run it.

    Agents can then fix findings before the PR exists. Unmerged agent PRs often fail CI, and
    analyser feedback in the loop cuts violations sharply (section 2).
12. **Read instruction files as candidate rules, from the base branch.** Statements in
    AGENTS.md, CLAUDE.md or REVIEW.md that can be checked deterministically ("UI code never
    imports the database layer", "use `Result`, not exceptions, in core") become proposed config
    entries. An LLM may translate them. Each entry is kept only if it parses into a rule that
    ProvenFlow checks, following the existing LLM trust model.
13. **Document the approval gap.** Workflows on Copilot-agent PRs do not run until someone with
    write access approves them (an admin can change this since March 2026). GitHub's built-in
    validation of agent PRs is limited to its own tools (CodeQL, Advisory Database, secret
    scanning, Copilot review), so ProvenFlow joins as a required check or a code-scanning tool.
    LLM keys stay out of agent and fork runs (the `pull_request` → artifact → `workflow_run`
    split the Action already uses for forks).
14. **Stricter rules for agent-written lines (optional).** Use `Co-authored-by` trailers, Git AI
    notes (`refs/notes/ai`) or Agent Trace records (an RFC, v0.1.0) to require more on AI-written
    lines, e.g. a covering test or a killed mutant. Agent attribution is still young, so this
    stays opt-in.

## 6. Roadmap

Ordered by dependency and value. "Reuses" names what already existed; "Status" is the state on 14
November 2026.

| # | Phase | Item | Reuses | Status |
| --- | --- | --- | --- | --- |
| 1 | Foundation | Finding identity by rule, subject, file and enclosing symbol; SARIF `partialFingerprints` and rule metadata | `findingKey`, `report.ts` | done (`report-formats.ts`) |
| 2 | Foundation | Baseline file that can only shrink (`pflow baseline`, `--update`); new-code gating against the base's findings (`--new-only`), with measures that may not rise | the incremental state, `review.ts` | done (`gate.ts`, `review-run.ts`) |
| 3 | Foundation | Faster Action, SHA-pinned actions, `merge_group`, release provenance, SECURITY.md, Scorecard | `action.yml`, workflows | done, except signed releases with provenance: the Action caches its build instead of shipping a prebuilt bundle |
| 4 | Quality | Clone detection: hashed token windows with names and numbers normalised (Type-1/2), 100 tokens over 10 lines | the front ends | done (`quality/duplication.ts`) |
| 5 | Quality | "An existing helper already does this": token-bag overlap between functions (Type-3), naming the existing one and whether the layer rules allow importing it | layer rules | done (`similar-function`; `find_existing_code` for agents) |
| 6 | Quality | Cognitive Complexity and nesting per function, in every front end; findings on functions a change makes worse | `paradigm.ts` limits | done |
| 7 | Quality | Clones of a module's internals outside it | facades | partly: a clone's fix says to move the code to a layer both may import; no separate rule |
| 8 | Tests | Note when changed source has no changed or covering test | `ModuleFact.isTest` | done (`change-without-test`) |
| 9 | Tests | Read LCOV/Cobertura/JaCoCo; uncovered changed lines | changed lines | done (`uncovered-change`, `untested-complex-function`) |
| 10 | Tests | Write confirmed replays as runnable regression tests | `replay.ts` | not done: scenarios are still skeletons |
| 11 | Tests | Diff-scoped mutation testing | `buildcheck.ts`, workspaces | done (`pflow mutate`, `--mutate`) |
| 12 | Agents | MCP server; Claude Code hook and `copilot-setup-steps` recipes; AGENTS.md section | `single-change.ts` | done (`pflow mcp`, `pflow hook`, `examples/ci/`) |
| 13 | Conventions | `pflow init`: config proposed with evidence | paradigm profile, pattern confidence | done |
| 14 | Conventions | Naming consistency, from the config, the project or the style guide | identifier facts | done (notes) |
| 15 | Conventions | Instruction files read from the base revision as candidate rules, kept only if they validate | LLM trust model | done (`pflow init --instructions`) |
| 16 | Platforms | GitLab Code Quality, rdjson (reviewdog), Azure PR status; Checks API in batches of 50 | `report.ts`, `review.ts` | done, except the Azure DevOps status |
| 17 | Best practice | Hallucinated dependencies: imports neither declared nor installed | import facts | done for TypeScript/JavaScript, Python and Go; no registry lookup |
| 18 | Agents | Stricter policy for agent-written lines (trailers, Git AI notes) | item 2 | done; Agent Trace records are not read yet |
| 19 | Feedback | Per-rule acceptance in the review summary | review markers | done |
| 20 | Conventions | A catalogue of the patterns, principles (*The Pragmatic Programmer*) and anti-patterns checked, each explained in Fowler's pattern form with an example, selectable per project (`checks`) and in the editor; edits shown file by file, before/after | pattern recognition, quality rules, quick fixes | done (`catalogue/`, `quality/practices.ts`, [patterns-and-practices.md](patterns-and-practices.md)) |

The per-language standards behind items 6 and 14 are in [coding-standards.md](coding-standards.md).

A sensible default for agent-written code, comparable to SonarQube's "Sonar way for Agentic AI":
- no new error or warning on new code;
- no new clone;
- no function pushed over the complexity limit;
- every changed source file with a changed or covering test;
- changed-line coverage at a level the team sets.

## 7. Not planned, and why

- **An LLM verdict as the pass/fail signal.** LLM judges are random and sensitive to input order
  (CodeJudgeBench). The LLM stays where it is today: it proposes values, properties, fixes and
  now rules, and a deterministic check decides.
- **Readability scores and the Maintainability Index as gates.** They correlate weakly with
  developers' judgements, or have no sound basis (section 3.3). Complexity and naming findings
  are reported on the specific function and identifier instead.
- **Embedding-based (Type-4) clone detection as a gate.** It could be offered later as an opt-in
  note. Deterministic overlap stays reproducible, and the benchmarks behind semantic clone
  detection are in doubt (section 3.2).
- **Re-implementing coverage or mutation tools.** ProvenFlow reads coverage reports, and drives
  existing mutation tools where they fit, as it already does with Semgrep, Infer and CBMC.

## Research list

Papers and reports behind this document, by topic.

**AI-generated code quality**
- GitClear, *AI Copilot Code Quality* (2025) and *The Maintainability Gap* (2026)
- DORA, *Accelerate State of DevOps* 2024 and *State of AI-assisted Software Development* 2025
- METR, *Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity* (arXiv 2507.09089) and its February 2026 update
- Microsoft/MIT/Princeton field experiments on Copilot (4,867 developers, 2025)
- Google, *AI in software engineering at Google* (2024)
- CodeRabbit, *State of AI vs human code generation* (Dec 2025, vendor)
- Veracode, *GenAI Code Security Report* (2025, 2026)
- Sonar authors on SonarQube issues in LLM Java code, arXiv 2508.14727 (2025)
- LLM and human coding-style inconsistencies, arXiv 2407.00456 (FSE)
- Post-merge quality of agent bug-fix PRs, arXiv 2601.20109 (2026)
- Five coding agents compared on 37,623 PRs, arXiv 2609.17598 (2026)
- Huang et al., *More Code, Less Reuse*, arXiv 2601.21276 (MSR 2026)
- Ji et al., clones in likely LLM-generated code, arXiv 2607.01867 (2026)
- Mao et al., AI and human code in real repositories, arXiv 2603.27130 (2026)

**Agent PRs**
- AIDev dataset, arXiv 2602.09185 (2026), and arXiv 2507.15003 (2025): merge rates by agent
- *Where Do AI Coding Agents Fail?*, arXiv 2601.15195 (MSR 2026)
- Tests in agent PRs, arXiv 2601.21194 (2026; not verified)

**Context, conventions and feedback loops**
- Context files for coding agents, arXiv 2602.11988 (2026)
- NATURALIZE, *Learning Natural Coding Conventions*, arXiv 1402.4182 (2014)
- RepoCoder, arXiv 2303.12570 (EMNLP 2023)
- CloudAPIBench (API hallucination), arXiv 2407.09726 (2024)
- Static-analysis feedback for LLM code, arXiv 2508.14419 (2025)
- INTERVENOR, arXiv 2311.09868 (2024)
- IRIS (LLM-inferred specifications for CodeQL), arXiv 2405.17238 (2025)
- LLMs and static analysers for review comments, arXiv 2502.06633 (2025)
- CodeAgent, arXiv 2402.02172 (EMNLP 2024; not verified)
- CodeJudgeBench, arXiv 2507.10535 (2025)
- Package hallucinations, arXiv 2406.10279 (USENIX Security 2025)
- CSA research note on slopsquatting (April 2026)

**Duplication, complexity, readability**
- SourcererCC, arXiv 1512.06448 (ICSE 2016)
- Krinke & Ragkhitwetsagul, *How the Misuse of a Dataset Harmed Semantic Clone Detection*, arXiv 2505.04311 (2025–2026)
- G. A. Campbell, *Cognitive Complexity* whitepaper v1.7 (2023)
- Muñoz Barón, Wyrich & Wagner, validation of Cognitive Complexity, arXiv 2007.12520 (ESEM 2020)
- van Deursen, *Think twice before using the Maintainability Index* (2014)
- Buse & Weimer, readability model (TSE 2010; not verified)
- Scalabrino et al., *Automatically Assessing Code Understandability* (ASE 2017, TSE 2019; not verified)
- Tornhill & Borg, *Code Red*, arXiv 2203.04374 (TechDebt 2022)
- Borg et al., code health and LLM refactoring, arXiv 2601.02200 (FORGE 2026)

**Tests**
- Petrović et al., *Practical Mutation Testing at Scale*, arXiv 2102.11378 (Google)
- Meta TestGen-LLM, arXiv 2402.09171 (FSE 2024)
- Meta ACH, mutation-guided test generation, arXiv 2501.12862 (2025; not verified)
- CoverUp, arXiv 2403.16218 (2024; not verified)
- LLM test oracles (Molinelli et al., ASE 2025; not verified); MUTGEN, arXiv 2506.02954 (not verified)
- Test smells in LLM-generated tests, arXiv 2410.10628 (not verified)
- Agentic property-based testing, arXiv 2510.09907 (2025)
- Agentless, arXiv 2407.01489 (2024)

## Sources

All checked on 14 November 2026 unless marked otherwise.

- Evidence (section 1):
  - GitClear: https://www.gitclear.com/ai_assistant_code_quality_2025_research ; https://www.gitclear.com/the_ai_code_quality_maintainability_gap
  - DORA: https://cloud.google.com/blog/products/devops-sre/announcing-the-2024-dora-report ; https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report
  - METR: https://arxiv.org/abs/2507.09089 ; https://metr.org/blog/2026-02-24-uplift-update/
  - Microsoft field experiments: https://www.microsoft.com/en-us/research/?p=1148213 ; Google: https://research.google/blog/ai-in-software-engineering-at-google-progress-and-the-path-ahead/
  - CodeRabbit: https://www.coderabbit.ai/blog/state-of-AI-vs-human-code-generation-report
  - Veracode: https://www.veracode.com/resources/genai-code-security-report/ ; https://www.veracode.com/blog/2026-genai-code-security-report-ai-risk
  - Papers: https://arxiv.org/abs/2508.14727 ; https://arxiv.org/abs/2407.00456 ; https://arxiv.org/abs/2601.20109 ; https://arxiv.org/abs/2609.17598 ; https://arxiv.org/html/2601.21276 ; https://arxiv.org/abs/2607.01867 ; https://arxiv.org/abs/2603.27130 ; https://arxiv.org/abs/2602.09185 ; https://arxiv.org/html/2507.15003v1 ; https://arxiv.org/abs/2601.15195
- Guardrails and agents (sections 2 and 5.3):
  - AGENTS.md: https://agents.md/ ; context files study: https://arxiv.org/abs/2602.11988
  - Copilot instructions: https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions ; code review changes: https://github.blog/changelog/2026-06-12-copilot-code-review-new-configurations-and-controls/ , https://github.blog/changelog/2026-06-18-copilot-code-review-agents-md-support-and-ui-improvements
  - Copilot coding agent: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment ; firewall: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall ; validation tools: https://github.blog/changelog/2025-10-28-copilot-coding-agent-now-automatically-validates-code-security-and-quality/ , https://github.blog/changelog/2026-03-18-configure-copilot-coding-agents-validation-tools/ , https://github.blog/changelog/2026-06-09-security-validation-for-third-party-coding-agents ; workflow approval: https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/ , https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/review-copilot-prs
  - Claude Code hooks: https://code.claude.com/docs/en/hooks ; Claude Code Review: https://code.claude.com/docs/en/code-review.md ; Claude Code Action: https://github.com/anthropics/claude-code-action
  - Cursor Bugbot: https://cursor.com/docs/bugbot , https://cursor.com/blog/bugbot-learning
  - Spec Kit: https://github.com/github/spec-kit ; Kiro: https://kiro.dev/docs/steering/ , https://kiro.dev/docs/specs/correctness/
  - Semgrep Guardian: https://docs.semgrep.dev/guardian ; SonarQube Agentic Analysis: https://www.sonarsource.com/blog/agentic-analysis-beta/ ; Codacy Guardrails: https://blog.codacy.com/codacy-guardrails-free-real-time-enforcement-of-security-and-quality-standards ; CodeScene MCP: https://codescene.com/product/mcp-server (vendor claims)
  - CodeRabbit: https://docs.coderabbit.ai/knowledge-base/code-guidelines , https://docs.coderabbit.ai/knowledge-base/learnings , https://docs.coderabbit.ai/tools/list
  - Greptile: https://www.greptile.com/docs/code-review/key-features.md ; Qodo: https://docs.qodo.ai/v1/features/best-practices , https://www.helpnetsecurity.com/2026/06/24/qodo-ai-generated-code-governance/ ; Graphite: https://graphite.com/docs/ai-review-customization.md ; Sourcery: https://docs.sourcery.ai/reviews/review-rules/
  - Copilot code review with deterministic tools: https://github.blog/changelog/2025-10-28-new-public-preview-features-in-copilot-code-review-ai-reviews-that-see-the-full-picture/
  - Agent attribution: https://agent-trace.dev/ ; https://usegitai.com/docs/cli/how-git-ai-works
  - Feedback loops and judges: https://arxiv.org/abs/2508.14419 ; https://arxiv.org/abs/2311.09868 ; https://arxiv.org/abs/2405.17238 ; https://arxiv.org/abs/2502.06633 ; https://arxiv.org/abs/2507.10535
  - Hallucination: https://arxiv.org/abs/2407.09726 ; https://arxiv.org/abs/2406.10279 ; https://labs.cloudsecurityalliance.org/research/csa-research-note-slopsquatting-ai-supply-chain-20260419/
  - Conventions and context: https://arxiv.org/abs/1402.4182 ; https://arxiv.org/abs/2303.12570
- Duplication, complexity, architecture (sections 3.1–3.3):
  - jscpd: https://github.com/kucherenko/jscpd ; PMD CPD: https://pmd.github.io/pmd/pmd_userdocs_cpd.html ; Qlty: https://docs.qlty.sh/duplication.md , https://docs.qlty.sh/code-smells.md
  - SonarQube metrics and gates: https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-metrics/metrics-definition/ , https://docs.sonarsource.com/sonarqube-server/latest/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates/ , https://docs.sonarsource.com/sonarqube-cloud/standards/ai-code-assurance/quality-gates-for-ai-code , https://www.sonarsource.com/blog/introducing-sonarqube-server-2026-4/
  - Codacy gates: https://docs.codacy.com/repositories-configure/adjusting-quality-gates/
  - Clone research: https://arxiv.org/abs/1512.06448 (not verified) ; https://arxiv.org/abs/2505.04311
  - Cognitive Complexity: https://www.sonarsource.com/docs/CognitiveComplexity.pdf ; validation: https://arxiv.org/abs/2007.12520
  - ESLint complexity: https://eslint.org/docs/latest/rules/complexity ; lizard: https://github.com/terryyin/lizard ; radon: https://radon.readthedocs.io/en/latest/intro.html ; Maintainability Index critique: https://avandeursen.com/2014/08/29/think-twice-before-using-the-maintainability-index/
  - CodeScene: https://codescene.io/docs/guides/technical/code-health.html ; https://arxiv.org/abs/2203.04374 ; https://arxiv.org/abs/2601.02200
  - Readability: https://web.eecs.umich.edu/~weimerw/p/weimer-tse2010-readability-preprint.pdf (not verified) ; https://ieee-dataport.org/node/974
  - Architecture: https://import-linter.readthedocs.io/en/stable/ ; https://github.com/gauge-sh/tach ; https://nx.dev/docs/features/enforce-module-boundaries.md ; https://github.com/javierbrea/eslint-plugin-boundaries ; https://qossmic.github.io/deptrac/configuration/ (not verified)
- Gating and CI (sections 3.5 and 5):
  - SonarQube new code: https://docs.sonarsource.com/sonarqube-server/latest/user-guide/about-new-code/ ; Semgrep diff-aware scans: https://docs.semgrep.dev/deployment/customize-ci-jobs ; reviewdog: https://github.com/reviewdog/reviewdog
  - Baselines: https://phpstan.org/user-guide/baseline ; https://detekt.dev/docs/introduction/baseline/ ; https://psalm.dev/docs/running_psalm/dealing_with_code_issues/ ; https://phenomnomnominal.github.io/betterer/docs/introduction
  - GitHub SARIF: https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning , https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github ; multiple runs per category (not verified): https://github.blog/changelog/2025-07-21-code-scanning-will-stop-combining-multiple-sarif-runs-uploaded-in-the-same-sarif-file/
  - Checks and reviews API: https://docs.github.com/en/rest/checks/runs , https://docs.github.com/en/rest/pulls/reviews
  - Rulesets, merge protection, merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets , https://docs.github.com/en/code-security/code-scanning/managing-your-code-scanning-configuration/set-code-scanning-merge-protection , https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
  - GitLab Code Quality: https://docs.gitlab.com/ci/testing/code_quality/ ; Azure DevOps PR status: https://learn.microsoft.com/en-us/azure/devops/repos/git/pr-status-policy ; Bitbucket Code Insights (not verified): https://developer.atlassian.com/server/bitbucket/how-tos/code-insights
  - Untrusted PR code: https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/ ; OpenSSF Scorecard: https://github.com/ossf/scorecard/blob/main/docs/checks.md ; SHA pinning policy: https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/ ; inside composite actions (not verified): https://dev.classmethod.jp/articles/github-actions-require-sha-pinning/ ; workflow lockfiles (not verified): https://github.blog/changelog/2026-10-14-github-actions-workflow-lockfiles-in-public-preview/
- Tests (section 3.4):
  - diff-cover: https://github.com/Bachmann1234/diff_cover ; Codecov: https://docs.codecov.com/docs/commit-status ; Coveralls: https://github.com/coverallsapp/coverage-reporter
  - GitHub PR coverage: https://github.blog/changelog/2026-05-26-code-coverage-in-pull-requests-is-now-in-public-preview/ ; https://github.blog/changelog/2026-09-18-manage-the-code-coverage-ruleset-condition-with-the-rest-api
  - Mutation testing: https://arxiv.org/abs/2102.11378 ; https://stryker-mutator.io/docs/stryker-js/incremental/ ; https://mutants.rs/in-diff.html
  - Test generation: https://arxiv.org/abs/2402.09171 ; https://arxiv.org/abs/2501.12862 (not verified) ; https://arxiv.org/abs/2403.16218 (not verified) ; https://arxiv.org/abs/2510.09907 ; https://arxiv.org/abs/2407.01489
