/**
 * A test per counterexample, written next to the report. When the calls of the counterexample can be
 * made on the real code (the same plan as the replay), the test makes them and checks the property:
 * it fails while the bug is there and passes once it is fixed, so it can be moved into the project's
 * tests as a regression test. Otherwise it is a skeleton listing the steps, to fill in.
 */
import { dirname, relative } from 'node:path';
import { formatLocation, type Facts } from './ir.js';
import type { ExtractedModel, Finding } from './models.js';
import { PY_HARNESS, TS_HARNESS } from './replay-harness.js';
import { replayPlan, type ReplayPlan } from './replay.js';

/** What a scenario needs to know: the finding, the analysis it comes from, and where it is written. */
export interface ScenarioContext {
    models: ExtractedModel[];
    facts: Facts;
    /** Absolute path of the analysed folder. */
    root: string;
    /** Absolute path of the folder the scenario is written to. */
    folder: string;
}

export interface Scenario {
    /** True when the test drives the real code; false for a skeleton. */
    runnable: boolean;
    text: string;
}

export function scenarioFor(f: Finding, context: ScenarioContext): Scenario {
    const python = !!f.loc?.file.endsWith('.py');
    const plan = reachingIsTheBug(f) ? replayPlan(f, context.models, context.facts) : undefined;
    const source = plan ? relative(context.folder, `${context.root}/${plan.file}`).split('\\').join('/') : '';
    if (plan && python && plan.steps.every(s => s.mode === 'call')) return { runnable: true, text: pytestTest(f, plan, source) };
    if (plan && !python) return { runnable: true, text: vitestTest(f, plan, source.startsWith('.') ? source : `./${source}`) };
    return { runnable: false, text: python ? pytestSkeleton(f) : vitestSkeleton(f) };
}

/**
 * True when the counterexample's last state is itself the violation (a leak, a lost write, a state the
 * property says is never reached), so that a test can check it is not reached. Not for properties such
 * as "can always get back" (AG EF), where the bug is the missing way out, not the state.
 */
function reachingIsTheBug(f: Finding): boolean {
    return f.rule === 'resource-leak' || f.rule === 'stale-write-after-await' || /:=\s*(A?G\s*)?!\s*\(/.test(f.spec ?? '');
}

function steps(f: Finding, comment: string): string {
    return (f.counterexample ?? []).map((c, i) => `${comment}   ${i}. ${c.event ? `${c.event}${c.loc ? ` (${formatLocation(c.loc)})` : ''} -> ` : 'start: '}${c.state}`).join('\n');
}

/** Text on one line, safe in a comment or a docstring. */
function oneLine(text: string): string {
    return text.replace(/\s*\n\s*/g, ' ').replace(/\*\//g, '* /').replace(/"""/g, "'''");
}

function header(f: Finding, comment: string): string {
    const replayed = f.confirmation ? `${comment} Replayed during the analysis: ${f.confirmation.status}. ${oneLine(f.confirmation.detail)}\n` : '';
    return `${comment} ${oneLine(f.message)}
${comment} Property: ${f.spec ?? '-'}
${comment} Counterexample:
${steps(f, comment)}
${replayed}`;
}

/** What the test expects of the code, so that it fails on the counterexample. */
function expectation(plan: ReplayPlan, language: 'ts' | 'py'): string {
    if (plan.expect.timersAtLeast !== undefined) return language === 'ts' ? `expect(running.size).toBeLessThan(${plan.expect.timersAtLeast});` : '';
    const bad = JSON.stringify(plan.expect.value ?? '');
    return language === 'ts' ? `expect(String(read(o, ${JSON.stringify(plan.field)}))).not.toBe(${bad});` : `assert str(read(o, ${JSON.stringify(plan.field)})) != ${bad}`;
}

function vitestTest(f: Finding, plan: ReplayPlan, source: string): string {
    const calls = plan.steps.map(s => (s.mode === 'start' ? `const started = start(o, '${s.method}');` : s.mode === 'finish' ? 'await started;' : `await call(o, '${s.method}');`));
    return `// Regression test written by pflow extract from a counterexample.
${header(f, '//')}// It fails while the bug is there, and passes once it is fixed:
//   ${oneLine(f.fix)}
// Move it among the project's tests (and update the import path) to keep the bug from coming back.
import { afterEach, describe, expect, it } from 'vitest';

${TS_HARNESS}
afterEach(restoreTimers);

describe(${JSON.stringify(`${f.subject}: ${f.rule}`)}, () => {
    it(${JSON.stringify(`holds along the counterexample (${f.spec ?? f.rule})`)}, async () => {
        countTimers();
        const mod: any = await import(${JSON.stringify(source)});
        const o: any = create(mod[${JSON.stringify(plan.className)}]);
        ${calls.join('\n        ')}
        ${expectation(plan, 'ts')}
    });
});
`;
}

function pytestTest(f: Finding, plan: ReplayPlan, source: string): string {
    const name = plan.file.split('/').pop()!.replace(/\.py$/, '');
    const fromHere = (path: string) => (path === '.' ? 'HERE' : `HERE / ${JSON.stringify(path)}`);
    return `"""Regression test written by pflow extract from a counterexample.

${header(f, '').replace(/^ /gm, '')}It fails while the bug is there, and passes once it is fixed: ${oneLine(f.fix)}
Move it among the project's tests (and update SOURCE) to keep the bug from coming back.
"""
from pathlib import Path

${PY_HARNESS}

HERE = Path(__file__).resolve().parent
SOURCE = ${fromHere(source)}


def test_counterexample():
    module = load(SOURCE, ${JSON.stringify(name)}, ${fromHere(dirname(source))})
    o = create(getattr(module, ${JSON.stringify(plan.className)}))
${plan.steps.map(s => `    call(o, ${JSON.stringify(s.method)})`).join('\n')}
    ${expectation(plan, 'py')}
`;
}

function vitestSkeleton(f: Finding): string {
    return `// Scenario generated by pflow extract from a counterexample.
${header(f, '//')}// Replay these steps on the real code. If the final expectation fails, the bug is real: apply the fix
//   ${oneLine(f.fix)}
// If it passes, the model is coarser than the code: declare the guard or terminal state in provenflow.config.json.
import { describe, it } from 'vitest';

describe(${JSON.stringify(`${f.subject}: ${f.rule}`)}, () => {
    it.todo('drives the code along the counterexample and expects the property to hold');
});
`;
}

function pytestSkeleton(f: Finding): string {
    return `"""Scenario generated by pflow extract from a counterexample.

${header(f, '').replace(/^ /gm, '')}Replay these steps on the real code. If the final assertion fails, the bug is real: ${oneLine(f.fix)}
If it passes, the model is coarser than the code: declare the guard or terminal state in provenflow.config.json.
"""
import pytest


@pytest.mark.skip(reason="fill in the steps above, then remove this mark")
def test_counterexample():
    ...
`;
}
