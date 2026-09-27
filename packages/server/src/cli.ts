#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { analyse, checkConformance, exportPrism, exportToFramework, importGraph, serializeDiagram, type ProbabilisticQuery, FRAMEWORKS, generateNotebook, generatePython, generatePythonTests, generateSmv, matchResults, parseDiagram, parseTrace, type Framework } from '@provenflow/language';
import { changedLines, extractProject, formatFindings, githubTargetFromEnv, onChanged, postGithubReview, providerFromSpec, reviewComments, reviewSummary, summary, writeOutputs } from '@provenflow/extract';
import { readFileSync } from 'node:fs';
import { configFromEnv, ENGINES, nuxmvInfo, runNuxmv, type Engine } from './nuxmv-runner.js';
import { nurvExecutable, runNurv } from './nurv-runner.js';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  pflow extract <project-dir> [-o dir] [--config file] [--fail-on error|warning|none]
                [--fix] [--llm anthropic:<model>|openai:<model>|ollama:<model>] [--llm-fixes N]
                [--no-analyzers] [--no-confirm]
                                                 extract verified models of a code base (state machines,
                                                 resource lifecycles, design patterns, architecture) and
                                                 report bugs with fixes (exit 5 on findings at --fail-on);
                                                 --fix proposes verified code changes (report.md, fixes/).
                                                 Runs the installed Semgrep, Infer, ESBMC/CBMC, Kani
                                                 (--no-analyzers skips them) and replays counterexamples
                                                 on the code (--no-confirm skips it).
                                                 TypeScript, Python, Java, Kotlin, Groovy, Scala, C, C++,
                                                 C#, Go, Rust, Swift, Ruby, PHP, R
  pflow review <project-dir> [--base <git-ref>] [--files] [--fix] [--github] [--fail-on error|warning|none]
                                                 review a change: the findings on the lines changed since
                                                 --base (all when omitted); --github posts them as a pull
                                                 request review with verified fixes as suggestions`;

async function main(): Promise<number> {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            output: { type: 'string', short: 'o' },
            engine: { type: 'string', default: 'bdd' },
            bound: { type: 'string', default: '10' },
            help: { type: 'boolean', short: 'h' },
            verify: { type: 'boolean', default: false },
            reach: { type: 'string', multiple: true },
            within: { type: 'string' },
            steps: { type: 'string', multiple: true },
            visits: { type: 'string' },
            until: { type: 'string' },
            config: { type: 'string' },
            'fail-on': { type: 'string', default: 'error' },
            llm: { type: 'string' },
            'llm-fixes': { type: 'string', default: '0' },
            fix: { type: 'boolean', default: false },
            quiet: { type: 'boolean', short: 'q', default: false },
            base: { type: 'string' },
            files: { type: 'boolean', default: false },
            github: { type: 'boolean', default: false },
            'no-analyzers': { type: 'boolean', default: false },
            'no-confirm': { type: 'boolean', default: false }
        }
    });
    const [command, ...rest] = positionals;
    // pflow export <framework> <diagram>: the diagram is the second argument.
    const framework = command === 'export' ? rest.shift() : undefined;
    const [file, second] = rest;
    if (values.help || !command || !file) {
        console.log(USAGE);
        return values.help ? 0 : 2;
    }

    if (command === 'extract') {
        const nuxmv = configFromEnv();
        const available = (await nuxmvInfo(nuxmv)).available;
        const engine = values.engine as Engine;
        const checker = available ? (smv: string) => runNuxmv(smv, { engine, bound: Number(values.bound) }, nuxmv) : undefined;
        const result = await extractProject(file, {
            configFile: values.config,
            checker,
            llm: values.llm ? providerFromSpec(values.llm) : undefined,
            llmFixes: Number(values['llm-fixes']),
            quickFixes: values.fix ? 50 : 0,
            analyzers: !values['no-analyzers'],
            confirm: !values['no-confirm']
        });
        const out = values.output ?? join(file, '.provenflow', 'extract');
        const written = writeOutputs(result, out);
        const counts = summary(result);
        if (!values.quiet) console.log(formatFindings(result, 'warning'));
        result.notes.forEach(n => console.error(`note: ${n}`));
        console.log(
            `${result.files} files, ${result.models.length} models, ${result.verdicts.length} properties (${available ? 'nuXmv' : 'explicit-state; set NUXMV_PATH for nuXmv'}): ` +
                `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} note(s). Report: ${written.report}`
        );
        const failOn = values['fail-on'];
        const failing = failOn === 'none' ? 0 : failOn === 'warning' ? counts.error + counts.warning : counts.error;
        return failing > 0 ? 5 : 0;
    }

    if (command === 'review') {
        const nuxmv = configFromEnv();
        const available = (await nuxmvInfo(nuxmv)).available;
        const result = await extractProject(file, {
            configFile: values.config,
            checker: available ? (smv: string) => runNuxmv(smv, { engine: values.engine as Engine, bound: Number(values.bound) }, nuxmv) : undefined,
            quickFixes: values.fix ? 50 : 0,
            llm: values.llm ? providerFromSpec(values.llm) : undefined,
            llmFixes: Number(values['llm-fixes']),
            analyzers: !values['no-analyzers'],
            confirm: !values['no-confirm']
        });
        const base = values.base ?? githubBase();
        const changed = base ? changedLines(file, base) : undefined;
        const relevant = changed ? onChanged(result.findings, changed, values.files ? 'files' : 'lines') : result.findings;
        const read = (f: string) => {
            try {
                return readFileSync(join(file, f), 'utf8');
            } catch {
                return undefined;
            }
        };
        const comments = changed ? reviewComments(relevant, changed, read) : [];
        const body = reviewSummary(result, relevant, comments.length, base);
        console.log(body);
        if (!values.quiet) console.log(formatFindings({ ...result, findings: relevant }, 'warning'));
        if (values.github) {
            const target = githubTargetFromEnv();
            if (!target) {
                console.error('--github: not in a GitHub Actions pull_request run (GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are needed).');
                return 1;
            }
            try {
                const posted = await postGithubReview(target, body, comments);
                console.log(`Posted a review with ${posted.posted} inline comment(s)${posted.url ? `: ${posted.url}` : ''}.`);
            } catch (error) {
                // e.g. a pull request from a fork, whose token cannot write reviews: the log still has the findings.
                console.error(`warning: ${(error as Error).message}`);
            }
        }
        const count = (s: string) => relevant.filter(f => f.severity === s).length;
        const failOn = values['fail-on'];
        const failing = failOn === 'none' ? 0 : failOn === 'warning' ? count('error') + count('warning') : count('error');
        return failing > 0 ? 5 : 0;
    }

    if (command === 'import') {
        const result = importGraph(await readFile(file, 'utf8'));
        result.notes.forEach(n => console.error(`note: ${n}`));
        const text = serializeDiagram(result.model);
        if (values.output) await writeFile(values.output, text, 'utf8');
        else process.stdout.write(text);
        return 0;
    }
    const parsed = await parseDiagram(await readFile(file, 'utf8'));
    for (const d of parsed.diagnostics) {
        if (d.severity === 'error' || d.severity === 'warning') console.error(`${file}:${d.line}:${d.column}: ${d.severity}: ${d.message}`);
    }
    if (parsed.hasErrors) return 1;
    const { text } = generateSmv(parsed.model);

    if (command === 'generate') {
        if (values.output) await writeFile(values.output, text, 'utf8');
        else process.stdout.write(text);
        return 0;
    }
    if (command === 'python') {
        const py = await generatePython(parsed.model, { sourceName: file });
        if (values.output) await writeFile(values.output, py.code, 'utf8');
        else process.stdout.write(py.code);
        return 0;
    }
    if (command === 'notebook') {
        let verdicts: Array<string | undefined> | undefined;
        let counterexamples: Array<{ property: string; states: string[]; loopStart?: number }> | undefined;
        if (values.verify) {
            const result = await runNuxmv(text, { engine: 'bdd' }, configFromEnv());
            result.errors.forEach(e => console.error(e));
            const matched = matchResults(parsed.model.specs, result.results);
            verdicts = matched.map(r => r?.verdict);
            counterexamples = matched.flatMap((r, i) =>
                r?.trace
                    ? [{ property: parsed.model.specs[i].name ?? parsed.model.specs[i].expression, states: r.trace.steps.map(s => s.values['state'] ?? ''), loopStart: r.trace.loopStart }]
                    : []
            );
        }
        const { notebook, python } = await generateNotebook(parsed.model, { sourceName: file, verdicts, counterexamples });
        const out = values.output ?? `${python.moduleName}.ipynb`;
        await writeFile(out, notebook, 'utf8');
        console.log(`wrote ${out}`);
        return 0;
    }
    if (command === 'pytest') {
        let counterexamples: Array<{ property: string; states: string[] }> | undefined;
        if (values.verify) {
            const result = await runNuxmv(text, { engine: 'bdd' }, configFromEnv());
            const matched = matchResults(parsed.model.specs, result.results);
            counterexamples = matched.flatMap((r, i) => (r?.trace ? [{ property: parsed.model.specs[i].name ?? parsed.model.specs[i].expression, states: r.trace.steps.map(s => s.values['state'] ?? '') }] : []));
        }
        const tests = await generatePythonTests(parsed.model, { sourceName: file, counterexamples });
        const out = values.output ?? tests.fileName;
        await writeFile(out, tests.code, 'utf8');
        console.log(`wrote ${out}`);
        return 0;
    }
    if (command === 'export') {
        if (!FRAMEWORKS.some(f => f.id === framework)) throw new Error(`Unknown framework '${framework}'. Use one of ${FRAMEWORKS.map(f => f.id).join(', ')}.`);
        const out = await exportToFramework(parsed.model, framework as Framework);
        const target = values.output ?? out.fileName;
        await writeFile(target, out.code, 'utf8');
        console.log(`wrote ${target}${out.requires.length ? ` (needs ${out.requires.join(', ')}: pflow python ${file})` : ''}`);
        return 0;
    }
    if (command === 'prob' || command === 'prism') {
        const queries: ProbabilisticQuery[] = [
            ...(values.reach ?? []).map(target => ({ kind: 'reach' as const, target, ...(values.within ? { bound: Number(values.within) } : {}) })),
            ...(values.steps ?? []).map(target => ({ kind: 'steps' as const, target })),
            ...(values.visits && values.until ? [{ kind: 'visits' as const, count: values.visits, target: values.until }] : [])
        ];
        if (command === 'prism') {
            const out = await exportPrism(parsed.model, queries);
            const target = values.output ?? `${(parsed.model.name ?? 'main').toLowerCase()}.pm`;
            await writeFile(target, out.model, 'utf8');
            await writeFile(target.replace(/\.pm$/, '') + '.pctl', out.properties, 'utf8');
            console.log(`wrote ${target} and ${target.replace(/\.pm$/, '')}.pctl`);
            return 0;
        }
        if (queries.length === 0) throw new Error('Give at least one query, e.g. --reach "phase = done".');
        const { dtmc, results } = await analyse(parsed.model, queries);
        console.log(`${dtmc.configurations.length} configuration(s)${dtmc.normalised ? ' (some probabilities filled in or normalised)' : ''}`);
        for (const r of results) console.log(r.description);
        return 0;
    }
    if (command === 'nurv') {
        const executable = nurvExecutable();
        if (!executable) throw new Error('Set NURV_PATH to the NuRV executable (https://es-static.fbk.eu/tools/nurv/).');
        const result = await runNurv(parsed.model, executable);
        const dir = values.output ?? '.';
        await mkdir(dir, { recursive: true });
        for (const [name, content] of Object.entries(result.files)) await writeFile(join(dir, name), content, 'utf8');
        for (const cmd of result.build) {
            const [cc, ...args] = cmd.split(' ');
            const r = spawnSync(cc, args, { cwd: dir, stdio: 'inherit' });
            console.log(r.status === 0 ? `built: ${cmd}` : `could not run '${cmd}' (build it yourself in ${dir})`);
        }
        for (const m of result.monitors) console.log(`monitor ${m.module}: LTLSPEC ${m.name} := ${m.expression}   ->   fsm.add_nurv_monitor(${m.module})`);
        if (result.monitors.length === 0) console.log(result.log);
        return 0;
    }
    if (command === 'conform') {
        if (!second) throw new Error('Usage: pflow conform <diagram.pflow> <run.jsonl|otel.json>');
        const records = parseTrace(await readFile(second, 'utf8'));
        const report = await checkConformance(parsed.model, records);
        for (const issue of report.issues) console.log(`step ${issue.step}: ${issue.kind}: ${issue.message}`);
        console.log(`${records.length} step(s), ${report.issues.length} issue(s); monitored: ${report.monitored.join(', ') || 'none'}`);
        return report.conforms ? 0 : 4;
    }
    if (command === 'check') {
        const engine = values.engine as Engine;
        if (!ENGINES.includes(engine)) throw new Error(`Unknown engine '${engine}'.`);
        const result = await runNuxmv(text, { engine, bound: Number(values.bound) }, configFromEnv());
        result.errors.forEach(e => console.error(e));
        const matched = matchResults(parsed.model.specs, result.results);
        let failed = false;
        parsed.model.specs.forEach((spec, i) => {
            const r = matched[i];
            const verdict = r?.verdict ?? 'not checked';
            if (verdict === 'false') failed = true;
            console.log(`${verdict.padEnd(11)} ${spec.kind} ${spec.name ? spec.name + ' := ' : ''}${spec.expression}${r?.detail ? `  (${r.detail})` : ''}`);
            if (r?.trace) {
                r.trace.steps.forEach((step, n) => {
                    const loop = r.trace?.loopStart === n ? '  <- loop starts' : '';
                    console.log(`              ${step.id}: state = ${step.values['state'] ?? '?'}${loop}`);
                });
            }
        });
        return result.errors.length > 0 ? 1 : failed ? 3 : 0;
    }
    console.error(USAGE);
    return 2;
}

/** The base of the pull request in a GitHub Actions run. */
function githubBase(): string | undefined {
    try {
        const path = process.env['GITHUB_EVENT_PATH'];
        const event = path ? (JSON.parse(readFileSync(path, 'utf8')) as { pull_request?: { base?: { sha?: string } } }) : undefined;
        return event?.pull_request?.base?.sha;
    } catch {
        return undefined;
    }
}

main().then(
    code => process.exit(code),
    error => {
        console.error((error as Error).message);
        process.exit(1);
    }
);
