/** The `pflow` commands on a .pflow diagram: generate, check, python, notebook, pytest, export, prob, prism, nurv, conform, and import. */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyse, checkConformance, exportPrism, exportToFramework, FRAMEWORKS, generateNotebook, generatePython, generatePythonTests, generateSmv, importGraph, matchResults, parseDiagram, parseTrace, serializeDiagram, type DiagramModel, type Framework, type ProbabilisticQuery } from '@provenflow/language';
import { nurvExecutable, runNurv } from '../nurv-runner.js';
import { configFromEnv, ENGINES, runNuxmv, type Engine } from '../nuxmv-runner.js';
import type { Values } from './shared.js';

interface Diagram {
    file: string;
    model: DiagramModel;
    smv: string;
    values: Values;
    second?: string;
    framework?: string;
}

type DiagramCommand = (d: Diagram) => Promise<number>;

async function output(values: Values, text: string, fallback?: string): Promise<void> {
    const target = values.output ?? fallback;
    if (target) await writeFile(target, text, 'utf8');
    else process.stdout.write(text);
}

/** Counterexamples of the false properties, for the notebook and the property-based tests. */
async function counterexamples(d: Diagram): Promise<{ verdicts: Array<string | undefined>; traces: Array<{ property: string; states: string[]; loopStart?: number }> }> {
    const result = await runNuxmv(d.smv, { engine: 'bdd' }, configFromEnv());
    result.errors.forEach(e => console.error(e));
    const matched = matchResults(d.model.specs, result.results);
    return {
        verdicts: matched.map(r => r?.verdict),
        traces: matched.flatMap((r, i) => (r?.trace ? [{ property: d.model.specs[i].name ?? d.model.specs[i].expression, states: r.trace.steps.map(s => s.values['state'] ?? ''), loopStart: r.trace.loopStart }] : []))
    };
}

const COMMANDS: Record<string, DiagramCommand> = {
    generate: async d => {
        await output(d.values, d.smv);
        return 0;
    },
    python: async d => {
        await output(d.values, (await generatePython(d.model, { sourceName: d.file })).code);
        return 0;
    },
    notebook: async d => {
        const verified = d.values.verify ? await counterexamples(d) : undefined;
        const { notebook, python } = await generateNotebook(d.model, { sourceName: d.file, verdicts: verified?.verdicts, counterexamples: verified?.traces });
        const out = d.values.output ?? `${python.moduleName}.ipynb`;
        await writeFile(out, notebook, 'utf8');
        console.log(`wrote ${out}`);
        return 0;
    },
    pytest: async d => {
        const verified = d.values.verify ? await counterexamples(d) : undefined;
        const tests = await generatePythonTests(d.model, { sourceName: d.file, counterexamples: verified?.traces.map(({ property, states }) => ({ property, states })) });
        const out = d.values.output ?? tests.fileName;
        await writeFile(out, tests.code, 'utf8');
        console.log(`wrote ${out}`);
        return 0;
    },
    export: async d => {
        if (!FRAMEWORKS.some(f => f.id === d.framework)) throw new Error(`Unknown framework '${d.framework}'. Use one of ${FRAMEWORKS.map(f => f.id).join(', ')}.`);
        const out = await exportToFramework(d.model, d.framework as Framework);
        const target = d.values.output ?? out.fileName;
        await writeFile(target, out.code, 'utf8');
        console.log(`wrote ${target}${out.requires.length ? ` (needs ${out.requires.join(', ')}: pflow python ${d.file})` : ''}`);
        return 0;
    },
    prism: async d => {
        const out = await exportPrism(d.model, queries(d.values));
        const target = d.values.output ?? `${(d.model.name ?? 'main').toLowerCase()}.pm`;
        await writeFile(target, out.model, 'utf8');
        await writeFile(target.replace(/\.pm$/, '') + '.pctl', out.properties, 'utf8');
        console.log(`wrote ${target} and ${target.replace(/\.pm$/, '')}.pctl`);
        return 0;
    },
    prob: async d => {
        const asked = queries(d.values);
        if (asked.length === 0) throw new Error('Give at least one query, e.g. --reach "phase = done".');
        const { dtmc, results } = await analyse(d.model, asked);
        console.log(`${dtmc.configurations.length} configuration(s)${dtmc.normalised ? ' (some probabilities filled in or normalised)' : ''}`);
        for (const r of results) console.log(r.description);
        return 0;
    },
    nurv: async d => {
        const executable = nurvExecutable();
        if (!executable) throw new Error('Set NURV_PATH to the NuRV executable (https://es-static.fbk.eu/tools/nurv/).');
        const result = await runNurv(d.model, executable);
        const dir = d.values.output ?? '.';
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
    },
    conform: async d => {
        if (!d.second) throw new Error('Usage: pflow conform <diagram.pflow> <run.jsonl|otel.json>');
        const records = parseTrace(await readFile(d.second, 'utf8'));
        const report = await checkConformance(d.model, records);
        for (const issue of report.issues) console.log(`step ${issue.step}: ${issue.kind}: ${issue.message}`);
        console.log(`${records.length} step(s), ${report.issues.length} issue(s); monitored: ${report.monitored.join(', ') || 'none'}`);
        return report.conforms ? 0 : 4;
    },
    check: checkCommand
};

function queries(values: Values): ProbabilisticQuery[] {
    return [
        ...(values.reach ?? []).map(target => ({ kind: 'reach' as const, target, ...(values.within ? { bound: Number(values.within) } : {}) })),
        ...(values.steps ?? []).map(target => ({ kind: 'steps' as const, target })),
        ...(values.visits && values.until ? [{ kind: 'visits' as const, count: values.visits, target: values.until }] : [])
    ];
}

async function checkCommand(d: Diagram): Promise<number> {
    const engine = d.values.engine as Engine;
    if (!ENGINES.includes(engine)) throw new Error(`Unknown engine '${engine}'.`);
    const result = await runNuxmv(d.smv, { engine, bound: Number(d.values.bound) }, configFromEnv());
    result.errors.forEach(e => console.error(e));
    const matched = matchResults(d.model.specs, result.results);
    let failed = false;
    d.model.specs.forEach((spec, i) => {
        const r = matched[i];
        const verdict = r?.verdict ?? 'not checked';
        if (verdict === 'false') failed = true;
        console.log(`${verdict.padEnd(11)} ${spec.kind} ${spec.name ? spec.name + ' := ' : ''}${spec.expression}${r?.detail ? `  (${r.detail})` : ''}`);
        r?.trace?.steps.forEach((step, n) => console.log(`              ${step.id}: state = ${step.values['state'] ?? '?'}${r.trace?.loopStart === n ? '  <- loop starts' : ''}`));
    });
    return result.errors.length > 0 ? 1 : failed ? 3 : 0;
}

export function isDiagramCommand(command: string): boolean {
    return command in COMMANDS || command === 'import';
}

export async function diagramCommand(command: string, file: string, values: Values, second?: string, framework?: string): Promise<number> {
    if (command === 'import') {
        const result = importGraph(await readFile(file, 'utf8'));
        result.notes.forEach(n => console.error(`note: ${n}`));
        await output(values, serializeDiagram(result.model));
        return 0;
    }
    const parsed = await parseDiagram(await readFile(file, 'utf8'));
    for (const d of parsed.diagnostics) {
        if (d.severity === 'error' || d.severity === 'warning') console.error(`${file}:${d.line}:${d.column}: ${d.severity}: ${d.message}`);
    }
    if (parsed.hasErrors) return 1;
    return COMMANDS[command]({ file, model: parsed.model, smv: generateSmv(parsed.model).text, values, second, framework });
}
