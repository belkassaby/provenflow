# State of the art: designing, verifying and running agentic state machines

*Survey date: 25 September 2026; section 2.9 on 27 September 2026, updated the same day when
ProvenFlow started driving the analysers it lacked (Semgrep, Infer, ESBMC/CBMC, Kani, CodeQL). The claims about other tools
were checked against their documentation, repositories or arXiv abstracts on those dates (links in
[Sources](#sources)). Items
marked "not verified" come from general knowledge and were not re-checked.*

LLM agents are increasingly built as explicit control flows — graphs, state machines,
workflows — around non-deterministic model calls. This document looks at the tools in the
domains that such a system touches, from design to operation, and at where ProvenFlow fits:
what it has that the others do not, and what the others do that it does not.

## 1. Summary

The individual pieces all exist:
- visual state-machine editors (Stately, Workflow Studio);
- agent frameworks with live graph views (LangGraph Studio, the Burr UI, Microsoft's DevUI);
- model checkers (nuXmv, SPIN, TLC, UPPAAL, PRISM, Storm);
- runtime-verification tools (NuRV, RTAMT);
- research prototypes that check agent graphs or constrain agents with temporal rules (Agentproof,
  TraceFix, AgentSpec, ProbGuard, Agent-C).

No tool we found combines them on one artifact. ProvenFlow takes a diagram and, from that
single source:
1. verifies it with a temporal-logic model checker, and replays counterexamples on the drawing;
2. generates an implementation that refuses the transitions the model does not have;
3. monitors the same properties at run time;
4. shows the running system live on the diagram;
5. checks recorded runs against the model;
6. adds probabilities;
7. exports to or imports from agent frameworks.

Its limits: it verifies the *control flow*, not what the LLM says within a state. Its models are
flat, finite-state and discrete-time. And it is a design and verification tool, not a production
orchestrator (it hands that to Temporal, LangGraph or Burr).

### Capability matrix

✓ = supported; ◐ = partly (see the domain sections); — = not supported, as far as the sources
show.

| | Visual design | Temporal-logic model checking | Counterexample on the diagram | Runtime enforces the model | Runtime monitors of the same properties | Live view of the running system | Recorded-trace conformance | Probabilistic analysis | Import from / export to agent frameworks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **ProvenFlow** | ✓ | ✓ nuXmv (LTL, CTL, past LTL) | ✓ | ✓ Python | ✓ built-in past-time + NuRV | ✓ editor + Jupyter | ✓ JSONL / OpenTelemetry | ✓ built-in + PRISM export | ✓ LangGraph, CrewAI, Mermaid, XState in; XState, LangGraph, Burr, Temporal out |
| transitions + transitions-gui | ◐ diagrams (graphviz / mermaid) | — | — | ✓ | — | ✓ browser (gui) | — | — | — |
| python-statemachine | ◐ diagrams, Jupyter rendering | — | — | ✓ (guards, validators) | — | ◐ Jupyter | — | — | — |
| pydantic-graph | ◐ mermaid | — | — | ✓ edges from type hints | — | — | — | — | — |
| XState + Stately | ✓ editor | — | — | ✓ | — | ✓ Inspector | — | — | ◐ exports code, JSON, Mermaid |
| LangGraph + Studio | ◐ Studio visualises | — | — | ✓ | — | ✓ Studio | — | — | ◐ graph JSON, Mermaid |
| Apache Burr | ◐ tracking UI | — | — | ✓ | — | ✓ tracking UI | — | — | ◐ OpenTelemetry |
| CrewAI Flows / LlamaIndex Workflows | ◐ HTML plot | — | — | ✓ | — | ◐ (LlamaIndex debugger UI) | — | — | — |
| Microsoft Agent Framework | ◐ DevUI | — | — | ✓ | — | ✓ DevUI | — | — | — |
| Temporal | — | — | — | ✓ durable, deterministic replay | — | ◐ web UI of histories | ◐ replay of histories | — | — |
| AWS Step Functions Workflow Studio | ✓ | — | — | ✓ | — | ◐ execution view | — | — | ◐ JSON / YAML |
| nuXmv / NuSMV alone | — | ✓ | — (text traces) | — | — | — | — | — | — |
| TLA+ / TLC, SPIN, UPPAAL | ◐ UPPAAL | ✓ | ◐ UPPAAL simulator, text traces | — | — | — | — | ◐ UPPAAL SMC | — |
| PRISM / Storm | — | ✓ probabilistic | — | — | — | — | — | ✓ | — |
| NuRV | — | ✓ (nuXmv inside) | — | — | ✓ generates monitors | — | ◐ offline RV | — | — |
| RTAMT | — | — | — | — | ✓ STL monitors | — | ✓ offline | — | — |
| Agentproof (research) | — | ◐ DFA policies on extracted graphs | — | — | ✓ runtime over events | — | ✓ event traces | — | ✓ extracts LangGraph, CrewAI, AutoGen, ADK |
| TraceFix (research) | — | ✓ TLA+ / TLC | — | ✓ runtime monitor | ✓ | — | — | — | — |
| AgentSpec / ProbGuard / Agent-C / ShieldAgent (research) | — | ◐ (Agent-C: SMT) | — | ✓ runtime enforcement | ✓ | — | — | ◐ ProbGuard: learned DTMC | — |
| NeMo Guardrails / Invariant Guardrails | — | — | — | ✓ flows / policies | ✓ | — | ◐ Invariant: trace policies | — | — |

*The rows for TLA+/TLC, SPIN and UPPAAL, and the Temporal and Step Functions execution views, come
from general knowledge; the other rows come from the sources checked for this survey.*

## 2. The domains

### 2.1 State-machine libraries and visual editors

- **pytransitions/transitions.** The reference Python FSM library. It has `conditions` and
  `unless` guards and before/after and enter/exit callbacks. `GraphMachine` draws diagrams with
  pygraphviz, graphviz or mermaid, and example Jupyter notebooks show graph editing. Its companion
  **transitions-gui** is a standalone browser application (Tornado, WebSocket, Cytoscape.js). It
  shows a running machine live and lets you fire an event by clicking an edge. It is not a Jupyter
  widget, and neither project verifies temporal properties.
- **python-statemachine.** Guards (conditions) and validators, Graphviz and Mermaid diagrams, and
  automatic rendering of machine instances as diagrams in JupyterLab.
- **pydantic-graph** (Pydantic AI). Graph edges come from the return type hints of each node's
  `run`, so the edges are enforced by construction. It renders Mermaid diagrams and persists
  state. The model *is* the code, so there is no separate specification to verify.
- **XState v5 + Stately.** A visual statechart editor with design and simulate modes, with export
  to JSON, JavaScript/TypeScript and Mermaid. The **Stately Inspector** shows running actors live,
  mostly for XState and front-end code, though it also works with back-end code and other state
  management. Statecharts support hierarchy and parallel regions, which ProvenFlow does not.
  It has no temporal-logic verification.
- **AWS Step Functions Workflow Studio.** Drag-and-drop design that generates Amazon States
  Language, with JSON/YAML export and an execution view.

**ProvenFlow compared.** Its editor is simpler than Stately: flat states, no hierarchy or
parallel regions. What it adds is model checking of the drawing, with counterexamples replayed on
it, and a generated runtime whose monitors re-check the verified properties. Its XState export
and import mean a machine can move between the two.

### 2.2 Agent orchestration frameworks

- **LangGraph.** A `StateGraph` with conditional edges. Checkpointers persist the graph state and
  enable human-in-the-loop, time travel and fault tolerance. Interrupts pause for external input.
  **LangGraph Studio** (in LangSmith) is an agent IDE for visualising, inspecting and time-travel
  debugging runs.
- **Apache Burr** (incubating, from DAGWorks). Agents are explicit state machines of actions and
  transitions, with a tracking UI, OpenTelemetry support and pluggable persisters.
- **CrewAI Flows.** `@start`, `@listen` and `@router` decorators; `plot()` writes an interactive
  HTML view.
- **LlamaIndex Workflows.** Event-driven steps; `draw_all_possible_flows` writes an HTML view,
  and a WorkflowServer adds a debugger UI.
- **Microsoft Agent Framework.** The successor to Semantic Kernel and AutoGen: workflows with
  superstep checkpoints, human-in-the-loop requests, and **DevUI**, a sample application for
  visualising and debugging agents and workflows. The earlier Semantic Kernel Process Framework is
  marked experimental.
- **Temporal.** Durable execution. Workflow code must be deterministic so it can be replayed from
  its event history; interaction with the outside world, including LLM calls, goes into
  activities. Signals and queries let people and other systems interact with a running workflow.
- **Visual agent builders**: n8n, Langflow, Dify, Flowise *(not verified)*. Low-code graphs of LLM
  steps, without formal verification.

**ProvenFlow compared.** These frameworks *run* agents. None of them states or checks
temporal properties of the graph: that a human approves every release, that retries are bounded,
that a state is reachable. ProvenFlow does not replace them. It verifies the control flow and
then exports it: to LangGraph (a node per state), Burr (an action per state), Temporal (decisions
as activities, human steps as signals) or XState. In each export every move goes through the
verified transition table. The importers read existing LangGraph (JSON, Mermaid, source), CrewAI
Flow, Mermaid and XState graphs, so agents that are already built can be verified. In return,
those frameworks provide what ProvenFlow leaves to them: persistence, scale, retries, tool
integrations, deployment.

### 2.3 Model checkers and specification languages

- **nuXmv / NuSMV** (FBK). Symbolic model checking of LTL, CTL and invariants over finite and
  infinite-state models, with BDD, BMC and IC3 engines. This is the engine ProvenFlow uses.
- **TLA+ / TLC and Apalache**, **SPIN / Promela**, **UPPAAL** (timed automata, with a graphical
  editor, simulator and statistical model checking) *(not verified)*. All mature. They are textual
  (UPPAAL excepted) and none generates agent code or runtime monitors.

**ProvenFlow compared.** It makes a model checker usable by people who design agents. They
draw or type the machine and write properties from templates (termination, human gates, step
order, reachability). Counterexamples are replayed on the drawing instead of read as text.
Expressiveness is below TLA+ or UPPAAL: no clocks, no processes, no unbounded data.

### 2.4 Formal methods for LLM agents (research, 2024–2026)

- **Agentproof** (arXiv 2603.20356, March 2026). Extracts graphs from LangGraph, CrewAI, AutoGen
  and Google ADK. It checks structure, and checks temporal policies written in a DSL compiled to
  DFAs, both statically (graph × DFA) and at run time over event traces. On 18 workflows built by
  the authors, 27% had structural defects and 55% violated a human-gate policy. The authors say
  this is *not* a prevalence study. It is the closest work to ProvenFlow's check-then-monitor
  design; it has no editor, no counterexample replay and no LTL/CTL model checker.
- **TraceFix** (arXiv 2605.07935, May 2026). An LLM writes a PlusCal coordination protocol and
  repairs it with TLC counterexamples. The verified process bodies are compiled into per-agent
  prompts and run under a runtime monitor.
- **AgentSpec** (arXiv 2503.18666). A rule language of trigger, predicate and enforcement for
  runtime constraints. It reports preventing unsafe executions in over 90% of code-agent cases.
- **ProbGuard**, first titled Pro2Guard (arXiv 2508.00500). Learns a discrete-time Markov chain
  from execution traces and intervenes when the predicted probability of reaching an unsafe state
  passes a threshold.
- **Agent-C** (arXiv 2512.23738). A temporal-constraint DSL translated to first-order logic, with
  SMT checks and constrained decoding during generation.
- **ShieldAgent** (arXiv 2503.22738). Verifiable safety-policy reasoning with action-based
  probabilistic rule circuits.
- **Formal-LLM** (arXiv 2402.00798). An automaton constrains how the LLM generates its plan.
- **VeriPlan** (arXiv 2502.17898, CHI 2025). End-user planning in which LLM-translated rules are
  checked by a model checker.
- **StateFlow** (arXiv 2403.11322). Models LLM task-solving as state machines; reports higher
  success than ReAct at lower cost.

**ProvenFlow compared.** It is a tool rather than a research prototype. Its guardrails are
explicit, visual and verified before deployment, and the same formulas are enforced at run time.
What it does *not* do, and the research above does, is constrain what the LLM *produces*: tokens
(Agent-C) or tool arguments (AgentSpec). It does offer the legal next events for constrained
decoding: `allowed_events()` as a tool `enum`, and `Rejected.as_feedback()` for the model.

### 2.5 Runtime verification, guardrails and observability

- **NuRV** (FBK). Runtime verification built on nuXmv, online and offline, with monitors *under
  assumptions*: the model is used to reach verdicts early. It generates monitors in C, C++, Java,
  Python, Common Lisp, Prolog, LLVM IR and FMU. It is free for academic use.
- **RTAMT.** A Python library for Signal Temporal Logic, online and offline, discrete and dense
  time. Its online monitors take the bounded-future fragment and translate it to past-time STL.
- **NeMo Guardrails** (Colang flows for dialogue and guardrails), **Invariant Guardrails** (a
  policy language over agent traces) and **Guardrails AI** *(not verified)*: policy layers around
  LLM calls.
- **OpenTelemetry GenAI semantic conventions.** Now in their own repository, still in development.
  They define agent and workflow spans (`invoke_agent`, `create_agent`, `invoke_workflow`) and tool
  spans (`execute_tool`).

**ProvenFlow compared.**
- Its built-in monitors cover invariants and G(present/past) formulas, compiled with the classic
  incremental construction.
- The NuRV integration adds full-LTL monitors under the model's assumptions. It generates the NuRV
  script, runs NuRV, compiles the C, and works around two issues in NuRV 2.0.0's Python wrapper: the
  library path and an extra argument.
- `enable_tracing()` emits spans with `fsm.*` attributes, and the conformance checker reads them
  back. The spans do not yet follow the GenAI conventions' names.
- Guardrail frameworks such as NeMo or Invariant filter content; ProvenFlow constrains the
  *process*. The two are complementary.

### 2.6 Probabilistic model checking

**PRISM** (DTMC, CTMC, MDP, PTA, POMDP; PCTL, CSL, LTL, rewards) and **Storm** (PRISM, JANI and
explicit inputs; Python bindings) are the reference tools. ProbGuard and VeriPlan apply
probabilistic models to agents.

**ProvenFlow compared.** The `prob` annotations turn a diagram into a Markov chain over
configurations. The editor computes reachability probabilities (bounded and unbounded), expected
steps and expected visits, and exports the chain to PRISM/Storm for everything else. Its values
match PRISM 4.10.1 in the test suite. It has no MDP (nondeterminism *and* probability), no
continuous time, and no probabilities learned from traces as ProbGuard does. Learning them from
recorded runs would be a natural next step.

### 2.7 Notebooks and live visualisation

- **ipycytoscape**: a Cytoscape.js widget for JupyterLab and the classic notebook.
- **python-statemachine**: renders a machine as a diagram in JupyterLab.
- **transitions**: example notebooks. Live views otherwise live outside notebooks:
  transitions-gui, the Stately Inspector, LangGraph Studio, the Burr UI, DevUI.

**ProvenFlow compared.** Generated machines display as SVG in any notebook, and as a live
anywidget/Cytoscape.js widget that follows every transition. The editor itself can follow and
drive a running process over a two-way link, where transitions-gui drives a *transitions* machine
from its page.

### 2.8 Checking a code base: static analysis, software model checking, specification mining, LLM review

This domain matters for `pflow extract`, which checks existing or AI-generated code rather than a
drawn design.

- **Static analysers.**
  - Meta **Infer** covers Java, C/C++/Objective-C, Erlang, Hack and some Python. Its Pulse analysis
    reports resource leaks and builders that are never finished. Topl is an experimental typestate
    checker, where the user writes the property as an automaton.
  - **CodeQL** turns code into a database and runs QL queries on it (security and variant analysis).
  - **Semgrep** matches code patterns, with an AI layer that triages findings and writes Autofix
    remediations.
  - **SonarQube** has Bug, Vulnerability and Code-Smell rules, the Cognitive Complexity metric, and
    LLM fix suggestions (AI CodeFix).
  - None of these checks temporal properties, and none extracts models.
- **Architecture rules.**
  - **ArchUnit** (Java) and **ArchUnitTS** check layers, cycles and naming as unit tests.
  - **dependency-cruiser** checks JS/TS dependency rules, and **Madge** finds circular
    dependencies.
  - All of them work at the level of imports; none looks at behaviour or design patterns.
- **Software model checkers.**
  - **CBMC**, **ESBMC**, **Kani** (Rust), **CPAchecker**, **JBMC** and **Java PathFinder** check
    assertions, memory safety, overflows, panics, deadlocks and exceptions of C/C++/Rust/Java
    programs. ESBMC also covers Python, Kotlin and Solidity, and has work on LLM-generated
    invariants.
  - FBK's **Kratos2** (from the group behind nuXmv) verifies reachability and liveness of
    imperative programs, written in its K2 language or through a C front end. It produces
    counterexamples.
  - They check the code itself, at the level of statements. They do not give a model of an
    application's lifecycles or patterns that one can look at.
- **Specification mining and automata learning.**
  - **Daikon** reports likely invariants from observed runs.
  - **Synoptic** and **CSight** infer finite-state models from logs.
  - **LearnLib** and **AALpy** learn automata by querying a running system.
  - They infer models from runs and do not check the source.
- **LLMs and verification (research).**
  - **SpecGen** and **AutoSpec** generate specifications with an LLM and keep those a verifier
    accepts.
  - **Lemur** combines LLMs with sound automated reasoners.
  - **Clover** checks code, docstrings and Dafny annotations against each other.
  - **PyVeritas** has an LLM transpile Python to C for CBMC.
  - **IC3-Evolve** admits LLM patches only after proof validation.
- **LLM code review.**
  - **GitHub Copilot code review** uses tuned models and prompts, with no formal verification.
    Its documentation warns that it may miss issues.
  - **CodeRabbit** combines LLM review with linters and SAST tools.

**ProvenFlow compared.** `pflow extract` reads TypeScript (with the type checker), Angular
templates and Python. Through tree-sitter grammars it also reads Java, Kotlin, Groovy, Scala, C,
C++, C#, Go, Rust, Swift, Ruby, PHP and R. From them it builds four kinds of model:
- state machines of fields with finite types;
- typestate models of resource lifecycles;
- behavioural contracts of design patterns;
- the layer graph.

It checks them all with nuXmv, maps counterexamples back to code events, checks the declared
paradigm of each layer, and outputs SARIF. Its LLM step follows the same principle as SpecGen,
AutoSpec and IC3-Evolve, applied to application code: proposals are kept only after deterministic
re-verification (a cited write exists, the property parses and nuXmv decides it, a patch passes a
full re-run). None of the tools above, as far as their documentation shows, covers this whole
chain.

Rather than re-implement those analysers, ProvenFlow now drives them when they are installed, and
puts their results in the same report, review and fix loop as its own models:

| Gap | Filled with | What it gives | Limits that remain |
| --- | --- | --- | --- |
| Dataflow and security analysis | **Semgrep** with 24 bundled taint and pattern rules (JS/TS, Python, Java, Go, C), plus any Semgrep registry config; **CodeQL** security suites (opt-in); SARIF of any other tool | command, code and SQL injection, path traversal, SSRF, XSS, unsafe deserialisation, disabled TLS checks, hard-coded secrets; data flows as related locations; Semgrep autofixes become proposals verified like quick fixes | Semgrep's open-source taint mode stays inside a function (across functions and files needs Semgrep Pro, or CodeQL); CodeQL's CLI is free only for open-source code and research |
| Memory safety and arithmetic | **ESBMC** or **CBMC** on every C/C++ function (nondeterministic inputs); **Kani** `autoharness` on Rust crates | pointer, bounds, leak, overflow and division-by-zero checks for *every* input, with the failing trace; a function with no failure is a proof up to the unwinding bound | bounded (loops unwound 8 times by default); no caller preconditions, so a function whose callers guarantee a valid pointer is still reported; Kani's autoharness is an unstable feature |
| Interprocedural heap analysis | **Infer** (Pulse) on C/C++/Objective-C (captured with `clang -fsyntax-only`, nothing written to the project) and Java | null dereferences, leaks and other manifest bugs across calls, with Infer's trace as counterexample | Infer reports manifest bugs only (latent ones, which depend on the caller, are not); Java needs a build command when the sources do not compile alone |
| Pattern recognition | confidence levels | each pattern is *declared* (config or an `@pattern` comment), *structural* (types, `implements`, `providedIn`, a private constructor) or *heuristic* (names and shapes); findings on heuristic ones are notes, not warnings | recognition itself is still by shape; declaring the pattern is how a team makes it a contract |

Its own models remain abstractions. Two checks now tie them back to the code: counterexamples of
state-machine findings (TypeScript and Python), stale writes after an `await` and timer leaks are
**replayed on the real classes** (with the dependencies mocked), and unreachable values of C
state variables are checked on the code by ESBMC/CBMC with a generated harness that calls the
file's functions in any order. Each finding says whether it was confirmed, refuted or not checked.

### 2.9 Code review with model checking and formal verification

Review tools that go beyond linting fall into five groups.

**Review bots and platforms with analysers, no formal methods.**
- **Google Tricorder** shows analyser results as comments on the changed lines at code review,
  with one-click fixes (Error Prone, among others). Its paper notes that most of its analyses use
  no data-flow analysis or abstract interpretation.
- **Amazon CodeGuru Reviewer** combined program analysis with machine learning. It commented in
  pull requests, for Java and Python. It has been closed to new repositories since November 2025.
- **GitHub Copilot Autofix** generates fixes for CodeQL alerts inline on pull requests. The fixes
  are not verified: GitHub evaluates the model offline, re-scanning about 2,300 alerts, and its
  documentation warns that a fix can be wrong or partial.
- **Snyk DeepCode AI Fix** does check each LLM fix again with its symbolic rule engine: the fix
  must parse, remove the issue and add no new finding. That is a re-scan, not a proof.
- **Semgrep Assistant** opens pull requests with generated fixes.

**Formal analysis in code review.**
- Meta's **Infer** (separation logic, bi-abduction) runs on every diff and comments in review.
  Reporting at diff time raised the fix rate to about 70%, against almost 0% for batch reports. It
  reports but proposes no fix.
- **SapFix** proposes fixes for crashes found by Sapienz and Infer: a revert, a template or a
  mutation. They are validated by compiling and running tests, then reviewed by a person.
- Microsoft's **Static Driver Verifier** checked Windows drivers against interface rules on every
  path. It was removed from the 24H2 WDK in favour of CodeQL.

**Model checkers as pull-request gates.** Their proofs rely on harnesses or specifications that
people write:
- the **CBMC** proofs of AWS s2n-tls are validated on every pull request;
- the **Kani** GitHub Action runs Rust proof harnesses in CI;
- the **Certora** Prover action posts verification results on pull requests for smart-contract
  rules;
- **cbmc-viewer** links CBMC error traces to the source lines, the way ProvenFlow maps
  counterexamples to code.

None of them extracts a model from the code, and none proposes fixes.

**Model checking of designs.**
- The **P** language (AWS) checks the interleavings of communicating state machines, used for
  S3, DynamoDB, EBS and others. PObserve then checks production logs against the same
  specifications.
- **Apalache** checks TLA+ specifications with Z3.

Both check a design written by hand, beside the code.

**Model extraction and verified repair (research).**
- **Modex** extracts SPIN models from C, and **Bandera** extracted SMV/SPIN models from Java (it
  has been dormant since about 2005). Both are offline tools, without review or repair.
- **ESBMC-AI** is the closest to ProvenFlow's fix loop: bounded model checking finds a violation,
  the counterexample goes into the LLM prompt, and the patch is checked again until it passes. It
  works on C programs, and its authors foresee CI use.
- Other work uses the verifier as the oracle for LLM output: **AutoSpec** (ACSL specifications
  checked by Frama-C), specification-guided repair of **Dafny** programs, and **Lemur** (LLM
  invariants checked by sound reasoners).
- **Verifix** repairs student programs with a verified equivalence to a reference solution.

**ProvenFlow's Code base review compared.** It works on a whole project in 15 languages:
- it *extracts* the models (state machines, resource lifecycles, pattern contracts, layers), with
  no harness or specification to write;
- it checks them with nuXmv's LTL/CTL, and maps each counterexample to the calls in the code;
- it proposes changes: deterministic quick fixes, or LLM patches;
- a change is marked verified only when re-running the whole analysis on the patched code removes
  the finding without adding any, the same principle as ESBMC-AI and Snyk's re-scan;
- the review shows the original and proposed code, and the model before and after, side by side;
- the reviewer applies one change or all of them, and conflicting changes are detected;
- SARIF output puts the findings on GitHub pull requests, and `--fail-on` makes it a CI gate.

As far as the sources show, no other tool puts model extraction, temporal-logic checking and
re-verified repair into one review loop.

The gaps this section listed before, and where they stand:

| Was lacking | Now | Still true |
| --- | --- | --- |
| Proofs of memory safety or of the absence of crashes | ESBMC/CBMC per C/C++ function and Kani per Rust crate: proved, refuted (with a finding and its trace) or unknown, in a *Tools & proofs* table; Infer for heap bugs across calls | bounded proofs, C/C++/Rust only; Java, Go, Python and TypeScript get no crash proof (Infer covers Java null dereferences) |
| Security and dataflow rules | Semgrep (bundled rules, autofixes verified), CodeQL (opt-in), SARIF import | intraprocedural taint unless CodeQL runs |
| A verified change was only a proof about the model | a change is verified when the full analysis re-run *and* the analysers (on the changed files) *and* the build pass; findings are replayed or model checked on the code | still not a full proof of the program: bounded checks, and replays of one scenario |
| No compile or test run | each proposed change is applied to a temporary copy (dependencies linked, not copied) and built or type checked: `npm run typecheck` / `tsc --noEmit`, `py_compile`, `go build`, `cargo check`, `mvn compile`, Gradle, `dotnet build`, `clang`/`clang++ -fsyntax-only`; tests with `"verification": { "test": "auto" }` or a command; checks that already fail on the unchanged project are not held against the change | tests are opt-in (they can be slow); a project whose build needs services or secrets needs its own command |
| Only a local server or a CLI step | `pflow review --base <ref> --github` and a GitHub Action (`uses: belkassaby/provenflow@v0`): findings on the changed lines only (the diff-time reporting Infer found far more effective), posted as a pull-request review, with each verified single-file change as a one-click GitHub *suggestion* | it runs in the repository's own Actions with its token, not as a hosted GitHub App |

So the loop is now: extract and check models; run the code-level analysers; confirm the model
findings on the code; propose a change; accept it only if every check, the analysers and the
build agree; review it on the diff.

## 3. Why it matters for LLM agents

- **Agents fail in the ways model checking finds.** The MAST taxonomy (arXiv 2503.13657; 1,600+
  traces, 7 frameworks) counts step repetition and unawareness of termination or stopping
  conditions among the most frequent failures. The current version reports 15.7% and 12.4%; v2
  reported 17.14% and 9.82%. Both are loop and termination defects that nuXmv proves or refutes.
- **Human gates get skipped.** In July 2025 Replit's agent ran destructive commands during a code
  freeze and deleted production data (AI Incident Database, incident 1152). A past-time guardrail
  such as "production changes only right after human approval" is checked by nuXmv and enforced at
  the transition by the generated runtime.
- **Practitioners call for explicit control flow.** Anthropic's *Building effective agents*
  (December 2024) prefers workflows for predictability, with stopping conditions such as a maximum
  number of iterations and checkpoints for human feedback. *12-factor agents* (factor 8) says to
  "own your control flow".
- **Regulation asks for oversight.** Article 14 of the EU AI Act requires high-risk systems to be
  effectively overseeable by people. 14(4)(e) includes the ability to "interrupt the system through
  a 'stop' button or a similar procedure that allows the system to come to a halt in a safe state".
  This applies to high-risk uses, not all agents. A verified model with human-gate properties,
  runtime monitors, conformance checks and a live view gives evidence that the oversight exists and
  works.

## 4. What ProvenFlow brings, and what it lacks

**Brings, in one tool, from one diagram:**
1. Visual and textual design (Langium grammar, Cytoscape.js), with layouts that minimise
   crossings.
2. Model checking with nuXmv: LTL, CTL, past-time LTL and invariants, with BDD, BMC and IC3, over
   finite models with guards and bounded data. Counterexamples are replayed on the diagram.
3. Probabilistic analysis of the same diagram, and PRISM/Storm export.
4. A generated Python runtime that only takes verified transitions, with rejection policies for
   LLM feedback and escalation, and monitors of the verified properties: built-in past-time, and
   full LTL through NuRV.
5. Jupyter notebooks with a live widget; a two-way live link to running processes; OpenTelemetry
   spans.
6. Trace conformance of recorded runs (JSON Lines or OpenTelemetry), replayed on the diagram.
7. Hypothesis property-based tests that check an implementation's hooks against the model.
8. Exports to XState, LangGraph, Burr and Temporal; imports from LangGraph, CrewAI, Mermaid and
   XState.
9. Tests that check the pieces agree with each other in both directions: nuXmv, the TypeScript
   semantics, the generated Python, NuRV and PRISM.
10. From code to model (`pflow extract`): it extracts and verifies the state machines, resource
    lifecycles, design-pattern contracts and layers of a code base in 15 languages. It maps
    counterexamples to code, checks the declared paradigm of each layer, and emits SARIF for CI
    (section 2.8).
11. Code base review in the editor: findings next to the models they come from. Quick fixes and
    LLM patches are verified by re-running the analysis. The review shows the code and the model
    before and after, side by side, and the reviewer applies one change or all of them, in place
    (section 2.9).
12. Code-level analysers in the same loop (sections 2.8 and 2.9): Semgrep and CodeQL for security
    and dataflow, Infer for the heap, ESBMC/CBMC and Kani for memory safety and arithmetic (with a
    table of proofs); model findings replayed or model checked on the real code; every proposed
    change built or type checked on a copy; `pflow review` and a GitHub Action that review pull
    requests with verified suggestions.

**Lacks:**
- *Structure*: no hierarchical or parallel states (Stately has statecharts), no multiple modules or
  processes, no clocks or dense time (UPPAAL, RTAMT).
- *Data*: only bounded integers, booleans and enumerations; large domains run into state explosion,
  as all explicit and BDD methods do.
- *Scope of the guarantee*: verification covers the model, not what the LLM does inside a state.
  The implementation matches the model only as far as the generated runtime, tests and conformance
  checks enforce it.
- *Probabilistic modelling*: no MDPs, and no probabilities learned from traces.
- *Operations*: no persistence, scheduling or distribution (these are delegated to Temporal,
  LangGraph and Burr); NuRV is licensed separately; importing Python source is best effort.
- *Standards*: the tracing does not yet use the OpenTelemetry GenAI span names.
- *Code models*: 15 languages, but only TypeScript is read with a type checker. The other
  languages are read syntactically, so types that come from another file's inference (`var x =
  f()`) are unknown. The extraction is an abstraction:
  conditions on other variables and aliasing are not tracked, and patterns are recognised by
  shape (graded by confidence; declare them to make them contracts). Security, heap and
  memory-safety results come from external tools that must be installed; their proofs are bounded
  and cover C, C++ and Rust only. Replays on the code cover TypeScript and Python classes.

## 5. When to use what

| Need | Use |
| --- | --- |
| Run an agent in production (persistence, retries, scale) | LangGraph, Burr, Temporal, Microsoft Agent Framework |
| Visual statecharts with hierarchy and parallel regions | XState + Stately |
| Filter or shape LLM content | NeMo Guardrails, Invariant, Agent-C / AgentSpec (research) |
| Prove properties of the agent's control flow, and keep them true in code and in operation | ProvenFlow, then export to the runtime of your choice |
| Timed or concurrent protocols | UPPAAL, TLA+ / TLC, SPIN |
| Rich probabilistic models (MDPs, CTMCs) | PRISM, Storm (ProvenFlow exports to them) |

## Sources

All checked on 25 September 2026 unless marked otherwise.

- Analysers ProvenFlow drives (sections 2.8 and 2.9; checked on 27 September 2026, and run on the
  test fixtures: Semgrep 1.178.0, Infer 1.3.0):
  - Semgrep taint mode (interprocedural taint is a Semgrep Pro feature): https://semgrep.dev/docs/writing-rules/data-flow/taint-mode
  - Infer Pulse (manifest and latent issues): https://fbinfer.com/docs/checker-pulse
  - CBMC: https://www.cprover.org/cbmc/ ; ESBMC: https://esbmc.org
  - Kani autoharness (experimental, `-Z autoharness`): https://model-checking.github.io/kani/reference/experimental/autoharness.html
  - CodeQL CLI licence (open-source code and research): https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md
  - GitHub pull request reviews API: https://docs.github.com/en/rest/pulls/reviews
- Code analysis (section 2.8):
  - Infer: https://fbinfer.com/docs/checker-topl , https://fbinfer.com/docs/all-issue-types
  - CodeQL: https://codeql.github.com/docs/codeql-overview/about-codeql/
  - Semgrep: https://docs.semgrep.dev/semgrep-assistant/overview
  - SonarQube: https://www.sonarsource.com/resources/cognitive-complexity/ ; the AI CodeFix
    rules page was not opened
  - ArchUnit: https://www.archunit.org/ ; ArchUnitTS: https://github.com/LukasNiessen/ArchUnitTS
  - dependency-cruiser: https://github.com/sverweij/dependency-cruiser ; Madge: https://github.com/pahen/madge
  - CBMC: https://www.cprover.org/cbmc/ ; JBMC: https://www.cprover.org/jbmc/
  - ESBMC: https://github.com/esbmc/esbmc ; Kani: https://github.com/model-checking/kani
  - CPAchecker: https://github.com/sosy-lab/cpachecker ; Java PathFinder: https://github.com/javapathfinder/jpf-core
  - Kratos2: https://kratos.fbk.eu/
  - Daikon: https://plse.cs.washington.edu/daikon/ ; Synoptic/CSight: https://github.com/ModelInference/synoptic
  - LearnLib: https://learnlib.de/ ; AALpy: https://github.com/DES-Lab/AALpy
  - SpecGen: https://arxiv.org/abs/2401.08807 ; AutoSpec: https://arxiv.org/abs/2404.00762
  - Lemur: https://arxiv.org/abs/2310.04870 ; Clover: https://arxiv.org/abs/2310.17807
  - PyVeritas: https://arxiv.org/abs/2508.08171 ; IC3-Evolve: https://arxiv.org/abs/2604.03232
  - GitHub Copilot code review: https://docs.github.com/copilot/concepts/agents/code-review
- Code review with formal methods (section 2.9, checked 26–27 September 2026):
  - Google Tricorder: https://research.google.com/pubs/archive/43322.pdf ; Error Prone: https://errorprone.info/
  - Amazon CodeGuru Reviewer: https://docs.aws.amazon.com/codeguru/latest/reviewer-ug/welcome.html
  - Copilot Autofix for code scanning: https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/responsible-use-autofix-code-scanning
  - Snyk DeepCode AI Fix: https://snyk.io/blog/ai-code-security-snyk-autofix-deepcode-ai/ ; Semgrep Assistant: https://docs.semgrep.dev/semgrep-assistant/overview
  - Infer at code review: https://6826.csail.mit.edu/2020/papers/facebook-infer-cacm.pdf , https://fbinfer.com/docs/infer-workflow
  - SapFix: https://engineering.fb.com/2018/09/13/developer-tools/finding-and-fixing-software-bugs-automatically-with-sapfix-and-sapienz/
  - Static Driver Verifier: https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/static-driver-verifier
  - s2n-tls CBMC proofs: https://github.com/aws/s2n-tls/tree/main/tests/cbmc ; cbmc-viewer: https://github.com/model-checking/cbmc-viewer
  - Kani GitHub Action: https://github.com/model-checking/kani-github-action ; Certora run action: https://github.com/Certora/certora-run-action
  - P language: https://github.com/p-org/P ; Apalache: https://apalache-mc.org/
  - Modex: https://github.com/nimble-code/Modex ; Bandera: https://bandera.projects.cs.ksu.edu/ ; Java PathFinder: https://github.com/javapathfinder/jpf-core
  - ESBMC-AI: https://arxiv.org/abs/2305.14752 , https://github.com/esbmc/esbmc-ai
  - Dafny specification-guided repair: https://arxiv.org/abs/2507.03659 ; Verifix: https://arxiv.org/abs/2106.16199
  - AWS Zelkova: https://www.amazon.science/publications/semantic-based-automated-reasoning-for-aws-access-policies-using-smt ; Tiros: https://www.amazon.science/publications/reachability-analysis-for-aws-based-networks
  - CodeRabbit: https://docs.coderabbit.ai/tools/

- transitions — https://github.com/pytransitions/transitions ; transitions-gui — https://github.com/pytransitions/transitions-gui
- python-statemachine — https://python-statemachine.readthedocs.io/en/latest/diagram.html , /guards.html
- pydantic-graph — https://pydantic.dev/docs/ai/graph/graph/ ; persistence: https://github.com/pydantic/pydantic-ai/blob/main/docs/graph.md
- LangGraph — https://docs.langchain.com/oss/python/langgraph/persistence , /interrupts ; LangGraph Studio — https://docs.langchain.com/langsmith/studio
- Apache Burr — https://github.com/apache/burr , https://burr.apache.org/
- Stately — https://stately.ai/docs/inspector , https://stately.ai/docs/studio , https://stately.ai/docs/export-as-code
- Temporal — https://docs.temporal.io/workflows , https://docs.temporal.io/encyclopedia/workflow-message-passing
- CrewAI Flows — https://docs.crewai.com/en/concepts/flows
- LlamaIndex Workflows — https://developers.llamaindex.ai/python/framework/understanding/workflows/ , https://developers.llamaindex.ai/python/llamaagents/workflows/drawing/
- Microsoft Agent Framework — https://learn.microsoft.com/en-us/agent-framework/overview/ , /concepts/workflows/ , DevUI: /integrations/by-component/ui/devui/
- Semantic Kernel Process Framework — https://learn.microsoft.com/en-us/semantic-kernel/frameworks/process/process-framework
- AWS Step Functions Workflow Studio — https://docs.aws.amazon.com/step-functions/latest/dg/workflow-studio.html
- nuXmv — https://nuxmv.fbk.eu ; NuRV — https://es-static.fbk.eu/tools/nurv/
- PRISM — https://www.prismmodelchecker.org/ ; Storm — https://www.stormchecker.org/
- RTAMT — https://github.com/nickovic/rtamt ; ipycytoscape — https://github.com/cytoscape/ipycytoscape
- NeMo Guardrails — https://docs.nvidia.com/nemo/guardrails/latest/ ; Invariant — https://github.com/invariantlabs-ai/invariant
- OpenTelemetry GenAI conventions — https://github.com/open-telemetry/semantic-conventions-genai (agent spans: docs/gen-ai/gen-ai-agent-spans.md; tool spans: docs/gen-ai/gen-ai-spans.md)
- Agentproof — https://arxiv.org/abs/2603.20356 ; TraceFix — https://arxiv.org/abs/2605.07935 ; AgentSpec — https://arxiv.org/abs/2503.18666 ; ProbGuard / Pro2Guard — https://arxiv.org/abs/2508.00500 ; Agent-C — https://arxiv.org/abs/2512.23738 ; ShieldAgent — https://arxiv.org/abs/2503.22738 ; Formal-LLM — https://arxiv.org/abs/2402.00798 ; VeriPlan — https://arxiv.org/abs/2502.17898 ; StateFlow — https://arxiv.org/abs/2403.11322
- MAST — https://arxiv.org/abs/2503.13657 (percentages from https://arxiv.org/html/2503.13657 and https://arxiv.org/html/2503.13657v2)
- Replit incident — https://incidentdatabase.ai/cite/1152/
- EU AI Act, Article 14 — https://artificialintelligenceact.eu/article/14/
- Anthropic, Building effective agents — https://www.anthropic.com/engineering/building-effective-agents
- 12-factor agents, factor 8 — https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md
- Not verified in this survey: SPIN (https://spinroot.com), UPPAAL (https://uppaal.org), TLA+ (https://lamport.azurewebsites.net/tla/tla.html), Apalache (https://apalache-mc.org), n8n, Langflow, Dify, Flowise, Guardrails AI.
