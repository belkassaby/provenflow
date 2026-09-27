/**
 * Verification of the extracted models: nuXmv when available (any engine
 * through the `Checker` callback), otherwise an explicit-state check of the
 * standard properties. Every false property becomes a finding whose
 * counterexample is replayed as code events with their locations.
 */
import { generateSmv, matchResults, type NuxmvOutput, type Trace } from '@provenflow/language';
import type { CounterexampleStep, ExtractedModel, Finding, SpecOrigin } from './models.js';

/** Runs nuXmv on a model and returns its parsed output. */
export type Checker = (smv: string) => Promise<NuxmvOutput>;

export interface SpecVerdict {
    model: string;
    spec: string;
    expression: string;
    verdict: 'true' | 'false' | 'unknown';
    by: 'nuxmv' | 'explicit' | 'none';
}

export interface VerificationResult {
    findings: Finding[];
    verdicts: SpecVerdict[];
    errors: string[];
}

export async function verifyModels(models: ExtractedModel[], checker?: Checker, onModel?: (model: ExtractedModel, index: number, total: number) => Promise<void>): Promise<VerificationResult> {
    const result: VerificationResult = { findings: [], verdicts: [], errors: [] };
    for (const [index, m] of models.entries()) {
        if (m.model.specs.length === 0) continue;
        await onModel?.(m, index, models.length);
        let traces: Array<{ verdict: 'true' | 'false' | 'unknown'; trace?: Trace }> | undefined;
        if (checker) {
            try {
                const output = await checker(generateSmv(m.model).text);
                if (output.errors.length > 0) {
                    result.errors.push(`${m.id}: ${output.errors[0]}`);
                } else {
                    traces = matchResults(m.model.specs, output.results).map(r => ({ verdict: r?.verdict ?? 'unknown', trace: r?.trace }));
                }
            } catch (error) {
                result.errors.push(`${m.id}: ${(error as Error).message}`);
            }
        }
        m.model.specs.forEach((spec, i) => {
            const origin = m.origins[spec.name ?? ''];
            let verdict: SpecVerdict['verdict'] = 'unknown';
            let by: SpecVerdict['by'] = 'none';
            let steps: CounterexampleStep[] | undefined;
            if (traces) {
                verdict = traces[i].verdict;
                by = 'nuxmv';
                if (verdict === 'false' && traces[i].trace) steps = replay(m, traces[i].trace!.steps.map(s => s.values['state']).filter(Boolean));
            } else if (origin?.fallback) {
                const explicit = explicitCheck(m, origin);
                verdict = explicit.holds ? 'true' : 'false';
                by = 'explicit';
                if (!explicit.holds && explicit.path) steps = replay(m, explicit.path);
            }
            result.verdicts.push({ model: m.id, spec: spec.name ?? `spec_${i + 1}`, expression: spec.expression, verdict, by });
            if (verdict === 'false' && origin) result.findings.push(toFinding(m, spec.name ?? '', spec.expression, origin, by === 'nuxmv' ? 'nuxmv' : 'graph', steps));
        });
    }
    return result;
}

function toFinding(m: ExtractedModel, name: string, expression: string, origin: SpecOrigin, source: Finding['source'], steps?: CounterexampleStep[]): Finding {
    let message = origin.message;
    if (steps && steps.length > 1) {
        message += ` Counterexample: ${steps.map(s => (s.event ? `${s.event} -> ${s.state}` : s.state)).join(', ')}.`;
    }
    return {
        rule: origin.rule,
        category: origin.category,
        severity: origin.severity,
        subject: m.subject,
        message,
        fix: origin.fix,
        loc: origin.loc,
        related: [...(origin.related ?? []), ...(steps?.map(s => s.loc).filter((l): l is NonNullable<typeof l> => !!l) ?? [])],
        model: m.id,
        spec: `${name} := ${expression}`,
        counterexample: steps,
        source,
        states: origin.states
    };
}

/** State ids of a trace -> code values with the event (and location) of each step. */
function replay(m: ExtractedModel, states: string[]): CounterexampleStep[] {
    const steps: CounterexampleStep[] = [];
    states.forEach((s, i) => {
        const prev = states[i - 1];
        const evidence = prev !== undefined ? m.evidence[`${prev}->${s}`]?.[0] : undefined;
        if (i > 0 && prev === s && !evidence) return; // stutter
        steps.push({ state: m.values[s] ?? s, event: evidence?.event, loc: evidence?.loc });
    });
    return steps;
}

// ---------------------------------------------------------- explicit checks

function explicitCheck(m: ExtractedModel, origin: SpecOrigin): { holds: boolean; path?: string[] } {
    const ids = (origin.states ?? []).map(v => idOf(m, v)).filter((x): x is string => !!x);
    const succ = new Map<string, string[]>();
    for (const s of m.model.states) succ.set(s.name, []);
    for (const t of m.model.transitions) succ.get(t.source)?.push(t.target);
    // Dead ends stutter, as in the generated nuXmv model.
    const stutter = new Set<string>();
    for (const [s, list] of succ) if (list.length === 0) {
        list.push(s);
        stutter.add(s);
    }
    const initials = m.model.states.filter(s => s.initial).map(s => s.name);
    if (initials.length === 0 && m.model.states[0]) initials.push(m.model.states[0].name);
    const paths = bfs(initials, succ);
    const reachable = [...paths.keys()];
    const canReach = (from: string, targets: Set<string>) => {
        const seen = bfs([from], succ);
        return [...seen.keys()].some(s => targets.has(s));
    };
    switch (origin.fallback) {
        case 'reach':
            return { holds: ids.every(s => paths.has(s)) };
        case 'avoid': {
            const bad = ids.find(s => paths.has(s));
            return bad ? { holds: false, path: paths.get(bad) } : { holds: true };
        }
        case 'settle': {
            const rest = new Set(ids);
            const stuck = reachable.find(s => !canReach(s, rest));
            return stuck ? { holds: false, path: paths.get(stuck) } : { holds: true };
        }
        case 'recover': {
            const [from, to] = ids;
            const stuck = reachable.find(s => s === from && !canReach(s, new Set([to])));
            return stuck ? { holds: false, path: paths.get(stuck) } : { holds: true };
        }
        case 'no-return': {
            const s = ids[0];
            if (!paths.has(s)) return { holds: true };
            for (const next of succ.get(s) ?? []) {
                if (next === s && stutter.has(s)) continue;
                const back = bfs([next], succ);
                if (back.has(s)) return { holds: false, path: [...paths.get(s)!, ...back.get(s)!] };
            }
            return { holds: true };
        }
        default:
            return { holds: true };
    }
}

function idOf(m: ExtractedModel, value: string): string | undefined {
    const entry = Object.entries(m.values).find(([, v]) => v === value);
    return entry?.[0] ?? (m.model.states.some(s => s.name === value) ? value : undefined);
}

/** Shortest path (list of states, start included) to every state reachable from the starts. */
function bfs(starts: string[], succ: Map<string, string[]>): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    const queue: string[] = [];
    for (const s of starts) {
        if (!paths.has(s)) {
            paths.set(s, [s]);
            queue.push(s);
        }
    }
    while (queue.length) {
        const s = queue.shift()!;
        for (const t of succ.get(s) ?? []) {
            if (!paths.has(t)) {
                paths.set(t, [...paths.get(s)!, t]);
                queue.push(t);
            }
        }
    }
    return paths;
}
