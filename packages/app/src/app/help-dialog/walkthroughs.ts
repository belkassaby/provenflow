/** Step-by-step guides for the features of the editor, shown in Help → Walkthroughs. */

export interface WalkthroughStep {
    text: string;
    /** Optional code or .pflow snippet shown under the step. */
    code?: string;
}

export interface Walkthrough {
    id: string;
    title: string;
    /** What you will get out of it, one sentence. */
    goal: string;
    /** Example loaded by the "Load the example" button. */
    example?: string;
    /** Extra search terms. */
    keywords?: string;
    steps: WalkthroughStep[];
}

export const WALKTHROUGHS: Walkthrough[] = [
    {
        id: 'verify',
        title: 'Verify a design and replay a counterexample',
        goal: 'Check temporal properties with nuXmv and see, step by step, how a false one fails.',
        example: 'mutex',
        steps: [
            { text: 'Load the example (Mutual exclusion). The text on the left and the diagram in the middle are the same model.' },
            { text: 'Open the Properties tab: each LTLSPEC, CTLSPEC or INVARSPEC is a property of the design.' },
            { text: 'Click ▶ Check. Properties that hold get ✓; "liveness" gets ✗.' },
            { text: 'Click Counterexample next to it. The Trace tab replays the failing run on the diagram: current state in orange, visited states in light orange, the loop that repeats forever drawn dashed.' },
            { text: 'Use ◀ ▶ or Play to step through it. The table shows every variable at every step; changed values are highlighted.' },
            { text: 'Fix the design (add a transition, a guard, a fairness constraint) and check again: the results are marked stale as soon as the diagram changes.' }
        ]
    },
    {
        id: 'data',
        keywords: 'variables counters guard update when do',
        title: 'Guards and data variables',
        goal: 'Model counters and flags (retry budgets, approvals) without drawing one state per value.',
        example: 'agent-retry-data',
        steps: [
            { text: 'Load the example (Retry budget with data). Look at the variables block: retries is a bounded counter, approved a flag.', code: 'variables {\n  retries  : 0..3 := 0;\n  approved : boolean := FALSE;\n}' },
            { text: 'A transition can have a guard (when), updates (do) and a probability (prob). It is enabled only when the guard holds and the updates stay in range; when nothing is enabled the state stutters.', code: 'test -> work : "tests_failed" when retries < 2 do retries := retries + 1;\nreview -> done : "approve" do approved := TRUE;' },
            { text: 'Select a transition on the diagram: the inspector has Guard, Updates and Probability fields. The edge label shows [guard] / updates.' },
            { text: 'Add or edit variables in the Attributes tab, under Data variables (type, domain, initial value).' },
            { text: 'Check with nuXmv: "budget" (retries <= 2) is proved; "always_merges" fails because a human can reject forever.' },
            { text: 'nuXmv verifies data models through a TRANS relation: open the nuXmv model tab to see it.' }
        ]
    },
    {
        id: 'simulate',
        title: 'Simulate the design by hand',
        goal: 'Walk through the model and watch attributes and variables change.',
        example: 'agent-retry-data',
        steps: [
            { text: 'Choose nuXmv → Simulate the diagram (or Trace → Start simulation).' },
            { text: 'The next possible states have a dotted green border: click one to move there, or use Random step.' },
            { text: 'The table lists every step with the attribute and variable values. With guards, only enabled transitions are offered: after two failed test runs, retrying is no longer possible.' },
            { text: 'Back undoes a step; Restart goes back to the initial state; Stop ends the simulation.' }
        ]
    },
    {
        id: 'probabilities',
        keywords: 'prism storm markov dtmc pctl expected',
        title: 'Probabilistic analysis',
        goal: 'Estimate how likely and how fast a goal is reached, given probabilities on the transitions.',
        example: 'agent-retry-data',
        steps: [
            { text: 'Give transitions a probability: prob 0.3 in the text, or the Probability field of the inspector. Transitions of a state without a probability share what is left.' },
            { text: 'In the Properties tab, scroll to Probabilistic analysis. Queries are suggested from the final states.' },
            { text: 'Choose a query: P(reach) (optionally within k steps), E[steps until], or E[visits before] (e.g. expected escalations before a merge). Targets are conditions such as phase = done.' },
            { text: 'Click Compute. For the example: P(reach done) = 1, P(reach done within 6 steps) ≈ 0.68, E[steps] = 6.' },
            { text: 'Export PRISM model writes the same Markov chain for PRISM or Storm, with a properties file, for full PCTL, rewards and steady-state analysis.' },
            { text: 'Note: nuXmv says whether something can happen on some run; the Markov chain says how likely it is. A state that a run can avoid forever may still be reached with probability 1.' }
        ]
    },
    {
        id: 'python',
        keywords: 'code generation runtime enforcement rejection policy feedback llm tool',
        title: 'Generate the Python implementation',
        goal: 'Run the verified design as code that refuses any move the model does not allow.',
        example: 'agent-coding-loop',
        steps: [
            { text: 'Open the Python tab and download <name>_fsm.py (no dependency). The table above the code lists which properties are also monitored at run time.' },
            { text: 'Drive it with events. Labels work as written; illegal moves raise InvalidTransition.', code: 'import agentic_coding_loop_fsm as m\nfsm = m.AgenticCodingLoopFSM()\nfsm.send("USER_SUBMIT")\nfsm.allowed_events()      # the legal next moves\nfsm.send("HUMAN_APPROVED")  # InvalidTransition' },
            { text: 'Attach your work to states with hooks: subclass the machine and define on_enter_<state>(self, event, data).', code: 'class Agent(m.AgenticCodingLoopFSM):\n    def on_enter_developing0(self, event, data):\n        ...  # call the coding LLM here' },
            { text: 'Choose what happens with an illegal event: on_invalid="raise" (default), "return" (a Rejected whose as_feedback() tells an LLM what is allowed), "escalate:<EVENT>" or a handler.', code: 'fsm = m.AgenticCodingLoopFSM(on_invalid="return")\nr = fsm.send("DEPLOY_NOW")\nif not r:\n    prompt += r.as_feedback()' },
            { text: 'Monitored properties are re-checked after every step; in strict mode a violation raises PropertyViolation.' }
        ]
    },
    {
        id: 'notebook',
        keywords: 'jupyter ipynb anywidget colab',
        title: 'Jupyter notebook with a live diagram',
        goal: 'Showcase the implementation in a notebook where the diagram follows the running code.',
        example: 'agent-coding-loop',
        steps: [
            { text: 'Check the properties first (▶ Check) so that the notebook includes the verdicts and the counterexamples.' },
            { text: 'Python tab → Jupyter notebook (or File → Export Jupyter notebook) and open the .ipynb in JupyterLab, VS Code or Colab.' },
            { text: 'Run all cells: the module is written with %%writefile, the machine is displayed as a diagram (plain SVG), then a live widget (pip install anywidget) follows every transition of the walk-through.' },
            { text: 'The notebook also shows an illegal event being rejected, how to limit an LLM to the allowed events, hooks, and replays each nuXmv counterexample on the implementation.' }
        ]
    },
    {
        id: 'live',
        keywords: 'websocket sse stream remote human approval',
        title: 'Follow and drive a running process (live link)',
        goal: 'See, on the diagram, the state a Python process is in, and send it events such as approvals.',
        example: 'agent-coding-loop',
        steps: [
            { text: 'In the Trace tab, pick a channel name and click Live from Python.' },
            { text: 'In the Python process, link the machine to the same channel. commands=True lets the editor send events back.', code: 'fsm.link_editor("http://127.0.0.1:3000", channel="notebook", commands=True)' },
            { text: 'Each transition now moves the diagram: current state, visited states and possible next states are highlighted; the table lists events, values, monitor verdicts and rejected events.' },
            { text: 'Click ▶ EVENT (or a highlighted next state) to send an event to the process. It still goes through send(), so only verified transitions can happen.' },
            { text: 'Disconnect stops following the process.' }
        ]
    },
    {
        id: 'conformance',
        keywords: 'otel opentelemetry jsonl logs replay audit production',
        title: 'Check a recorded run against the model',
        goal: 'Find where a real execution deviated from the verified design.',
        example: 'agent-retry-data',
        steps: [
            { text: 'Record runs of the real system: fsm.record_to("run.jsonl") in the generated code, fsm.enable_tracing() for OpenTelemetry, or any JSON Lines log with a "state" field (and optionally "event" and "values").', code: '{"state": "work"}\n{"state": "test", "event": "code_written"}\n{"state": "work", "event": "tests_failed"}' },
            { text: 'Trace tab → Check a recorded run… and pick the file.' },
            { text: 'Each step must follow an enabled transition of the model (existing, guard true, right event, same values) and the monitored properties must hold. Problems are listed with their step; click one to jump there on the diagram.' },
            { text: 'From a terminal: pflow conform diagram.pflow run.jsonl (exit code 4 when the run deviates), e.g. in CI or on production logs.' }
        ]
    },
    {
        id: 'tests',
        keywords: 'pytest hypothesis property based',
        title: 'Property-based tests of your implementation',
        goal: 'Test your hooks and glue code against the model with Hypothesis.',
        example: 'agent-retry-data',
        steps: [
            { text: 'Python tab → Download tests (with the module). Check first to include the counterexamples as scenarios.' },
            { text: 'Replace FSM = ... at the top with your subclass, then run pytest.', code: 'pip install pytest hypothesis\npytest test_retry_budget_fsm.py' },
            { text: 'Hypothesis fires random allowed events and checks that every move follows the verified table, illegal events are rejected without side effects, and monitors and variable domains hold. A failure is shrunk to the shortest run that shows it.' }
        ]
    },
    {
        id: 'frameworks',
        keywords: 'xstate stately langgraph burr temporal crewai',
        title: 'Export to XState, LangGraph, Burr or Temporal',
        goal: 'Keep your agent framework and give it the verified control flow.',
        example: 'agent-coding-loop',
        steps: [
            { text: 'Python tab → Export to… and choose the framework. The Python targets also need the generated <name>_fsm.py.' },
            { text: 'XState: a setup().createMachine() with guards and actions; paste it into Stately to visualise it.' },
            { text: 'LangGraph and Burr: one node / action per state. Provide decide(state, allowed, values), which calls your LLM, tool or human and returns one of the allowed events.', code: 'app = build_graph(decide)\napp.invoke(initial_state())' },
            { text: 'Temporal: a durable workflow. The decide activity makes the choices; states that look human (review, approval) wait for the human_event signal; only verified moves are taken.' }
        ]
    },
    {
        id: 'import',
        keywords: 'langgraph crewai mermaid xstate reverse',
        title: 'Verify an agent you already have',
        goal: 'Turn an existing LangGraph, CrewAI, Mermaid or XState graph into a diagram and check it.',
        steps: [
            { text: 'Get the graph: in LangGraph, app.get_graph().to_json() or app.get_graph().draw_mermaid(); or use the Python source of a LangGraph builder or a CrewAI Flow; or an XState machine; or any Mermaid flowchart / stateDiagram.' },
            { text: 'File → Import agent graph… and pick the file. START and END become initial and final states; conditional edges become choices nuXmv explores.' },
            { text: 'Label the states with atoms (Attributes tab), write the properties you expect (Properties tab), and check. The imported diagram now documents and verifies the agent.' },
            { text: 'Reading Python source is best effort: compare the diagram with the code.' }
        ]
    },
    {
        id: 'code',
        keywords: 'extract code base source typescript python angular java kotlin groovy scala c c++ cpp c# csharp go golang rust swift ruby php r bugs patterns singleton observer builder architecture layers paradigm functional object oriented llm ai generated sarif ci security dataflow taint injection xss semgrep codeql infer heap null leak memory safety overflow cbmc esbmc kani proof replay confirmed build typecheck tests review pull request github action suggestion',
        title: 'Model-check a code base (pflow extract)',
        goal: 'Check existing or AI-generated code: its state machines, resource lifecycles, design patterns and layers become models nuXmv verifies, and each problem comes with the code path that shows it and a fix.',
        steps: [
            { text: 'Choose File → Import code base…. Either Choose folder… (in Chrome/Edge, allow editing when asked: the browser then writes the changes you apply; other browsers upload a read-only copy), or, when the server runs on this machine, type the folder path: it is read in place with its node_modules, so library types such as Angular signals are known. While it runs, the progress bar shows the percentage, the current step (reading the files, checking model 3/24, Semgrep still running, verifying change 2/5…), the elapsed time and the steps already done; you can close the window and come back. After the analysis the window becomes the Code base review.' },
            { text: 'The results open in the same window: findings by category with their fix and counterexample (errors and warnings; tick notes to see more), the models, the design patterns found and the paradigm profile of each part. Open model opens a model in a new tab and checks it, so the counterexample is one click away; Download report saves the Markdown report.' },
            { text: 'Findings or models? A model is what was extracted from the code (a state machine, a resource lifecycle, a pattern contract, the layer graph); its properties say what the code should satisfy. A finding is a problem: most findings are a model property nuXmv found false, the others come from direct checks (missing cases, layers, style). Models → Properties lists every property of a model with its verdict and, for a false one, the finding and what to do.' },
            { text: 'For a false property, Model after the change shows the model re-extracted from the proposed code change, next to the current one (the .pflow side by side), with the false properties before and after. Open the changed model in a tab to check it yourself.' },
            { text: 'Code changes: with "Propose quick fixes" ticked (and optionally an LLM chosen on the first screen), findings come with a proposed change. Quick fixes cover missing switch cases (listed explicitly, behaviour kept), writes after an await (a re-check just before), resources acquired twice or never released (release first, add dispose), declared values nothing uses (removed from the enum or union), and states the machine cannot leave (declared final in provenflow.config.json, if they are). Each change is applied in memory and every check is run again: ✓ verified means the finding is gone and nothing new appeared.' },
            { text: 'Review change (on a finding, or in the Code changes tab) shows the original code on the left and the proposed code on the right, side by side, with the changed lines highlighted. The right side is editable. Apply writes it to the file (refused if the file changed since the analysis), Download file saves it, and Run the analysis again checks the project with the change. When Apply is not available, the window says why (an uploaded copy, or a server restarted since the analysis).' },
            { text: 'Apply all in the Code changes tab applies every verified change in one go (tick the box to include the others). Each change is applied as its edits on top of the previous ones, so several changes to one file combine; a change whose text was already replaced, or that adds a value another change removes, is skipped and listed. Then Run the analysis again.' },
            { text: 'LLM fixes: Help → LLM settings (API keys)… holds the key, model and address of Anthropic, an OpenAI-compatible server or Ollama, with a Test button. The keys are kept by the ProvenFlow server on this computer (optionally remembered in a file only you can read) and never shown again in clear.' },
            { text: 'Open as many models as you like: each one gets its own tab above the editor, with its results and trace kept when you switch. The ⌘ Code report button on the right of the tabs (or File → Code base report…) brings the findings and the list of models back without importing again, also after a reload.' },
            { text: 'Security, heap and memory safety come from the analysers ProvenFlow drives when they are installed (on PATH, or SEMGREP_PATH, INFER_PATH, ESBMC_PATH, CBMC_PATH): Semgrep with bundled taint rules (injection, path traversal, SSRF, XSS, unsafe deserialisation, disabled TLS, secrets), Infer (null dereferences and leaks across calls in C/C++/Java), ESBMC or CBMC (every C/C++ function, for every input: pointers, bounds, leaks, overflow, division by zero) and Kani (Rust). CodeQL is opt-in in provenflow.config.json. Untick "Run the installed analysers" to skip them.', code: 'pip install semgrep              # security and dataflow rules\nbrew install cbmc                # or esbmc: memory safety of C/C++' },
            { text: 'Tools & proofs lists the analysers that ran, those that are not installed, and the proofs about the code: each C/C++/Rust function proved (no failure, loops unwound up to the bound), refuted (a finding with the failing inputs as counterexample) or unknown.' },
            { text: 'Confirmed on the code: model findings are checked on the real code where possible. Counterexamples of TypeScript and Python classes are replayed on a real instance (dependencies mocked), a stale write after an await is reproduced by interleaving the calls, a timer leak by counting the running timers, and an unreachable value of a C state variable is model checked on the code by ESBMC/CBMC. The finding then shows ✓ confirmed on the code, or ✗ not reproduced (the model is coarser than the code).' },
            { text: 'Proposed changes are also built: each is applied to a temporary copy of the project and type checked or compiled (tsc / npm run typecheck, py_compile, go build, cargo check, mvn compile, clang). Tests run too with "verification": { "test": "auto" } in provenflow.config.json. The review shows each check with its output; a change that breaks the build is not verified.' },
            { text: 'Patterns are graded: declared (provenflow.config.json, or a // @pattern builder comment above the class), structural (types and language constructs) or heuristic (names and shapes). Findings on heuristic patterns are notes; declare the pattern to make them warnings.' },
            { text: 'Pull requests: pflow review keeps the findings on the lines changed since a git ref; with --github (in GitHub Actions) it posts them as a review, with each verified change as a one-click suggestion. The repository ships a GitHub Action for it.', code: 'pflow review . --base origin/main\n# .github/workflows/review.yml\n- uses: belkassaby/provenflow@main\n  with: { fail-on: error }' },
            { text: 'Languages: TypeScript/JavaScript (with Angular templates), Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, Ruby, PHP and R. State machines come from fields typed with an enum (or a union, signal, Go iota constants, Scala sealed trait), and from state/status fields set to strings or symbols (Ruby, R). Examples → Code base models shows three extracted models with the code they came from.' },
            { text: 'The same from a terminal. With NUXMV_PATH set the models are checked by nuXmv; without it, by an explicit-state checker for the standard properties.', code: 'NUXMV_PATH=/path/to/nuXmv npx pflow extract path/to/project' },
            { text: 'State machines: every field typed as a finite set of values (a string-literal union, an enum, a Signal of one, a Python Enum or Literal, an enum of any other language) becomes a model. Assignments are the transitions; if/switch/match conditions and early returns tell from which states they can happen; writes of a parameter take the values the callers pass.' },
            { text: 'Checked properties: every declared value can be reached (a value that is only compared against is dead code), the machine can always get back to its initial or final states, no state is stuck, every switch handles every value, and no write after an await relies on a check made before it.' },
            { text: 'Resource lifecycles: timers, listeners on window/document, EventSources, observers, processes, temporary directories, files and locks become idle / held / leaked / disposed models over the public methods of their class. nuXmv proves "never leaked" or shows how to leak (acquire twice, dispose without releasing).' },
            { text: 'Design patterns: singletons, observers, builders, strategies, adapters/decorators, the State and Command patterns, factories and facades are recognised. Each is checked by its contract: a singleton is never constructed twice, an observer can unsubscribe, a builder never builds unconfigured, every state class is reachable, every strategy implements its interface.' },
            { text: 'Read .provenflow/extract/report.md: every finding has its location, what goes wrong (with the counterexample as code events), and a fix. report.sarif shows the same findings in GitHub code scanning; scenarios/ has a test skeleton per counterexample to confirm it on the real code.' },
            { text: 'From the terminal, the models are written to .provenflow/extract/models/: File → Open .pflow… shows any of them here. The comments at the top of a model list the code behind every transition.' },
            { text: 'Declare what the code promises in provenflow.config.json: layers and what each may import (checked transitively by nuXmv), the style of each layer (functional or object-oriented), the patterns you expect, final states and extra properties of machines. Record accepted exceptions with a reason.', code: '{\n  "layers": [\n    { "name": "core", "paths": ["src/core/**"], "mayImport": [], "style": "functional" },\n    { "name": "ui", "paths": ["src/ui/**"], "mayImport": ["core"], "style": "object-oriented" }\n  ],\n  "patterns": [{ "subject": "Session", "pattern": "singleton" }],\n  "machines": { "Order.status": { "specs": ["AG (state = \'cancelled\' -> AG state != \'shipped\')"] } },\n  "ignore": [{ "rule": "fp-class", "subject": "Parser", "reason": "..." }]\n}' },
            { text: 'Optional LLM (API key or local model): it resolves writes of computed values, suggests requirements and proposes patches. Nothing is taken on trust: a resolved write must cite a write the parser found, a requirement must parse and is decided by nuXmv, and a patch is marked verified only if re-running every check on the patched code removes the finding without adding new ones. Answers are cached.', code: 'ANTHROPIC_API_KEY=... pflow extract . --llm anthropic:claude-sonnet-5 --llm-fixes 5\npflow extract . --llm ollama:qwen2.5-coder' },
            { text: 'In CI, --fail-on warning (or error) makes the build fail on new findings (exit code 5). ProvenFlow checks its own code this way.' }
        ]
    },
    {
        id: 'analyzers',
        keywords: 'install analyser analyzer semgrep infer esbmc cbmc kani codeql security dataflow taint injection xss heap null leak memory safety overflow proof brew pip homebrew path SEMGREP_PATH INFER_PATH CBMC_PATH ESBMC_PATH',
        title: 'Install the code analysers (Semgrep, Infer, ESBMC/CBMC, Kani)',
        goal: 'Add security, heap and memory-safety checks to the Code base review, by installing the tools ProvenFlow drives.',
        steps: [
            { text: 'They are optional: without them the review still extracts and checks its models, and Tools & proofs lists what each missing tool would add. Install the ones that fit your languages and what you want checked.' },
            { text: 'Semgrep: security and dataflow problems (command, code and SQL injection, path traversal, SSRF, XSS, unsafe YAML/pickle, disabled TLS checks, hard-coded secrets, gets/strcpy) in JS/TS, Python, Java, Go and C. Some come with a fix, verified like the quick fixes. Takes seconds.', code: 'brew install semgrep              # macOS\npython3 -m pip install --user semgrep   # Linux, Windows' },
            { text: 'ESBMC or CBMC (one is enough): proves, for every input, that each C/C++ function has no invalid pointer, out-of-bounds access, leak, signed overflow or division by zero (loops unwound up to a bound), or shows the input that breaks it. Also confirms ProvenFlow\'s state-machine findings on C code.', code: 'brew install cbmc esbmc           # macOS\n# Ubuntu: the cbmc .deb from github.com/diffblue/cbmc/releases\nsudo apt-get install ./ubuntu-24.04-cbmc-6.11.0-Linux.deb\n# Windows: cbmc-*-win64.msi or esbmc-windows.zip from their releases' },
            { text: 'Infer: bugs that go through several functions, null dereferences and memory or resource leaks, in C, C++, Objective-C and Java. No Homebrew formula: unpack the release (Linux x86-64 or Apple silicon; on Windows use WSL) and point INFER_PATH at it.', code: 'curl -fsSL https://github.com/facebook/infer/releases/download/v1.3.0/infer-osx-arm64-v1.3.0.tar.xz | tar -xJ -C ~/.local\nexport INFER_PATH=~/.local/infer-osx-arm64-v1.3.0/bin/infer\n# Linux: infer-linux-x86_64-v1.3.0.tar.xz' },
            { text: 'Kani: the same proofs as ESBMC/CBMC for Rust (panics, overflows, memory safety). Needs Rust (rustup).', code: 'cargo install --locked kani-verifier && cargo kani setup' },
            { text: 'CodeQL (optional, slow): GitHub\'s security queries with data flow across files. Its CLI is free for open-source code and research. Turn it on in provenflow.config.json.', code: 'brew install --cask codeql\n# provenflow.config.json\n"analyzers": { "codeql": true }' },
            { text: 'ProvenFlow looks for each tool on the PATH of the ProvenFlow server, or at SEMGREP_PATH, INFER_PATH, ESBMC_PATH, CBMC_PATH, CODEQL_PATH, KANI_PATH. Set them where you start the server, then restart it.', code: 'SEMGREP_PATH=$(which semgrep) CBMC_PATH=$(which cbmc) npm start' },
            { text: 'Run the analysis again (with "Run the installed analysers" ticked). Tools & proofs shows each tool that ran with its version, the proofs about the code, and what is still not installed. Their findings appear under Security and dataflow, Memory safety and arithmetic, and Heap.' },
            { text: 'Tune them in provenflow.config.json: extra Semgrep rules, a build command for Infer, the loop bound and time limit of ESBMC/CBMC, or false to turn one off.', code: '"analyzers": {\n  "semgrep": { "config": ["p/owasp-top-ten"] },\n  "infer": { "build": "mvn -q compile" },\n  "bmc": { "tool": "cbmc", "unwind": 12, "timeoutSec": 60 },\n  "kani": false\n}' }
        ]
    },
    {
        id: 'nurv',
        keywords: 'ltl monitor runtime verification fbk',
        title: 'Full-LTL runtime monitors with NuRV',
        goal: 'Monitor at run time the properties about the future too, with verdicts that use the model.',
        example: 'agent-coding-loop',
        steps: [
            { text: 'Start the server with NURV_PATH pointing to NuRV (free for academic use, from es-static.fbk.eu/tools/nurv). The Python tab then shows a NuRV monitors button.' },
            { text: 'Download the monitors (one .py and .c per future-time LTL property) and build them next to the module.', code: 'cc -fPIC -shared -o libnurv_always_goes_live.so nurv_always_goes_live.c' },
            { text: 'Attach them to the machine. A verdict stays "unknown" until the run decides the property for every continuation the model allows, then becomes "true" or "false".', code: 'import nurv_always_goes_live\nstatus = fsm.add_nurv_monitor(nurv_always_goes_live)\nstatus["verdict"]   # unknown / true / false' },
            { text: 'From a terminal: NURV_PATH=... pflow nurv diagram.pflow -o monitors/ generates and compiles them.' }
        ]
    },
    {
        id: 'layout',
        keywords: 'svg png spread radial zoom maximize resize',
        title: 'Lay out, resize and export the diagram',
        goal: 'Make large diagrams readable and publish them.',
        example: 'agent-coding-loop',
        steps: [
            { text: 'Pick a layout in the diagram toolbar: Vertical / Horizontal (layered), Spread (fewest crossing transitions), Radial (hub in the centre), Force, Circle, Grid. ↻ applies it again; positions are saved in the text.' },
            { text: 'Drag the dividers around the diagram to resize the panels (double-click resets); ⤢ gives the diagram the whole window, Esc restores.' },
            { text: 'Zoom with the wheel or + / − (down to 2%), Fit shows everything.' },
            { text: 'PNG or SVG export the current drawing, including a replayed trace.' }
        ]
    }
];
