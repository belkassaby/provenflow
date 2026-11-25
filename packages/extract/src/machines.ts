/**
 * State machines of the code: one model per state variable (a field or
 * variable typed as a finite set of values) and per machine declared with a
 * library (XState, LangGraph, CrewAI, python-transitions).
 */
import { importGraph } from '@provenflow/language';
import type { ProvenflowConfig } from './config.js';
import { formatLocation, type Facts, type StateVariableFact, type StateWriteFact } from './ir.js';
import { looksTerminal, ModelBuilder, slug, type ExtractedModel, type Finding } from './models.js';

export interface MachinesResult {
    models: ExtractedModel[];
    findings: Finding[];
    /** Writes whose value is not a literal: the part an LLM can help resolve. */
    dynamicWrites: StateWriteFact[];
}

export function buildStateMachines(facts: Facts, config: ProvenflowConfig): MachinesResult {
    const models: ExtractedModel[] = [];
    const findings: Finding[] = [];
    const dynamicWrites: StateWriteFact[] = [];
    const used = new Set<string>();
    const uniqueId = (base: string) => {
        let id = slug(base);
        for (let i = 2; used.has(id); i++) id = `${slug(base)}_${i}`;
        used.add(id);
        return id;
    };

    for (const variable of facts.stateVariables) {
        const settings = config.machines?.[variable.name];
        if (settings?.ignore) continue;
        const writes = facts.writes.filter(w => w.variable === variable.id);
        const result = machineOf(variable, writes, facts, config, uniqueId(`machine-${variable.name}`));
        models.push(result.model);
        findings.push(...result.findings);
        dynamicWrites.push(...writes.filter(w => w.targets === null || w.incomplete));
    }

    for (const declared of facts.declaredMachines) {
        const id = uniqueId(`machine-${declared.name}`);
        const b = new ModelBuilder(id, 'state-machine', `${declared.library} machine ${declared.name}`, declared.loc);
        if (declared.text) {
            try {
                const imported = importGraph(declared.text);
                const initial = new Set(imported.model.states.filter(s => s.initial).map(s => s.name));
                for (const s of imported.model.states) b.state(s.name, initial.has(s.name));
                for (const t of imported.model.transitions) b.transition(t.source, t.target, { event: t.label ?? 'transition', loc: declared.loc });
                b.notes.push(...imported.notes);
            } catch (error) {
                findings.push({ rule: 'machine-not-imported', category: 'state-machine', severity: 'info', subject: declared.name, message: `Could not read the ${declared.library} machine: ${(error as Error).message}`, fix: 'Check the definition is static (no computed states or transitions).', loc: declared.loc, source: 'analysis' });
                continue;
            }
        } else {
            for (const s of declared.states ?? []) b.state(s, s === declared.initial);
            for (const t of declared.transitions ?? []) b.transition(t.source, t.target, { event: t.event ?? 'transition', loc: t.line ? { file: declared.loc.file, line: t.line } : declared.loc });
        }
        const declaredTerminal = config.machines?.[declared.name]?.terminal ?? b.states.filter(s => looksTerminal(s));
        addStandardSpecs(b, b.states, b.states.filter(s => looksTerminal(s)), config.machines?.[declared.name]?.terminal, declared.name, config.machines?.[declared.name]?.specs ?? [], declared.loc, false);
        const built = b.build();
        built.terminal = declaredTerminal;
        built.configKey = declared.name;
        models.push(built);
    }
    return { models, findings, dynamicWrites };
}

function machineOf(variable: StateVariableFact, writes: StateWriteFact[], facts: Facts, config: ProvenflowConfig, id: string): { model: ExtractedModel; findings: Finding[] } {
    const findings: Finding[] = [];
    const settings = config.machines?.[variable.name];
    const b = new ModelBuilder(id, 'state-machine', variable.name, variable.loc);
    const domain = [...variable.values];
    for (const w of writes) for (const t of w.targets ?? []) if (!domain.includes(t)) domain.push(t);

    let initial = variable.initial.filter(v => domain.includes(v));
    if (initial.length === 0) {
        initial = ['unset'];
        b.notes.push('No initial value found in the code: the machine starts in the synthetic state `unset`.');
    }
    initial.forEach(v => b.state(v, true));
    for (const v of domain) b.state(v);

    const events = new Set(writes.map(w => w.event.replace(/ \(callback\)$/, '')));
    for (const w of writes) {
        if (!w.targets) continue;
        let sources = w.sources;
        const concurrent = [...events].some(e => e !== w.event.replace(/ \(callback\)$/, ''));
        if (w.afterAwait && sources && concurrent) {
            findings.push({
                rule: 'stale-write-after-await',
                category: 'state-machine',
                severity: 'warning',
                subject: variable.name,
                message: `${w.event} sets ${variable.name} to ${w.targets.join('/')} after an await, relying on a check made before it; other code (${[...events].filter(e => e !== w.event.replace(/ \(callback\)$/, '')).slice(0, 3).join(', ')}) can change ${variable.name} meanwhile.`,
                fix: `Re-check the state after the await before writing, e.g. \`if (${variable.name.split('.').pop()} !== '${sources[0]}') return;\`, or keep a request id and ignore stale completions.`,
                loc: w.loc,
                model: id,
                source: 'analysis'
            });
            sources = null;
        }
        const from = sources ?? b.states.filter(s => s !== 'unset' || initial.includes('unset'));
        for (const source of from) {
            for (const target of w.targets) {
                if (source === target && !sources) continue;
                b.transition(source, target, { event: w.event, loc: w.loc, text: w.text });
            }
        }
    }

    // A write whose values are unknown leaves values out of the model: what it cannot reach or leave
    // says nothing about the code, so those properties are not checked (the user's own still are).
    const dynamic = writes.filter(w => w.targets === null || w.incomplete);
    if (dynamic.length > 0) {
        b.notes.push(
            `${dynamic.length} write(s) with a computed value are not (fully) in the model: ${dynamic.slice(0, 3).map(w => formatLocation(w.loc)).join(', ')}${dynamic.length > 3 ? ', ...' : ''}. Reachability, stuck states and settling are not checked until they are known (run with --llm to resolve them).`
        );
    }

    // Values the code compares against: a declared value never set makes that branch dead code.
    const reads = facts.reads.filter(r => r.variable === variable.id);
    const values = variable.inferred ? domain : variable.values;
    const terminal = settings?.terminal ?? domain.filter(looksTerminal);
    addStandardSpecs(b, values, terminal, undefined, variable.name, settings?.specs ?? [], variable.loc, dynamic.length > 0, reads);

    // `switch`/`match` over the variable that forgets values.
    for (const sw of facts.switches.filter(s => s.variable === variable.id)) {
        const missing = sw.domain.filter(v => !sw.cases.includes(v));
        if (missing.length > 0 && !sw.hasDefault) {
            findings.push({
                rule: 'unhandled-state',
                category: 'state-machine',
                severity: 'warning',
                subject: variable.name,
                message: `The switch over ${sw.subject} in ${sw.event} has no case for ${missing.map(v => `'${v}'`).join(', ')} and no default.`,
                fix: `Add case(s) for ${missing.join(', ')}, or a default that fails loudly (an exhaustive check such as \`const never: never = value\`).`,
                loc: sw.loc,
                model: id,
                source: 'analysis'
            });
        }
    }

    // States the code can reach but never leave, without being a resting state.
    const model = b.build();
    const withSuccessor = new Set(model.model.transitions.filter(t => t.source !== t.target).map(t => t.source));
    const reachable = reachableStates(model);
    for (const s of model.model.states) {
        const value = model.values[s.name] ?? s.name;
        if (dynamic.length > 0 || !reachable.has(s.name) || withSuccessor.has(s.name) || terminal.includes(value) || value === 'unset') continue;
        findings.push({
            rule: 'stuck-state',
            category: 'state-machine',
            severity: 'warning',
            subject: variable.name,
            message: `Once ${variable.name} is '${value}' no code changes it again, and '${value}' does not look like a final state.`,
            fix: `Add the transition out of '${value}' (a reset, retry or cancel), or list it in provenflow.config.json under machines["${variable.name}"].terminal if it is final.`,
            loc: variable.loc,
            model: id,
            source: 'graph',
            states: [value]
        });
    }
    model.terminal = terminal;
    model.configKey = variable.name;
    model.variableId = variable.id;
    return { model, findings };
}

/** Reachability of every value, "can always settle" and the user's own properties. */
function addStandardSpecs(
    b: ModelBuilder,
    values: string[],
    terminal: string[],
    configuredTerminal: string[] | undefined,
    name: string,
    extraSpecs: string[],
    loc: StateVariableFact['loc'],
    hasDynamicWrites: boolean,
    reads: Facts['reads'] = []
): void {
    for (const value of hasDynamicWrites ? [] : values) {
        if (!b.has(value)) continue;
        const tested = reads.find(r => r.values.includes(value));
        b.spec('CTLSPEC', `reach_${b.idOf(value)}`, `EF state = ${b.idOf(value)}`, {
            rule: 'unreachable-state',
            category: 'state-machine',
            severity: 'warning',
            message: tested
                ? `${name} is compared with '${value}' (${formatLocation(tested.loc)}) but no code path sets it to '${value}': that branch is dead code.`
                : `'${value}' is a declared value of ${name} but no code path sets it.`,
            fix: tested
                ? `Either add the code that moves ${name} to '${value}', or remove '${value}' and the dead branch at ${formatLocation(tested.loc)}.`
                : `Remove '${value}' from the type of ${name}, or add the transition that sets it.`,
            loc: tested?.loc ?? loc,
            fallback: 'reach',
            states: [value]
        });
    }
    // 'unset' (a field declared without a value) is where the variable starts, not a state to come back to.
    const rest = [...new Set([...(configuredTerminal ?? terminal), ...b.states.filter(s => isInitial(b, s))])].filter(v => b.has(v) && v !== 'unset');
    if (!hasDynamicWrites && rest.length > 0 && b.states.length > 1) {
        b.spec('CTLSPEC', 'can_settle', `AG EF (${b.anyOf(rest)})`, {
            rule: 'cannot-settle',
            category: 'state-machine',
            severity: 'warning',
            message: `${name} can reach a state from which it never gets back to ${rest.map(v => `'${v}'`).join(', ')}.`,
            fix: `Follow the counterexample to the last state and add a way out of it (reset, cancel, error handling), or declare the states where ${name} may stop in provenflow.config.json (machines["${name}"].terminal).`,
            loc,
            fallback: 'settle',
            states: rest
        });
    }
    extraSpecs.forEach((expression, i) => {
        const kind = /^\s*(AG|AF|AX|EG|EF|EX|A\s*\[|E\s*\[)/.test(expression) ? 'CTLSPEC' : 'LTLSPEC';
        b.spec(kind, `config_${i + 1}`, rewriteValues(b, expression), {
            rule: 'property-violated',
            category: 'state-machine',
            severity: 'error',
            message: `${name} violates the property declared in provenflow.config.json: ${expression}`,
            fix: 'Follow the counterexample: the transition that breaks the property is the code to change (or the property is wrong).',
            loc
        });
    });
}

function isInitial(b: ModelBuilder, value: string): boolean {
    const id = b.idOf(value);
    return !!id && b.build().model.states.some(s => s.name === id && s.initial);
}

/** Lets properties use the code values (`state = 'no-machine'`) as well as model ids. */
function rewriteValues(b: ModelBuilder, expression: string): string {
    return expression.replace(/state\s*(!?=)\s*'([^']*)'/g, (_, op: string, value: string) => `state ${op} ${b.idOf(value) ?? value}`);
}

export function reachableStates(m: ExtractedModel): Set<string> {
    const seen = new Set(m.model.states.filter(s => s.initial).map(s => s.name));
    if (seen.size === 0 && m.model.states[0]) seen.add(m.model.states[0].name);
    const queue = [...seen];
    while (queue.length) {
        const s = queue.shift()!;
        for (const t of m.model.transitions) {
            if (t.source === s && !seen.has(t.target)) {
                seen.add(t.target);
                queue.push(t.target);
            }
        }
    }
    return seen;
}
