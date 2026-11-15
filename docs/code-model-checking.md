# Model-checking a code base: `pflow extract`

ProvenFlow's diagrams are models someone draws. `pflow extract` builds them from existing code
instead: the state machines hidden in its fields, the lifecycles of the resources it holds, the
contracts of the design patterns it uses, and the dependencies between its layers. nuXmv then
checks every model. A problem is reported with:
- the code path that shows it (the counterexample, written as the calls that lead there, with
  file and line);
- a concrete fix;
- when an LLM is enabled, a patch that the tool re-checks before calling it verified.

It reads TypeScript/JavaScript (with Angular templates), Python, Java, Kotlin, Groovy, Scala, C,
C++, C#, Go, Rust, Swift, Ruby, PHP and R.

It also checks what AI-generated code most often gets wrong while still compiling and passing its
tests:
- duplicated code, including a function that re-implements one the project already has;
- complexity (Cognitive Complexity and nesting, with each language's limits);
- naming that drifts from the project's conventions;
- imports of packages that are neither declared nor installed (hallucinated dependencies);
- changed lines no test runs, or that no test checks (mutation testing).

On a pull request it reports only what the change adds: against the base revision's analysis, and
against a baseline of accepted findings. Coding agents can run the same checks before they push,
through an MCP server or Claude Code hooks.

The use it was built for is **checking code written by AI assistants**. That code compiles and
passes its tests, yet it can still:
- forget a state in a switch;
- write a status after an `await` without re-checking it;
- start a timer twice;
- construct a singleton with `new`;
- import the UI from the core.

Linters see single lines, and tests see the paths someone thought of. A model checker explores
every order in which the methods can be called.
How this compares with static analysers, software model checkers, specification mining and LLM
code review is in [the state of the art, section 2.8](state-of-the-art.md#28-checking-a-code-base-static-analysis-software-model-checking-specification-mining-llm-review).

- [Quick start](#quick-start)
- [Run it on ProvenFlow yourself](#run-it-on-provenflow-yourself)
- [Languages](#languages)
- [What is extracted and checked](#what-is-extracted-and-checked)
- [Code quality: duplication, complexity, naming, dependencies, tests](#code-quality-duplication-complexity-naming-dependencies-tests)
- [How it works](#how-it-works)
- [What the results mean (soundness)](#what-the-results-mean-soundness)
- [provenflow.config.json](#provenflowconfigjson)
- [Code changes: quick fixes, review, apply](#code-changes-quick-fixes-review-apply)
- [LLM assistance, verified](#llm-assistance-verified)
- [Outputs and CI](#outputs-and-ci)
- [Gating what is new: baseline and new-only](#gating-what-is-new-baseline-and-new-only)
- [Coding agents: MCP server, hooks, setup steps](#coding-agents-mcp-server-hooks-setup-steps)
- [Other CI systems](#other-ci-systems)
- [Comparing two versions: pflow compare](#comparing-two-versions-pflow-compare)
- [pflow init: a config from the code](#pflow-init-a-config-from-the-code)
- [ProvenFlow checked by ProvenFlow](#provenflow-checked-by-provenflow)
- [Limits as a CI gate](#limits-as-a-ci-gate)

## Quick start

**In the editor.** Choose File → Import code base…; after the analysis the window becomes the
**Code base review**. Choose the folder in one of two ways:
- **Choose folder…:** the browser reads the sources, `package.json` and `provenflow.config.json`,
  and sends them to the ProvenFlow server for the analysis. They are deleted afterwards.
  `node_modules` is not sent, so types from libraries are only partly known.
  - In Chrome and Edge, allow editing when asked: the browser writes the changes you apply
    (File System Access API).
  - Other browsers can only upload a read-only copy.
- **Type a folder path:** the folder is read in place, with its `node_modules`, which is more
  precise. This is available when the server is bound to localhost, which is the default;
  `PROVENFLOW_EXTRACT_PATHS=0` turns it off.

The dialog then shows:
- the findings by category, with their fix and counterexample;
- the models, the patterns found, and the paradigm profile with the dependencies.

**Open model** opens a model in a new tab and checks it: the false property's Counterexample
button replays the run on the diagram. Each model keeps its own tab with its results. The
**Code report** button next to the tabs (or File → Code base report…) reopens the findings and the
list of models without importing again; the browser keeps both across reloads.
**Download report** saves `report.md`.

**From a terminal:**

```sh
npm install && npm run build
# nuXmv checks every property; without NUXMV_PATH an explicit-state checker covers the standard ones
NUXMV_PATH=/path/to/nuXmv npx pflow extract path/to/project
```

```
src/core/order.ts:8: error [property-violated] Order.status violates the property declared in
  provenflow.config.json: AG (state = 'cancelled' -> AG state != 'shipped')
  Counterexample: draft, Order.cancel -> cancelled, Order.pay -> paid, Order.ship -> shipped.
    fix: Follow the counterexample: the transition that breaks the property is the code to change.
src/core/order.ts:18: warning [stale-write-after-await] Order.pay sets Order.status to paid after
  an await, relying on a check made before it; other code (Order.submit, Order.cancel, Order.ship)
  can change Order.status meanwhile.
    fix: Re-check the state after the await before writing, e.g. `if (status !== 'submitted') return;`
src/ui/widgets.ts:7: warning [resource-leak] Poller can lose the interval held in this.timer ...
  Counterexample: idle, Poller.start -> held, Poller.start -> leaked.
...
10 files, 10 models, 31 properties (nuXmv): 5 error(s), 18 warning(s), 4 note(s).
Report: .provenflow/extract/report.md
```

(From the test fixture `packages/extract/test/fixtures/shop`, a small project with one bug of
each kind.)

The report folder also contains:
- the models as `.pflow` files: open one in the editor to see the diagram, check it and replay a
  counterexample;
- `report.sarif`, for GitHub code scanning;
- a test skeleton for each counterexample, to confirm the bug on the real code.

## Run it on ProvenFlow yourself

ProvenFlow ships its own `provenflow.config.json`, so it can check its own code in one command:

```sh
cd provenflow
npm install && npm run build
export NUXMV_PATH=/path/to/nuXmv      # optional: without it, the explicit-state checker is used
npm run check:code                     # = pflow extract . --fail-on warning
```

What you should see:
- about 160 files and 25 models (state machines of the Angular app, resource lifecycles, singleton
  contracts, the layer graph), and about 80 properties checked;
- about 130 warnings and 50 notes, nearly all of them functions over their language's complexity
  limit, mostly in the language front ends;
- `Baseline: 177 finding(s) accepted, 0 new.` and exit code 0. The repository's
  `provenflow-baseline.json` accepts today's findings; any new one fails.

The **Code quality** section of report.md lists the most complex functions; `pflow compare . --base
<ref>` shows how a change moves the measures.

In the editor, the same check is File → Import code base… with the path of your clone
(e.g. `/Users/me/git/provenflow`).

Then look at the results:
- **Read the report:** `open .provenflow/extract/report.md`.
- **See a model as a diagram:** run `npm start`, open http://localhost:3000, choose File → Open
  .pflow…, and pick for example `.provenflow/extract/models/machine-App.tab.pflow` or
  `lifecycle-TracePanel-interval-timer.pflow`. Then ▶ Check.
- **Make it fail:** break a rule and run it again. For example, import `@provenflow/server` from
  `packages/language/src/index.ts` (a layer violation). Or remove `this.disconnect();` at the
  start of `LiveLink.connect` in `packages/app/src/app/live-link.ts`: that is an EventSource leak,
  and the counterexample is `connect, connect`. The command exits with code 5 and names the file,
  the line and a fix.
- **With an LLM:** add `-- --llm anthropic:claude-sonnet-5 --llm-fixes 3` (with
  `ANTHROPIC_API_KEY` set), or `-- --llm ollama:<model>` for a local model. The report then shows
  the proposed patches, each marked verified or not.

The same command, `npx pflow extract <dir>`, works on any TypeScript/Python project. Without a
config it extracts and checks everything that needs no declared intent.

## Languages

| language | files | parsed with | state variables | resources tracked | singletons |
| --- | --- | --- | --- | --- | --- |
| TypeScript / JavaScript | `.ts` `.tsx` `.mts` `.cts` | TypeScript compiler + type checker | fields/variables typed as a union of string literals or an enum, `signal<T>`, `BehaviorSubject<T>`; Angular templates included | timers, listeners on window/document/process, EventSource/WebSocket, observers, RxJS subscriptions, child processes, temp dirs, Cytoscape | `@Injectable({ providedIn: 'root' })`, private constructor + static instance |
| Python | `.py` | Python's `ast` (python3 ≥ 3.10) | attributes set to `Enum` members, `Literal[...]` annotations, `status`/`state`-like attributes set to strings | `open()` outside `with`, temp dirs, `Popen`, locks, subscriptions | `__new__` |
| Java | `.java` | tree-sitter (v0.23.5) | fields typed with an `enum` | `FileReader`/streams/`Socket` (outside try-with-resources), locks, executors, timers, listeners | private constructor + static instance |
| Kotlin | `.kt` `.kts` | tree-sitter | properties typed or initialised with an `enum class` | readers/streams (outside `.use {}`), locks, timers/jobs | `object` |
| Groovy | `.groovy` `.gradle` | tree-sitter (optional semicolons added, lines kept) | fields typed with an `enum` | as Java | `@Singleton` |
| Scala | `.scala` `.sc` | tree-sitter (v0.26.2) | fields typed with a Scala 3 `enum` or a `sealed trait` of `case object`s | `Source.fromFile`, streams | `object` |
| C | `.c` `.h` | tree-sitter | globals and struct fields typed with an `enum` (also `typedef enum {...} name_t`) | `malloc`/`free`, `fopen`/`fclose`, sockets, `pthread_mutex_lock` | — |
| C++ | `.cpp` `.cc` `.hpp` … (`.h` when the project has C++) | tree-sitter | members typed with an `enum`/`enum class` | `new`/`delete`, `malloc`/`free`, `fopen`, `lock()`/`unlock()` | private constructor + static `instance()` |
| C# | `.cs` | tree-sitter | fields/properties typed with an `enum` | streams (outside `using`), `Timer`, `CancellationTokenSource`, `Monitor` | private constructor + static instance |
| Go | `.go` | tree-sitter | struct fields typed with a named type whose values are typed constants (`const ( Idle State = iota ... )`) | `os.Open`/`net.Dial` (without `defer Close`), mutexes, tickers/timers, `context.WithCancel` | `sync.Once` + package instance |
| Rust | `.rs` | tree-sitter | struct fields typed with an `enum` (writes in `impl` blocks, `Job { state: ... }` literals) | explicit leaks only (`Box::leak`, `mem::forget`, `into_raw`): ownership frees the rest | `OnceLock`/`OnceCell`/`Lazy`/`lazy_static!` |
| Swift | `.swift` | tree-sitter | properties typed or initialised with an `enum` (`.idle`) | `Timer.scheduledTimer`, `addObserver`, file handles | `static let shared` |
| Ruby | `.rb` | tree-sitter | `@state`-like instance variables set to symbols/strings (values from assignments and `case`/`when`) | `File.open` without a block, sockets, mutexes | `include Singleton` |
| PHP | `.php` | tree-sitter | properties typed with a PHP 8.1 `enum` | `fopen`/`fclose`, `curl_init`, `flock` | private `__construct` + static instance |
| R | `.R` `.r` | tree-sitter (r-lib v1.3.0) | R6 / Reference class fields set to strings (`self$state <- "running"`, `switch(self$state, ...)`) | `file()`/`url()`/`dbConnect()` without `on.exit(close(...))`, `sink`, graphics devices | — |

What is the same for every language:
- conditions (`if`/`else`, `unless`, `guard`, early returns), `switch`/`when`/`match`/`case`/`switch()`
  labels, and earlier writes in the same function give the states a write can happen in;
- class and method shape feeds the design-pattern checks: fluent `return this`/`self`, forwarding,
  "not implemented" bodies, observer collections;
- functions feed the paradigm rules: argument mutation, outer writes, effects, lambdas;
- imports feed the architecture checks. Java/Kotlin/Groovy/Scala package paths, C/C++
  `#include "..."`, Rust `use crate::`/`mod`, Go import paths, Ruby `require_relative`, PHP
  namespaces and R `source()` are resolved to project files.

In languages without exceptions (C, Go), a release is "not guaranteed" only when an early
`return` can skip it. The failure check right after the acquisition (`if (p == NULL) return`,
`if err != nil { return }`) is not counted.

Limits:
- **Types.** Only TypeScript is read with a type checker. In the other languages a field's type is
  what is written in its declaration, or the enum its values belong to. A field whose type is
  inferred from a function call is not recognised.
- **Grammars.** Grammars are best effort for very new syntax. For example, Kotlin's grammar comes
  from `tree-sitter-wasms` 0.1.13. Syntax errors stay local to the construct that has them.

## What is extracted and checked

See [Languages](#languages) for how each of the 15 languages is read.

### State machines

Any field or variable typed as a finite set of values becomes a machine. That includes:
- a union of string literals or an enum;
- an Angular `signal<Phase>` or an RxJS `BehaviorSubject<Phase>`;
- a Python `Enum` or `Literal[...]`, or a `status`/`state`/`phase`-like attribute set to string
  literals;
- a property of an interface when its name is state-like (`status`, `state`, `phase`, `mode`...).

Machines declared with XState, LangGraph, CrewAI Flows or python-transitions are read too.

| rule | severity | checked by |
| --- | --- | --- |
| `unreachable-state`: a declared value is never set (and code comparing against it is dead) | warning | nuXmv `EF state = v` |
| `cannot-settle`: from some state the machine never gets back to its initial or final states | warning | nuXmv `AG EF (initial \| final)` |
| `stuck-state`: a reachable state no code leaves, that does not look final | warning | model graph |
| `unhandled-state`: a `switch`/`match` over the variable misses values and has no default | warning | analysis |
| `stale-write-after-await`: a write after an `await` relies on a check made before it, while other methods write the variable | warning | analysis |
| `property-violated`: a property declared in the config is false | error | nuXmv |

### Resource lifecycles (typestate)

These resources are tracked, per owning class:
- timers (`setInterval`, and `setTimeout` kept in a field);
- listeners on `window`, `document` or `process`;
- `EventSource`/`WebSocket`, observers and Cytoscape instances;
- RxJS subscriptions;
- child processes, temporary directories, files and locks.

Each one gets a model with the states `idle`, `held`, `leaked` and `disposed`. Its events are the
class's public methods and dispose hooks (`ngOnDestroy`, `DestroyRef.onDestroy`, `dispose`,
`close`...), followed through the private methods they call.

| rule | severity | checked by |
| --- | --- | --- |
| `resource-leak`: the resource can be lost, i.e. acquired again while held, or held when the object is disposed or dropped | warning | nuXmv `INVARSPEC !(state = leaked)` |
| `release-not-guaranteed`: a function releases a temp dir, file or lock only on the normal path | warning | analysis (release outside `finally`/`with`) |
| `unremovable-listener`: an inline listener on a global target, which can never be removed | warning | analysis |

### Design patterns

Patterns are recognised from the code's shape. Where a pattern has behaviour, the tool builds a
contract model for nuXmv to check.

| pattern | recognised by | checked | rule |
| --- | --- | --- | --- |
| Singleton | `@Injectable({ providedIn: 'root' })`, private constructor + static instance, Python `__new__` | never two instances (model: `none/one/many`); no `new` outside tests | `singleton-bypassed` |
| Observer | a method adds its parameter to a collection, another calls each element | an observer can always detach: `AG (attached -> EF detached)` | `observer-cannot-unsubscribe` |
| Builder | 3+ fluent methods returning `this`, plus `build()` | never builds unconfigured, unless `build()` validates | `builder-builds-unconfigured` |
| State | classes of one interface returning each other's instances | every state class is reachable | `unreachable-state` |
| Strategy | 2+ implementations of an interface or abstract class; function types | no implementation only throws (Liskov) | `strategy-not-implemented` |
| Adapter / Decorator | implements an interface and forwards most methods to a field | no forwarded method only throws | `adapter-incomplete` |
| Command | implementations with `execute()` | all can be undone if some can | `command-missing-undo` |
| Factory | `create*`/`make*`/`from*` returning new instances | products share a supertype | `factory-products-unrelated` |
| Facade | a package's entry module | other packages import only through it | `facade-bypassed` |
| Dispatch | a `switch` over a union (command kinds, strategy keys, message types) | every kind handled or an explicit default | `non-exhaustive-dispatch` |

A pattern declared in the config but not found is an error (`pattern-expected`), and the report
explains how to implement it. A comment just above a class declares it too:

```ts
// @pattern builder          (or: provenflow: pattern builder)
export class QueryBuilder { ... }
```

Each pattern found is graded by how it was recognised (the *recognised* column of Patterns):

| confidence | when | findings on it |
| --- | --- | --- |
| declared | in `patterns` of the config, or an `@pattern` comment | warnings and errors |
| structural | types or language constructs say so: `providedIn`, a private constructor, `implements`, a subscribe/notify pair over one collection | warnings and errors |
| heuristic | names and shapes only (builders, factories, commands, adapters, decorators) | notes, saying how to declare the pattern |

### Architecture

Imports are resolved by the TypeScript compiler, or by module paths for Python. They are grouped
by the layers of the config (by default, by top-level package).

- **`layer-violation`** (error): a layer imports one it may not use. Every offending import is
  listed.
- **`layer-cycle`** (error): a layer depends on itself through others. This is proved by nuXmv on
  the layer graph (`AG (state = L -> AX !EF state = L)`), and the counterexample is the import
  chain.
- **`import-cycle`** (warning): files importing each other in a cycle. Type-only imports don't
  count.
- **`facade-bypassed`** (warning): a deep import into another package, instead of its entry.

### Paradigm

Each layer gets a profile, reported whether or not a style is declared:
- how object-oriented or functional it is (methods against free functions);
- pure and higher-order functions;
- mutations per 100 lines;
- mutable globals;
- inheritance depth.

When the config declares a layer's style, these rules apply:

- **functional:**
  - `fp-mutates-argument`: an exported function changes its input;
  - `fp-writes-outer-state`;
  - `fp-mutable-global`;
  - `fp-class`: a class with mutable fields. Immutable classes are values and are allowed.
- **object-oriented:**
  - `oop-mutable-global`: state outside any object;
  - `oop-mutates-foreign-object`: "tell, don't ask".
- **all styles:**
  - `god-class`;
  - `deep-inheritance`;
  - `long-function` (note);
  - `many-parameters` (note).

### Security, heap and memory safety: the analysers ProvenFlow drives

ProvenFlow does not re-implement dataflow, heap or bounded model checking of code. It runs the
established tools when they are installed (found on `PATH`, or with `SEMGREP_PATH`, `INFER_PATH`,
`ESBMC_PATH`, `CBMC_PATH`, `CODEQL_PATH`), and their findings go into the same report, review,
fix and CI loop. Without them, a note says what installing each would add.

| analyser | install | languages | finds | rule prefix |
| --- | --- | --- | --- | --- |
| Semgrep, with the rules bundled in `packages/extract/rules/semgrep` | `pip install semgrep` | JS/TS, Python, Java, Go, C | taint from requests to `exec`, `eval`, SQL, file paths, `fetch`; XSS through `innerHTML`; unsafe YAML/pickle; disabled TLS checks; hard-coded secrets; `gets`, `strcpy`, format strings | `semgrep:` (category *security*) |
| CodeQL (opt-in: `"analyzers": { "codeql": true }`) | the CodeQL CLI | the languages CodeQL supports | the standard security queries, with data-flow paths | `codeql:` |
| Infer | a release from github.com/facebook/infer | C, C++, Objective-C, Java | null dereferences, leaks and other bugs *across calls* (Pulse), with the trace | `infer:` (category *heap*) |
| ESBMC or CBMC | esbmc.org, or the CBMC `.deb`/Homebrew | C, C++ | every free function, for every input: invalid pointers, array bounds, leaks, signed overflow, division by zero; loops unwound 8 times | `esbmc:` / `cbmc:` (category *memory*) |
| Kani | `cargo install --locked kani-verifier && cargo kani setup` | Rust | `cargo kani autoharness`: panics, overflows, memory safety of each function it can generate inputs for | `kani:` |
| any tool with SARIF output | | | `"analyzers": { "sarif": ["reports/eslint.sarif"] }` imports it | `sarif:` |

The model checkers of code also produce **proofs**: the *Tools & proofs* tab (and "Proofs about
the code" in report.md) lists each function as *proved* (no failure up to the bound), *refuted*
(a finding, with the failing trace as counterexample) or *unknown* (timeout, or code the tool
could not parse). A proof is bounded: it covers loops up to the unwinding bound and says nothing
about callers' preconditions, so `int first(int *v) { return v[0]; }` is refuted (a caller could
pass `NULL`) even if no caller does.

Semgrep's autofixes (`innerHTML` → `textContent`, `yaml.load` → `yaml.safe_load`, `verify=False`
→ `verify=True`, `gets` → `fgets`) become proposed changes, verified like quick fixes.

```json
"analyzers": {
  "semgrep": { "config": ["p/owasp-top-ten"] },
  "infer": { "build": "mvn -q compile" },
  "bmc": { "tool": "cbmc", "unwind": 12, "timeoutSec": 60, "maxFunctions": 100 },
  "kani": false,
  "codeql": true
}
```

Each is on when its tool is installed (except CodeQL, which is slow); `false` turns it off, and
`--no-analyzers` skips them all for one run.

### Installing the analysers

None of them is needed: without them ProvenFlow still extracts and checks its models, and the
*Tools & proofs* tab lists what each missing tool would add. Install the ones that match your
languages and what you want checked:

| install it if you want | tool | languages |
| --- | --- | --- |
| security and dataflow problems: injection (command, code, SQL), path traversal, SSRF, XSS, unsafe deserialisation, disabled TLS checks, hard-coded secrets, unsafe C string functions, with verified fixes for some | **Semgrep** | JS/TS, Python, Java, Go, C (the bundled rules); many more with registry rules |
| bugs that go through several functions: null dereferences, memory and resource leaks | **Infer** | C, C++, Objective-C, Java |
| proofs that C/C++ functions are memory safe for every input: no invalid pointer, out-of-bounds access, leak, signed overflow or division by zero (up to a loop bound); also confirms ProvenFlow's state-machine findings on C code | **ESBMC** or **CBMC** (one is enough; ESBMC is tried first) | C, C++ |
| the same for Rust: panics, overflows, memory safety | **Kani** | Rust |
| GitHub's security queries, with deeper data flow across files (slow, so opt-in; its CLI is free for open-source code and research) | **CodeQL** | most languages |

**macOS** (Homebrew):

```sh
brew install semgrep cbmc esbmc          # Semgrep, CBMC and ESBMC
brew install --cask codeql               # optional, then "analyzers": { "codeql": true }

# Infer: no Homebrew formula; Apple silicon only (on Intel Macs, use Docker or build it)
curl -fsSL https://github.com/facebook/infer/releases/download/v1.3.0/infer-osx-arm64-v1.3.0.tar.xz | tar -xJ -C ~/.local
export INFER_PATH=~/.local/infer-osx-arm64-v1.3.0/bin/infer    # or add its bin/ to PATH
```

**Linux** (Ubuntu/Debian, x86-64):

```sh
python3 -m pip install --user semgrep    # or: pipx install semgrep

# CBMC: the .deb of your Ubuntu release (22.04, 24.04, 24.04-arm64) from github.com/diffblue/cbmc/releases
curl -fsSLO https://github.com/diffblue/cbmc/releases/download/cbmc-6.11.0/ubuntu-24.04-cbmc-6.11.0-Linux.deb
sudo apt-get install ./ubuntu-24.04-cbmc-6.11.0-Linux.deb

# ESBMC (instead of, or besides, CBMC): unzip esbmc-linux.zip from github.com/esbmc/esbmc/releases
# and set ESBMC_PATH to its bin/esbmc

curl -fsSL https://github.com/facebook/infer/releases/download/v1.3.0/infer-linux-x86_64-v1.3.0.tar.xz | sudo tar -xJ -C /opt
export INFER_PATH=/opt/infer-linux-x86_64-v1.3.0/bin/infer
```

**Windows:** `pip install semgrep`; CBMC has an installer (`cbmc-*-win64.msi`) and ESBMC a zip
(`esbmc-windows.zip`) on their release pages. Infer has no Windows build: run it in WSL with the
Linux instructions.

**Rust (Kani)**, any system with Rust (`rustup`):

```sh
cargo install --locked kani-verifier && cargo kani setup
```

**How ProvenFlow finds them.** On the `PATH` of the ProvenFlow server (or of `pflow`), or at the
path in `SEMGREP_PATH`, `INFER_PATH`, `ESBMC_PATH`, `CBMC_PATH`, `CODEQL_PATH` or `KANI_PATH`.
Set these where the server starts, for example:

```sh
SEMGREP_PATH=$(which semgrep) CBMC_PATH=$(which cbmc) npm start
```

Then run the analysis again: **Tools & proofs** lists each tool that ran, with its version, and
the proofs; the tools still missing are listed under *Not installed*. In CI, the ProvenFlow GitHub
Action installs Semgrep (and CBMC with `cbmc: 'true'`); see `.github/workflows/ci.yml` for Infer.

**What each costs.** Semgrep takes seconds. Infer compiles the C/Java files it analyses (with
`clang` or `javac`; set `"infer": { "build": "mvn -q compile" }` when the files need the project's
build), so allow a minute on large projects. ESBMC/CBMC check each C/C++ function separately (up
to 60 by default, 30 s each at most, four at a time); raise `unwind` for deeper loops, lower
`maxFunctions` to go faster. CodeQL builds a database of the project first: minutes, which is
why it is off by default.

### Confirmed on the code

A model finding is about the model. Where it can, ProvenFlow checks it on the real code, and the
finding says **✓ confirmed on the code**, **✗ not reproduced** or nothing:

| finding | how it is checked | languages |
| --- | --- | --- |
| a state-machine counterexample (`never-reaches`, `cannot-settle`, ...) | the calls of the counterexample are made on a real instance of the class (its dependencies replaced by permissive mocks), and the state read after each | TypeScript (run with tsx), Python (`unittest.mock`) |
| `stale-write-after-await` | the async method is started, the other writer called while it awaits, then it is let finish: the write that was lost is named | TypeScript, Python |
| `resource-leak` of a timer | the acquiring method is called twice and the running timers counted | TypeScript |
| `unreachable-state` of a C state variable | ESBMC/CBMC run a generated harness calling the file's functions in any order, 6 calls deep, and assert the value is never reached: *proved* confirms the finding, a trace refutes it (the model missed a transition) | C |

The replay runs the project's code, with timers and I/O mocked, in a child process with a
timeout; turn it off with `--no-confirm`.

## Code quality: duplication, complexity, naming, dependencies, tests

These checks need no declared intent; their defaults come from each language's style guide and main
linter ([coding-standards.md](coding-standards.md)). Test files and generated files (marked
`@generated`, "do not edit"...) are left out.

### Duplicated code

| rule | severity | how |
| --- | --- | --- |
| `duplicated-code` | warning | The same token sequence in two places, with identifiers and numbers normalised (copies that differ only in names: Type-1 and Type-2 clones). Windows of tokens are hashed (Rabin-Karp) and grown to the largest match, as PMD CPD and jscpd do. Default: 100 tokens over 10 lines (SonarQube's thresholds). Strings stay as written, so lines that differ only in their text (messages, tables) are not copies; a run that only repeats a short pattern is not reported. |
| `similar-function` | warning | Two functions sharing 80% or more of their tokens (SourcererCC's measure, Type-3): the usual sign of a helper written again instead of reused, which coding agents do almost twice as often as people (MSR 2026). |

Each finding names the other copy and how to reuse it. When the layer rules do not allow importing
it, the fix says to move the shared code to a layer both may import.

```json
"duplication": { "minTokens": 100, "minLines": 10, "similarity": 0.8, "minFunctionTokens": 50, "tests": false }
```

### Complexity

Every front end measures each function: **Cognitive Complexity** (SonarSource whitepaper v1.7: +1
for each break in linear flow, `if`, `else if`, `else`, loops, `catch`, `switch`, `?:`, sequences of
`&&`/`||`, labelled jumps, recursion; plus the nesting level for nested structures), **cyclomatic
complexity**, and the deepest **nesting** of control structures.
- The TypeScript and Python front ends measure it on their own syntax trees.
- The tree-sitter languages measure it from node types the grammars name alike (`if_statement`,
  `for_statement`, `catch_clause`, `match_expression`...).
- An anonymous callback adds to the function it is in; a named inner function is measured on its
  own.

| rule | severity | default limit |
| --- | --- | --- |
| `cognitive-complexity` | warning | 15 (25 for C and C++, as clang-tidy and Sonar; per language in [coding-standards.md](coding-standards.md)) |
| `deep-nesting` | warning | 4 (3 to 5 by language) |

Both findings carry their measure. On a pull request, a function already over the limit fails only
if the change makes it worse ("Raised from 18 by this change").

```json
"complexity": { "cognitive": 15, "nesting": 4 },
"languages": { "python": { "complexity": { "cognitive": 12 } } }
```

### Naming conventions

Class, function, method and field names are compared with the style expected for their language
and kind of name. The expected style is, in order:
1. the config (`languages.<language>.naming`);
2. the project's own convention, when at least 80% of 8 or more names agree;
3. the language's style guide.

`naming-convention` findings are notes, with the name rewritten in the expected style (`parse_order_line`
→ `parseOrderLine`). The conventions applied are listed in report.md.

### Dependencies

| rule | severity | when |
| --- | --- | --- |
| `unknown-dependency` | error (warning when the project declares no dependencies at all) | A file imports a package that is neither declared nor installed: the import fails, and the name may have been invented. LLMs suggest packages that do not exist, and attackers register those names ("slopsquatting"). |
| `undeclared-dependency` | warning | Installed but not declared: it only works because another dependency brings it in. |

What is read for each language:
- **TypeScript/JavaScript:** every `package.json` from the file's folder up, with workspace packages,
  `tsconfig` path aliases, ambient `declare module` and Node built-ins.
- **Python:** `requirements*.txt`, `pyproject.toml` (PEP 621 and Poetry), `setup.cfg`/`setup.py` and
  `Pipfile`; the standard library and what is installed come from `python3`.
- **Go:** `go.mod`.

### Tests and coverage

ProvenFlow reads the coverage reports of the project's own test run: LCOV (Jest, Vitest, c8, nyc,
gcov, cargo-llvm-cov), Cobertura XML (coverage.py, pytest-cov, gcovr, coverlet) and JaCoCo XML.
Their paths are matched to the project's files, including absolute paths from another machine.

```json
"coverage": { "reports": ["coverage/lcov.info"], "severity": "warning" }
```

or `--coverage coverage/lcov.info` (repeatable).

| rule | severity | when |
| --- | --- | --- |
| `uncovered-change` | warning (configurable) | In a review: changed lines no test runs, grouped by function. |
| `change-without-test` | info (warning on agent-written lines) | In a review without a coverage report: functions changed by 3 lines or more, and no test file changed. |
| `untested-complex-function` | info | A function above half its complexity limit that no test runs at all. |
| `mutant-survived` | warning | With `--mutate N` or `pflow mutate`: a changed line was altered (see below) and every test still passed, so no test checks what it does. |

**Mutation testing of the changed lines** works as at Google (*Practical Mutation Testing at
Scale*):
- at most one mutant per changed line, and a cap per run (20 by default);
- lines with findings or without coverage first;
- no mutant on arid lines: logging, imports, comments, braces.

A mutant negates an equality, moves a boundary (`<` to `<=`), swaps `&&` and `||`, flips a boolean,
swaps `+` and `-`, or removes a negation. Text in strings and comments is never changed. Each mutant
runs the project's tests on a temporary copy, and the tests must pass on the unchanged code first.

```sh
pflow mutate . --base origin/main --max 20          # or: pflow review . --base origin/main --mutate 20
```

## How it works

```
source ──► facts (TypeScript checker · Python ast) ──► models ──► nuXmv ──► findings ──► report
                                                          ▲                   │
                                         provenflow.config.json        optional LLM: resolve,
                                                                        suggest, patch → re-check
```

1. **Facts.** The TypeScript front end builds one program over the project, so the type checker
   knows the type of every expression. That is how `this.status.set(x)` is recognised as a write
   of a `WritableSignal<'idle' | 'running'>`. Angular templates are included: each event handler
   and binding (`(click)="tab.set('model')"`, `@if (tab() === 'model')`) becomes a method of its
   component, and its facts are reported at the template's line. The Python front end runs
   `python3` on the files. Both produce the same facts (`packages/extract/src/ir.ts`), so every
   analysis after that is language-independent.
2. **From which states does a write happen?** From the conditions around it: `if`, ternaries, `&&`
   and `||`, `case` labels (including fall-through), `includes` on literal arrays, and early
   returns (`if (status !== 'draft') return;`). Earlier writes in the same function count too
   (`status = 'loading'; … status = 'done'`), and so does `try`/`catch` (the try block may have run
   partly). Without any of these, the write can happen in any state.
3. **Computed values.** When a function writes one of its parameters (`this.state = to`), the
   values come from the literal arguments at every call site. Any value still unknown leaves the
   write out of the model, is listed in the model's notes, and lowers the severity of that
   machine's reachability findings to notes. It is also what the LLM step is asked about.
4. **`await`.** A write that follows an `await` without re-checking the state is modelled as
   possible from any state when other methods also write the variable: that is what can really
   happen. It is also reported as `stale-write-after-await`.
5. **Models and properties.** Every model is an ordinary ProvenFlow diagram, run through the same
   nuXmv generator as a drawn one. Every property records the finding it stands for.
6. **Verification.** nuXmv checks the models. Each false property becomes a finding, and its trace
   is replayed as code events ("Poller.start → held, Poller.start → leaked", with the file and
   line of each step). Without nuXmv, an explicit-state checker decides the standard properties.
   Properties from the config or the LLM are then reported as not checked.

## What the results mean (soundness)

A model is an **abstraction** of the code: conditions the tool cannot read (on other variables,
on data) are dropped, so the model can do more than the code.

- **A property proved by nuXmv** ("never leaked", "no layer cycle") holds for every run of the
  model. It holds for the code too, *as far as the model captures it*. What it does not capture:
  - writes through aliases or reflection;
  - state changed by code outside the project;
  - computed values that stay unresolved (listed in the model's notes).
- **A counterexample** is a run of the model. The code may not allow it, because of a condition on
  another variable. That is why each counterexample comes with a test skeleton in `scenarios/`:
  - replay the calls on the real code;
  - if the expectation fails, the bug is real;
  - if it passes, add the missing guard to the config (a terminal state, or a property that uses
    it) and the finding goes away.
- **Patterns** are recognised by their shape, so a class can be misread. Declare the patterns you
  intend in the config: then they are checked, not guessed.
- **Structural and paradigm rules** are heuristics with thresholds. Record accepted exceptions,
  with the reason, in `ignore`.

## provenflow.config.json

Everything is optional. Without a config you still get the machines, lifecycles, patterns,
cycles and paradigm profiles.

```json
{
  "include": ["src/**"],
  "exclude": ["**/test/fixtures/**"],
  "layers": [
    { "name": "core", "paths": ["src/core/**"], "mayImport": [], "style": "functional" },
    { "name": "ui", "paths": ["src/ui/**"], "mayImport": ["core"], "style": "object-oriented" }
  ],
  "packageEntries": true,
  "patterns": [{ "subject": "Session", "pattern": "singleton" }],
  "machines": {
    "Order.status": {
      "terminal": ["shipped", "cancelled"],
      "specs": ["AG (state = 'cancelled' -> AG state != 'shipped')"]
    }
  },
  "ignore": [{ "rule": "fp-class", "subject": "Parser", "reason": "Compiler visitor, never shared." }],
  "limits": { "classMethods": 30, "classLines": 600, "functionLines": 80, "inheritanceDepth": 3, "functionParams": 6 },
  "languages": {
    "typescript": {
      "limits": { "functionLines": 50, "functionParams": 7 },
      "complexity": { "cognitive": 15, "nesting": 4 },
      "naming": { "class": "PascalCase", "function": "camelCase", "method": "camelCase", "field": "camelCase" }
    }
  },
  "duplication": { "minTokens": 100, "minLines": 10, "similarity": 0.8 },
  "coverage": { "reports": ["coverage/lcov.info"] },
  "mutation": { "test": "npm test", "max": 20 },
  "baseline": "provenflow-baseline.json",
  "agents": { "failOn": "warning", "requireTests": true }
}
```

- `machines[name].specs` are LTL or CTL properties over `state`. Values can be written as in the
  code (`state = 'no-machine'`) or as model ids.
- `terminal` lists the states in which the machine may rest. It replaces the naming heuristic
  (`done`, `failed`, `idle`...) for "can settle" and "stuck".
- `patterns[].pattern` is one of `singleton`, `observer`, `factory`, `strategy`, `builder`,
  `adapter`, `decorator`, `state`, `command` and `facade`.
- `ignore` entries match on `rule`, and optionally on `subject` and on a `file` glob. Give a
  `reason`: the file then documents the design decisions.
- `languages` holds the coding standards of each language: size limits, complexity limits and
  naming. They take precedence over the project-wide `limits`, `complexity` and `naming`.
  `pflow init` writes them from [coding-standards.md](coding-standards.md).
- `duplication`, `complexity` and `naming` set or turn off (`false`) those checks; `dependencies:
  false` turns off the dependency check.
- `coverage.reports` lists the coverage reports to read; `mutation` sets the test command and the
  number of mutants.
- `baseline` is the file of accepted findings (default `provenflow-baseline.json` when it exists).
- `agents` sets how lines written by coding agents are held: `failOn`, `requireTests`, and `authors`
  (extra patterns that recognise an agent).

## Code changes: quick fixes, review, apply

A finding can come with a proposed change: whole files, before and after. Changes come from two
sources:
- **Quick fixes:** deterministic, from `--fix`, or "Propose quick fixes" in the editor (on by
  default there).
- **The LLM:** `--llm ... --llm-fixes N`, or "Also ask an LLM" in the editor; the keys stay on the
  server.

Every change is applied in memory, and the whole analysis runs again on the changed files (with
the analysers, on those files). Then the change is applied to a temporary copy of the project
(dependencies such as `node_modules` are linked, not copied), which is **built or type checked**:

| project | check |
| --- | --- |
| TypeScript | `npm run typecheck` if the package has it, otherwise `tsc --noEmit` |
| Python | `python3 -m py_compile` of the changed files |
| Go, Rust | `go build ./...`, `cargo check` |
| Java, Kotlin, Groovy | `mvn -q -o compile`, or `./gradlew compileJava` |
| C#, C, C++ | `dotnet build`, `clang -fsyntax-only`, `clang++ -fsyntax-only` |

Tests run too when asked: `"verification": { "test": "auto" }` (npm test, pytest, go test, cargo
test, mvn test) or a command of your own; `"build"` replaces the detected build command (`""`
turns it off). A check that already fails on the unchanged project is reported, not held against
the change.

A change is marked **✓ verified** only if the finding is gone, no new warning or error appears,
and the checks pass. The review shows each check (✓ type check, ✗ Python compile, with its
output). Nothing is written to your files until you apply a change.

| finding | quick fix | behaviour |
| --- | --- | --- |
| `unhandled-state`, `non-exhaustive-dispatch` | the missing values become explicit cases that do nothing (`case 'x': break; // pflow: ...`, Go `case A, B:`, Python `case A \| B: pass`), spelled like the existing labels (`State.X`, `State::X`, `'x'`) | unchanged: those values did nothing before either; the choice is now visible |
| `stale-write-after-await` | `if (<state> !== <value checked before>) return;` just before the write (TypeScript/JavaScript, Python) | returns early when another method changed the state during the await |
| `unreachable-state` (a declared value nothing sets, tests or handles) | the value is removed from its declaration: union type, enum (TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, PHP) | unchanged: no code used it. Values still tested somewhere are left alone (that branch is dead code to remove by hand) |
| `stuck-state`, `cannot-settle` | the state is declared final in `provenflow.config.json` (`machines[...].terminal`, keeping the final states already assumed) | the code is unchanged; accept it only if the state really is final, otherwise add the transition out of it |
| `resource-leak` | release the previous resource before acquiring again (`clearInterval`, `close()`, `disconnect()`, `unsubscribe()`), and add `dispose()` (`ngOnDestroy` for Angular components) releasing it (TypeScript/JavaScript) | the resource can no longer be lost |

In the editor, **Review change** opens a side-by-side view:
- original on the left, proposed on the right, with the changed lines and characters highlighted,
  and unchanged regions folded;
- the right side is editable;
- **Apply** writes it to the file, but only if the file still matches what was analysed.
  - For a folder opened in the browser (Chrome/Edge), the browser writes it.
  - For a folder analysed by path, the server writes it (`POST /api/apply`, 409 if the file
    changed).
  - Otherwise the window says why Apply is not available: an uploaded copy, or a server restarted
    since the analysis.
- **Verify this version** checks the right-hand text, with your edits, exactly like a proposed
  change: the analysis runs again on the changed file (in memory, nothing is written), the finding
  must be gone and nothing new appear, and the project must still build or type check on a copy.
  The badge becomes ✓ verified or ✗ not verified, with the reason and the check output;
- **New LLM fix** asks the LLM for another change (see *LLM fix* below);
- **Download file** and **Copy** give you the text;
- **Run the analysis again (changed files)** checks the project with the change, incrementally:
  - the models of the whole project are extracted and checked again (they span files, and this
    part takes seconds);
  - the analysers, the verification of proposed changes and the replays on the code run only for
    the files changed since the last run, and for findings that are new;
  - everything else (proposed changes and their verification, confirmations, analyser findings on
    unchanged files) is kept from the last run, and the report says how much was kept;
  - a change of `provenflow.config.json` or of the options (quick fixes, LLM, analysers) makes it
    a full run, and **Run the full analysis** is always one click away.

  A new analysis of a folder by path works the same way: the path field keeps the folders
  analysed recently (the last one filled in), and for one of them **Reuse the last analysis of
  this folder** (ticked by default) redoes only what changed since.

  On a 200-file Angular project, a full run with 20 proposed changes took 220 s; the re-run after
  applying one of them took 20 s.

**Findings and models.** A model is what was extracted from the code, and its properties say
what the code should satisfy. A finding is a problem. Most findings are a property that nuXmv
found false; the others come from direct checks (missing cases, layers, style).

In the editor, **Models → Properties** shows every property of a model:
- its verdict, and for a false one the finding with its explanation and fix;
- **Review the code change**, when a change is proposed;
- **Model after the change:** the model re-extracted from the changed code, next to the current
  one (`.pflow` side by side), with the false properties before and after.

A change's patch carries these model diffs (`suggestedPatch.models` in report.json).

The **Code changes** tab lists every proposal with its verification. **Apply all** applies every
verified change in one go, or all changes with the box ticked:
- each change is applied as its search/replace edits on top of the previous ones, so several
  changes to the same file combine;
- removals come first, and a change that adds a value another change removes is skipped;
- a change whose text was already replaced is skipped and listed as a conflict
  (`POST /api/apply-edits`);
- afterwards, **Run the analysis again** for up-to-date proposals. From the terminal, `--fix`
writes each change to `fixes/NN-rule/` (the changed files and `change.patch`), and report.md shows
the diff.

## Fix (no LLM), one finding at a time

**Fix (no LLM)** is on every finding that has no proposed change yet. Without an LLM call, it
gives the change the analysis can make itself, opened in the review before/after:
- when one of the automatic fixes applies to the finding (the quick fixes above; an analysis
  proposes at most 20, so later findings get theirs here), that fix, verified;
- otherwise a **draft**: the finding's suggested fix written as a comment at the line to change
  (`// TODO(pflow <rule>): …`). Write the change on the right in its place, then **Verify this
  version**; the draft itself is never marked verified, since it changes nothing yet.

## LLM fix, one finding at a time

Each warning or error without a verified change has an **LLM fix** button. The LLM (the one
chosen for the analysis, or the first configured in Help → LLM settings) gets:
- the finding, its **suggested fix** (the *Fix:* line), and the counterexample as calls in the code;
- the whole file, with line numbers, when it is up to 600 lines (otherwise the 120 lines around
  the finding), and the related places in other files.

While it works, the finding shows what it is doing: the step (writing the change, verifying it),
its **thinking** as it is written (when the model gives it: turn it on in LLM settings, *Show the
model's thinking*, with a token budget; a model without thinking is asked again without it), the
answer, and the **token usage** (input, output, thinking). The review keeps them next to the
change. The server also writes one line per LLM call to its log, for example:

```text
[llm] anthropic:claude-sonnet-5 fix resource-leak on Poller: 3210 input + 812 output tokens (540 of them thinking), 14.2 s
```

so `tail -f` on the server's output follows every call, including those of an analysis with an
LLM (whose totals are also in report.md).

It answers with exact search/replace edits. ProvenFlow turns them into the changed files and
their diff, and verifies them like the quick fixes (the analysis again on the changed files, then
the build or type check on a copy). The review then opens: the code before and after side by side,
the LLM's explanation, and the verdict. Edit the right side and **Verify this version**, ask for
a **New LLM fix**, or **Apply** it. Each click asks the LLM again (these answers are not cached).

The same from the API: `POST /api/fix { path | files, finding, llm }`, and
`POST /api/verify-change { path | files, finding, changed: [{ file, after }] }` for your version.

## LLM assistance, verified

In the editor, **Help → LLM settings (API keys)…** holds:
- the key, model and address for Anthropic, an OpenAI-compatible server, or Ollama (no key);
- for an Anthropic key that is not scoped to a workspace, the **workspace ID** (Claude Console →
  Settings → Workspaces), sent as the `anthropic-workspace-id` header (`ANTHROPIC_WORKSPACE_ID` in
  the environment);
- which provider to offer first in the Code base review;
- a **Test** button for each provider.

The settings go to the ProvenFlow server on this computer, which only accepts them when it is
bound to localhost. Keys are never shown again in clear. "Remember on this computer" saves them in
`~/.config/provenflow/llm.json` (mode 600; `PROVENFLOW_SETTINGS` changes the path). Settings made
here take precedence over the environment variables below.

```sh
ANTHROPIC_API_KEY=... pflow extract . --llm anthropic:claude-sonnet-5 --llm-fixes 5
OPENAI_API_KEY=... pflow extract . --llm openai:<model>      # or any OpenAI-compatible server: OPENAI_BASE_URL
pflow extract . --llm ollama:qwen2.5-coder                   # local model, OLLAMA_HOST
```

LLMs are non-deterministic, so nothing they say is used without a check:

| the LLM is asked | its answer is kept only if |
| --- | --- |
| which values a computed write can set (`this.status.set(next)`) | it cites a write the parser found (file and line) and uses values of the variable's type |
| which requirements a machine should satisfy (from names, comments, transitions) | the property parses; nuXmv then decides whether the code satisfies it |
| a patch for a finding, as exact search/replace edits | the edits apply, and re-running *every* check on the patched files removes the finding without adding a new warning; otherwise the patch is shown as "not verified" |

The patch check runs in memory, through file overrides passed to both front ends. Your working
tree is never modified. Answers are cached under `.provenflow/cache/` by the hash of the prompt,
so a run can be reproduced and a second run costs nothing.

## Outputs and CI

`pflow extract <dir> [-o out]` writes to `<dir>/.provenflow/extract/` by default:

| file | for |
| --- | --- |
| `report.md` | people: findings by category, with fixes and counterexample tables, patterns found, paradigm profile, dependencies, models |
| `report.json` | tools |
| `report.sarif` | GitHub code scanning: findings appear on the pull request. Each result has a stable fingerprint (rule, subject and file, no line), so an alert keeps its identity when lines move; rules have help text and a link to this guide |
| `report.codequality.json` | GitLab Code Quality (merge request widget) |
| `report.rdjson` | reviewdog: comments on GitHub, GitLab, Gerrit, Bitbucket or Gitea; verified changes as suggestions |
| `models/*.pflow` | the ProvenFlow editor: Open .pflow… to see, check and replay |
| `scenarios/*` | a vitest/pytest skeleton per counterexample |

The exit code is 5 when there are findings at or above `--fail-on`, beyond the baseline. That is
`error` by default; use `warning` for stricter gates, or `none`. report.md also has a **Code quality**
section: duplicated lines, complexity percentiles and hotspots, long functions, naming, dependencies,
coverage, and the naming conventions applied. This is the GitHub Actions step ProvenFlow uses on
itself:

```yaml
- run: npx pflow extract . --fail-on warning -o provenflow-report
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: provenflow-report/report.sarif, category: provenflow }
```

## Pull-request review

`pflow review` reviews a change rather than the whole project: it runs the analysis, then keeps
the findings on the lines changed since `--base` (`git diff`, plus files git does not know yet).
Reporting at the diff is what gets findings fixed.

```sh
pflow review . --base origin/main            # the findings on your changes, exit 5 on errors
pflow review . --base origin/main --files    # in the changed files, not only the changed lines
pflow review . --fix --github                # in GitHub Actions: post a pull-request review
```

With `--github` (in a `pull_request` run, with `GITHUB_TOKEN`) the findings become a review:
- one comment per finding on its line: the message, the fix, the counterexample, and whether it
  was confirmed on the code;
- a verified single-file change becomes a GitHub **suggestion**, applied with one click;
- one **summary** comment with the counts, the tools that ran and the proofs;
- the findings also appear as **annotations** on the Files tab and in the run's summary.

Later pushes do not repeat the review. Each comment carries a hidden marker with its finding
(rule, subject and file, so moved lines do not matter):
- only findings not reported before get a new comment;
- a finding that is gone gets a reply "✓ No longer reported at `<commit>`" under its comment;
- the summary comment is edited in place, with the new, still-reported and fixed counts.

`--state <dir>` keeps the run between pushes; the Action keeps it in the Actions cache, so a push
re-analyses only the files it changed.

### The GitHub Action

```yaml
# .github/workflows/review.yml
name: ProvenFlow review
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # the base of the pull request is needed for the diff
      - uses: belkassaby/provenflow@v0
        with:
          fail-on: error                  # the check fails on errors of the changed lines (warning, none)
```

| input | default | what |
| --- | --- | --- |
| `path` | `.` | the folder to analyse |
| `fail-on` | `error` | fail the check on findings at this level on the changed lines (`warning`, `info`, `none`) |
| `new-only` | `true` | analyse the base too, and count only the findings the pull request adds |
| `baseline` | the config's | the file of accepted findings |
| `coverage` | none | coverage reports written by an earlier step (one per line): changed lines no test runs are reported |
| `mutate` | `0` | mutation-test up to this many changed lines (needs the dependencies installed) |
| `check-run` | `false` | also post a check run named ProvenFlow with every finding as an annotation (`checks: write`) |
| `fix` | `true` | propose verified fixes, posted as suggestions |
| `files` | `false` | review the whole changed files, not only the changed lines |
| `semgrep` / `cbmc` / `infer` | `true` / `false` / `false` | install the analyser on the runner |
| `incremental` | `true` | keep each run in the Actions cache, and re-analyse only what a push changed |
| `llm`, `llm-fixes` | none, `5` | also ask an LLM for fixes (verified like the others), e.g. `anthropic:claude-sonnet-5` |
| `anthropic-api-key`, `openai-api-key`, `openai-base-url` | none | the LLM's key: pass a secret, `${{ secrets.ANTHROPIC_API_KEY }}` |
| `github-token` | the job's token | posts the review |

It installs only the three packages the review needs (not the editor). The built packages are cached
under a key of the Action's own sources, so later runs skip `npm ci` and the build. Every action it
uses is pinned to a commit, as organisations that enforce SHA pinning require.

Make the check **required** (repository settings → rules) to block merges on its findings. With a
merge queue, also run the gate on `merge_group` (`pflow extract . --fail-on error`, as this
repository's `ci.yml` does): a required check that never reports on the queue's commit fails the
merge.

Pull requests opened by the Copilot coding agent are like those from forks: their workflows wait
until someone with write access approves them. GitHub's own validation of agent pull requests runs
its own tools (CodeQL, the Advisory Database, secret scanning, Copilot review), so ProvenFlow joins
as a required check or a code-scanning tool.

**Pull requests from forks** get a read-only token, which cannot post. Their run writes the review
to a file instead (the `provenflow-review` artifact), and a second workflow, which runs in the base
repository on its own code (never the fork's), posts it after checking that it is for the same
pull request and head commit:

```yaml
# .github/workflows/review-post.yml
name: ProvenFlow review (post for forks)
on:
  workflow_run: { workflows: [ProvenFlow review], types: [completed] }
permissions: { pull-requests: write, actions: read }
jobs:
  post:
    if: github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_repository.full_name != github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: provenflow-review, run-id: '${{ github.event.workflow_run.id }}', github-token: '${{ github.token }}' }
      - uses: belkassaby/provenflow@v0
        with: { post-review-file: provenflow-review.json }
```

The review posts as `github-actions[bot]`. The analysis runs the pull request's code only where
your CI already does (the build check, and the replay of counterexamples), inside the runner.

## Gating what is new: baseline and new-only

A code base adopting ProvenFlow already has findings. Two mechanisms hold a change responsible only
for what it adds:

- **The baseline** (`provenflow-baseline.json`).
  - `pflow baseline .` writes the findings the code has today, keyed by rule, subject and file (no
    line numbers, so they survive edits) and counted.
  - `pflow extract` and `pflow review` then fail only on findings beyond it.
  - Entries that no longer occur are reported, and `pflow baseline --update` removes them; it never
    adds any, so the file can only shrink.
  - A finding with a measure (complexity, nesting) records it: raising an accepted function's
    complexity fails.
- **New-only review** (`pflow review --base <ref> --new-only`, on by default in the Action).
  - The base revision is analysed too, as overrides of the working tree, so dependencies are the
    same and only the change differs.
  - A finding on a changed line that the base already had is not counted: the summary says how
    many were left out.

```sh
pflow baseline .                         # accept today's findings; commit the file
pflow extract . --fail-on warning        # CI: fails on new findings only
pflow baseline . --update                # after fixing some: remove them from the baseline
```

**Lines written by coding agents** can be held to a stricter rule:
- **Which lines.** `pflow review` finds the commits since the base whose author or `Co-authored-by`
  trailer is a coding agent (Claude, Copilot, Codex, Cursor, Devin, Jules, Gemini, Aider...), or that
  carry a Git AI note (`refs/notes/ai`). `git blame` then gives the changed lines they wrote.
- **What applies to them.** Findings there fail at `agents.failOn` (default `warning`), and a change
  without a test change fails too (`agents.requireTests`, default true).
- **What the summary shows.** How many commits and lines were agent-written.

The review summary also shows, per rule, how many findings were commented on the pull request and
how many were fixed afterwards. A rule whose comments are seldom acted on is noise to tune.

## Coding agents: MCP server, hooks, setup steps

The same checks can run inside a coding agent's loop, so that it fixes findings before the pull
request exists (recipes in `examples/ci/`):

- **MCP server** (`pflow mcp`, stdio). Configure it in `.mcp.json` or the agent's settings:
  `{ "mcpServers": { "provenflow": { "command": "pflow", "args": ["mcp"] } } }`. Its tools:
  - `project_conventions`: the layers and what each may import, naming per language, complexity and
    size limits, declared patterns. To read before writing code.
  - `find_existing_code`: the project's functions similar to a snippet the agent is about to write
    (copies with other names, and functions sharing most tokens). To reuse a helper instead of
    writing it again.
  - `review_changes`: the findings on the lines changed since a revision (default HEAD: the
    uncommitted work).
  - `propose_fix`: the analysis's verified fix for one finding, as a diff.
- **Claude Code hooks** (`examples/ci/claude-settings.json`).
  - `pflow hook post-edit` runs after each Edit/Write: the findings on the uncommitted lines of the
    file just written go back to Claude (exit code 2).
  - `pflow hook stop` keeps Claude working until the uncommitted changes have no error or warning.
  - Analysers and replays are skipped for speed, and the last run is kept in `.provenflow/state`, so
    each hook re-analyses only what changed.
- **Copilot coding agent** (`examples/ci/copilot-setup-steps.yml`): installs `pflow` in the agent's
  environment.
- **AGENTS.md** (`examples/ci/AGENTS.md`): the section that tells agents to use these.

## Other CI systems

- **GitLab:** `report.codequality.json` goes in `artifacts:reports:codequality` (the merge request
  widget) and `report.sarif` in `sast` (`examples/ci/gitlab-ci.yml`).
- **reviewdog** (GitHub, GitLab, Gerrit, Bitbucket, Gitea): `reviewdog -f=rdjson
  -filter-mode=added < report.rdjson` (`examples/ci/reviewdog.yml`).
- **Anything else:** the exit code (5 on new findings), `report.sarif` and `report.json`.

## Comparing two versions: pflow compare

```sh
pflow compare . --base origin/main -o quality.md     # the working tree against a revision
pflow compare after/ --before before/ -o quality.md   # two folders
```

Both versions are analysed with the same config, so only the code differs. The report gives:
- the measures side by side (duplicated lines and clones, similar functions, Cognitive Complexity
  mean, 90th percentile and highest, functions over the limit, nesting, length, parameters, naming,
  dependencies, coverage, findings by severity), marked better or worse;
- the findings by rule;
- the findings fixed and introduced;
- the functions whose complexity changed.

Analysers are off unless `--analyzers`; `--json` gives the data. [ProvenFlow's own before and
after](quality-before-after.md) was made with it.

## pflow init: a config from the code

`pflow init .` proposes a `provenflow.config.json` from the code as it is, with the evidence for
each entry:
- **Per language:** the coding standards ([coding-standards.md](coding-standards.md)), adjusted
  where the project consistently names things otherwise.
- **Layers:** from the current import graph, with the dependencies they have today and the style
  each follows.
- **Patterns:** those recognised from types and language constructs (not from names).
- **Coverage:** reports found in the usual places.
- **Baseline and agent policy:** set to their defaults.

An existing config keeps its layers, patterns, machines, ignores and limits; `--force` writes over
it, `-o` writes elsewhere.

`pflow init . --instructions --llm anthropic:<model>` also reads the instruction files coding agents
use:
- `AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, `GEMINI.md`;
- `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`;
- Cursor and Claude rules, Bugbot rules.

The LLM turns the statements that can be checked ("UI code never imports the database layer",
"functions under 40 lines") into config entries. An entry is kept only if it quotes the file and
validates against the config schema; `ignore` entries are never accepted from it. With `--base
<ref>` the files are read from that revision, so a pull request cannot change the rules it is
checked against.

## ProvenFlow checked by ProvenFlow

ProvenFlow's own `provenflow.config.json` declares:
- its layers, and what each may import: `language` imports nothing; `extract` imports
  `language`; `server` imports `language` and `extract`; `app` imports `language`;
- their styles: functional for `language`, `extract` and `server`, object-oriented for the
  Angular `app`;
- the singletons it relies on;
- the two packages used as facades.

The first run on the repository found these, and the code was changed accordingly:

| finding | change |
| --- | --- |
| `stale-write-after-await` in `App.check`: after a slow check it switched to the Console tab even if the user had moved on | only switch if the user is still on the results (`packages/app/src/app/app.ts`) |
| `non-exhaustive-dispatch` in `astToModel`: three element kinds fell through the `switch` silently | explicit cases for them and an exhaustive `never` default (`packages/language/src/ast-to-model.ts`) |
| `god-class` `DiagramStore` (31 methods) | simulation moved into pure functions (`packages/app/src/app/simulation.ts`) |
| `god-class` `Extractor` (39 methods, 927 lines), in the extractor itself | split by responsibility: templates, resources, code shape and context modules |
| `fp-mutates-argument` in `mergeFacts` and the LLM steps (layer declared functional) | they return new values instead of changing their arguments |

Some findings were decided instead of changed. They are recorded in `ignore` with a reason:
- the memoised Langium services in `parse.ts`;
- the runtime monitor class, which is stateful by nature;
- CodeMirror's `token()` contract.

Other findings showed where the extractor was imprecise, and led to these improvements:
- reading Angular templates;
- taking parameter values from call sites;
- treating only public methods as lifecycle events;
- no longer treating plain data "kinds" as state machines.

CI now runs `pflow extract . --fail-on warning`, so a change that breaks one of these properties
fails the build.

The second run, with the code-quality checks, found the one copied block in the code base: the same
41 lines in the extractor and in the editor, which the layer rules let neither import from the other.
It moved to `language`, which both may import. It also found the functions with the highest Cognitive
Complexity: the server's `createApp` and the CLI's `main` (189 each), the front ends' declaration
collectors (96 and 101), and the Markdown report (92). They were split by responsibility. The
measures before and after are in [quality-before-after.md](quality-before-after.md); the rest is
accepted in `provenflow-baseline.json`, and only new findings fail.

## Limits as a CI gate

What a team adopting ProvenFlow in CI should know:
- **nuXmv's licence.** nuXmv is free for non-commercial and academic use only, and the Action does
  not install it. Without it, an explicit-state checker decides the standard properties
  (reachability, settling, leaks, layer cycles); properties written in the config or suggested by an
  LLM are then reported as not checked.
- **Abstractions.** The models are abstractions of the code ([soundness](#what-the-results-mean-soundness)).
  Complexity in the tree-sitter languages is computed from node-type names, so a construct a grammar
  names differently can be missed.
- **Duplication** finds copies with other names (Type-1 and Type-2) and functions sharing most
  tokens (Type-3). It does not find code that does the same thing written differently (Type-4).
- **Coverage** is read from reports; ProvenFlow does not run the tests to produce them. Mutation
  testing runs the project's tests once per mutant, so it is opt-in.
- **Agent attribution** relies on commit trailers and Git AI notes; an agent that commits under a
  person's name, without a trailer, is not recognised.

The research behind these choices is in [ai-code-guardrails.md](ai-code-guardrails.md).
