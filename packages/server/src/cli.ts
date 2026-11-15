#!/usr/bin/env node
import { hookCommand } from './commands/agents.js';
import { catalogueCommand } from './commands/catalogue.js';
import { baselineCommand, compareCommand, extractCommand, initCommand, mutateCommand, postReviewCommand, reviewCommand } from './commands/code.js';
import { diagramCommand, isDiagramCommand } from './commands/diagram.js';
import { parse, type Values } from './commands/shared.js';
import { serveMcp } from './mcp.js';

const USAGE = `Usage:
  pflow generate <diagram.pflow> [-o model.smv]  write the nuXmv model
  pflow check <diagram.pflow> [--engine bdd|bmc|ic3] [--bound N]
                                                 verify the specifications with nuXmv (NUXMV_PATH)
  pflow python <diagram.pflow> [-o module.py]    write the Python implementation of the state machine
  pflow notebook <diagram.pflow> [-o notebook.ipynb] [--verify]
                                                 write a Jupyter notebook showcasing it; --verify runs
                                                 nuXmv first to include verdicts and counterexamples
  pflow pytest <diagram.pflow> [-o test_module.py] [--verify]
                                                 write Hypothesis property-based tests for the Python module
  pflow export <xstate|langgraph|burr|temporal> <diagram.pflow> [-o file]
                                                 export the verified machine to an agent/workflow framework
  pflow import <graph> [-o diagram.pflow]        import a LangGraph (JSON, Mermaid, source), CrewAI Flow,
                                                 Mermaid or XState graph as a diagram
  pflow prob <diagram.pflow> [--reach EXPR] [--within K] [--steps EXPR] [--visits EXPR --until EXPR]
                                                 probabilistic analysis of the diagram as a Markov chain
  pflow prism <diagram.pflow> [-o model.pm] [--reach EXPR ...]
                                                 export the Markov chain to PRISM / Storm (model + .pctl)
  pflow nurv <diagram.pflow> [-o dir]            generate full-LTL Python monitors with NuRV (NURV_PATH)
                                                 and compile them with cc when available
  pflow conform <diagram.pflow> <run.jsonl|otel.json>
                                                 check a recorded run against the model (exit 4 if it deviates)

Code bases (TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++, C#, Go, Rust, Swift, Ruby, PHP, R):
  pflow extract <dir> [-o dir] [--config file] [--fail-on error|warning|info|none] [--fix]
                [--checks id,id... | --skip id,id...]
                [--llm anthropic:<model>|openai:<model>|ollama:<model>] [--llm-fixes N]
                [--coverage report]... [--baseline file | --no-baseline] [--no-analyzers] [--no-confirm]
                                                 verified models (state machines, resource lifecycles,
                                                 design patterns, architecture), code quality (duplicated
                                                 code, complexity, naming, dependencies, coverage), the
                                                 installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani);
                                                 exit 5 on findings at --fail-on beyond the baseline
  pflow review <dir> [--base <git-ref>] [--files] [--new-only] [--mutate N] [--coverage report]...
               [--fix] [--github] [--check-run] [--github-out file] [--state dir] [--fail-on ...]
                                                 the findings on the lines changed since --base; --new-only
                                                 drops those the base already had; --mutate mutation-tests
                                                 N changed lines; --github posts a pull-request review
                                                 (new findings only on later pushes), --check-run a check
                                                 run; --github-out writes the review to a file (forks)
  pflow post-review <review.json>                posts a review written by --github-out (a trusted
                                                 workflow, after the fork's run)
  pflow baseline <dir> [-o file] [--update]      accept today's findings (provenflow-baseline.json): only
                                                 new ones fail; --update only removes what is fixed
  pflow compare <dir> (--base <git-ref> | --before <dir>) [-o report.md] [--json] [--analyzers]
                                                 quality of two versions side by side: duplication,
                                                 complexity, findings fixed and introduced
  pflow mutate <dir> [--base <git-ref>] [--max N] [--test command]
                                                 mutation testing of the changed lines (one mutant per line)
  pflow init <dir> [-o file] [--force] [--instructions --llm provider:model [--base ref]]
                                                 propose provenflow.config.json from the code and the
                                                 languages' coding standards; --instructions also turns
                                                 the checkable rules of AGENTS.md, CLAUDE.md... into config

Coding agents:
  pflow mcp                                      MCP server (stdio): project_conventions,
                                                 find_existing_code, review_changes, propose_fix
  pflow hook <post-edit|stop>                    Claude Code hook: exit 2 with the findings of the
                                                 uncommitted changes, for the agent to fix`;

type CodeCommand = (dir: string, values: Values) => Promise<number>;

const CODE_COMMANDS: Record<string, CodeCommand> = {
    extract: extractCommand,
    review: reviewCommand,
    baseline: baselineCommand,
    compare: compareCommand,
    mutate: mutateCommand,
    init: initCommand,
    'post-review': file => postReviewCommand(file)
};

async function main(): Promise<number> {
    const { positionals, values } = parse(process.argv.slice(2));
    const [command, ...rest] = positionals;
    if (command === 'mcp') {
        await serveMcp();
        return 0;
    }
    if (command === 'hook' && rest[0]) return hookCommand(rest[0]);
    if (command === 'catalogue') return catalogueCommand(values, rest[0]);
    // pflow export <framework> <diagram>: the diagram is the second argument.
    const framework = command === 'export' ? rest.shift() : undefined;
    const [file, second] = rest;
    if (values.help || !command || !file) {
        console.log(USAGE);
        return values.help ? 0 : 2;
    }
    if (command in CODE_COMMANDS) return CODE_COMMANDS[command](file, values);
    if (isDiagramCommand(command)) return diagramCommand(command, file, values, second, framework);
    console.error(USAGE);
    return 2;
}

main().then(
    code => process.exit(code),
    error => {
        console.error((error as Error).message);
        process.exit(1);
    }
);
