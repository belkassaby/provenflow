import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiagram, parseNuxmvOutput } from '@provenflow/language';
import { describe, expect, it } from 'vitest';
import { extractProject, modelToPflow, providerFromSpec, writeOutputs, type Checker, type ExtractionResult, type LlmProvider, type ProvenflowConfig } from '../src/index.js';

const SHOP = fileURLToPath(new URL('./fixtures/shop', import.meta.url));

const CONFIG: ProvenflowConfig = {
    layers: [
        { name: 'core', paths: ['src/core/**'], mayImport: [], style: 'functional' },
        { name: 'ui', paths: ['src/ui/**'], mayImport: ['core'], style: 'object-oriented' }
    ],
    machines: { 'Order.status': { specs: ["AG (state = 'cancelled' -> AG state != 'shipped')"] } },
    patterns: [
        { subject: 'EventBus', pattern: 'observer' },
        { subject: 'QueryBuilder', pattern: 'singleton' }
    ]
};

/** nuXmv when NUXMV_PATH is set; otherwise the explicit-state checker is used. */
const checker: Checker | undefined = process.env['NUXMV_PATH']
    ? async smv => {
          const dir = mkdtempSync(join(tmpdir(), 'provenflow-test-'));
          try {
              writeFileSync(join(dir, 'm.smv'), smv);
              const out = spawnSync(process.env['NUXMV_PATH']!, [join(dir, 'm.smv')], { encoding: 'utf8' });
              return parseNuxmvOutput(out.stdout, out.stderr);
          } finally {
              rmSync(dir, { recursive: true, force: true });
          }
      }
    : undefined;

let cached: ExtractionResult | undefined;
async function shop(): Promise<ExtractionResult> {
    cached ??= await extractProject(SHOP, { analyzers: false, config: CONFIG, checker });
    return cached;
}

function rules(result: ExtractionResult, subject?: string): string[] {
    return result.findings.filter(f => !subject || f.subject.startsWith(subject) || f.loc?.file.includes(subject)).map(f => f.rule);
}

describe('state machines', () => {
    it('extracts the machine of a field typed as a union, with guarded transitions', async () => {
        const r = await shop();
        const m = r.models.find(x => x.subject === 'Order.status')!;
        expect(m.model.states.map(s => s.name)).toEqual(expect.arrayContaining(['draft', 'submitted', 'paid', 'shipped', 'cancelled', 'refunded']));
        const edges = m.model.transitions.map(t => `${t.source}->${t.target}`);
        expect(edges).toContain('draft->submitted');
        expect(edges).toContain('paid->shipped');
        // submit() returns early unless draft: no submitted transition from paid.
        expect(edges).not.toContain('paid->submitted');
        // cancel() throws when shipped.
        expect(edges).not.toContain('shipped->cancelled');
        expect(m.evidence['draft->submitted'][0].loc).toEqual({ file: 'src/core/order.ts', line: 12 });
    });

    it('finds dead values, unhandled cases and stale writes after await', async () => {
        const r = await shop();
        const order = r.findings.filter(f => f.subject === 'Order.status');
        expect(order.map(f => f.rule)).toEqual(expect.arrayContaining(['unreachable-state', 'unhandled-state', 'stale-write-after-await', ...(checker ? ['property-violated'] : [])]));
        expect(order.find(f => f.rule === 'unreachable-state')!.message).toContain("compared with 'refunded'");
    });

    it('proves the declared property false with a counterexample in code terms', async () => {
        const r = await shop();
        const verdict = r.verdicts.find(v => v.model === 'machine-Order.status' && v.spec === 'config_1')!;
        if (!checker) {
            // Arbitrary LTL/CTL needs nuXmv: reported as not checked.
            expect(verdict.verdict).toBe('unknown');
            expect(r.notes.join(' ')).toMatch(/not checked without nuXmv/);
            return;
        }
        const f = r.findings.find(x => x.rule === 'property-violated')!;
        expect(f.source).toBe('nuxmv');
        {
            expect(f.counterexample!.map(s => s.state)).toEqual(['draft', 'cancelled', 'paid', 'shipped']);
            expect(f.counterexample![2].event).toBe('Order.pay');
        }
    });

    it('reads Python enums, match statements and python-transitions machines', async () => {
        const r = await shop();
        const job = r.models.find(x => x.subject === 'Job.state')!;
        expect(job.model.transitions.map(t => `${t.source}->${t.target}`)).toEqual(expect.arrayContaining(['QUEUED->RUNNING', 'RUNNING->DONE']));
        expect(rules(r, 'Job.state')).toEqual(expect.arrayContaining(['unreachable-state', 'unhandled-state']));
        const lamp = r.models.find(x => x.subject.includes('Lamp'))!;
        expect(lamp.model.states.map(s => s.name)).toEqual(expect.arrayContaining(['off', 'on', 'broken']));
        expect(rules(r, 'transitions machine Lamp')).toContain('cannot-settle');
    });

    it('writes models that parse as .pflow diagrams', async () => {
        const r = await shop();
        for (const m of r.models) {
            const parsed = await parseDiagram(modelToPflow(m));
            expect(parsed.diagnostics.filter(d => d.severity === 'error'), m.id).toEqual([]);
        }
    });
});

describe('resource lifecycles', () => {
    it('finds an interval acquired twice and a listener that cannot be removed', async () => {
        const r = await shop();
        const poller = r.findings.find(f => f.rule === 'resource-leak' && f.subject.startsWith('Poller'))!;
        expect(poller.counterexample?.map(s => s.event).filter(Boolean)).toEqual(['Poller.start', 'Poller.start']);
        expect(rules(r, 'Resizer')).toContain('unremovable-listener');
    });

    it('requires Python files to be closed on every path', async () => {
        const r = await shop();
        expect(r.findings.find(f => f.rule === 'release-not-guaranteed')?.loc).toEqual({ file: 'jobs/jobs.py', line: 39 });
    });
});

describe('design patterns', () => {
    it('recognises the patterns and checks their contracts', async () => {
        const r = await shop();
        const found = r.patterns.map(p => `${p.pattern}:${p.subject}`);
        expect(found).toEqual(expect.arrayContaining(['singleton:Session', 'observer:EventBus.listeners', 'builder:QueryBuilder', 'strategy:Pricing', 'state:TrafficLight']));
        expect(rules(r)).toEqual(expect.arrayContaining(['singleton-bypassed', 'observer-cannot-unsubscribe', 'strategy-not-implemented', 'builder-builds-unconfigured']));
        expect(r.findings.find(f => f.rule === 'unreachable-state' && f.subject.includes('TrafficLight'))!.message).toContain('Broken');
    });

    it('reports declared patterns the code does not implement', async () => {
        const r = await shop();
        const expected = r.findings.filter(f => f.rule === 'pattern-expected');
        expect(expected.map(f => f.subject)).toEqual(['QueryBuilder']);
        expect(expected[0].severity).toBe('error');
    });
});

describe('architecture and paradigm', () => {
    it('finds layer violations, layer cycles and file cycles', async () => {
        const r = await shop();
        const violation = r.findings.find(f => f.rule === 'layer-violation')!;
        expect(violation.loc).toEqual({ file: 'src/core/pricing.ts', line: 1 });
        expect(rules(r)).toEqual(expect.arrayContaining(['layer-cycle', 'import-cycle']));
    });

    it('checks the declared style of each layer', async () => {
        const r = await shop();
        expect(rules(r, 'src/core/util.ts')).toEqual(expect.arrayContaining(['fp-mutable-global', 'fp-writes-outer-state', 'fp-mutates-argument']));
        const core = r.paradigm.find(p => p.part === 'core')!;
        expect(core.declared).toBe('functional');
    });

    it('honours ignore rules', async () => {
        const r = await extractProject(SHOP, { analyzers: false, config: { ...CONFIG, ignore: [{ rule: 'import-cycle' }, { rule: 'resource-leak', subject: 'Poller' }] } });
        expect(rules(r)).not.toContain('import-cycle');
        expect(r.findings.some(f => f.rule === 'resource-leak' && f.subject.startsWith('Poller'))).toBe(false);
    });
});

describe('outputs', () => {
    it('writes models, a report, SARIF and scenarios', async () => {
        const r = await shop();
        const dir = mkdtempSync(join(tmpdir(), 'provenflow-out-'));
        try {
            const written = writeOutputs(r, dir);
            expect(written.models.length).toBe(r.models.length);
            expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('## Design patterns');
            const sarif = JSON.parse(readFileSync(join(dir, 'report.sarif'), 'utf8')) as { runs: Array<{ results: unknown[] }> };
            expect(sarif.runs[0].results.length).toBe(r.findings.length);
            expect(written.scenarios.some(s => s.endsWith('.test.ts'))).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('Angular templates', () => {
    it('sees state set and tested in templates', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'provenflow-ng-'));
        try {
            writeFileSync(
                join(dir, 'tabs.ts'),
                `// Stand-ins for @angular/core (no node_modules in the temporary project).
interface WritableSignal<T> { (): T; set(value: T): void; update(fn: (value: T) => T): void }
declare function signal<T>(value: T): WritableSignal<T>;
declare function Component(options: object): ClassDecorator;
type Tab = 'home' | 'settings' | 'about';
@Component({
    selector: 'app-tabs',
    template: \`
        <button (click)="tab.set('settings')">Settings</button>
        @if (tab() === 'about') { <p>About</p> }
    \`
})
export class Tabs {
    readonly tab = signal<Tab>('home');
    reset(): void {
        this.tab.set('home');
    }
}
`
            );
            const r = await extractProject(dir, { analyzers: false, config: {} });
            const m = r.models.find(x => x.subject === 'Tabs.tab')!;
            const settings = m.evidence['home->settings'][0];
            expect(settings.event).toBe('Tabs.template (click)');
            expect(settings.loc).toEqual({ file: 'tabs.ts', line: 9 });
            // 'about' is tested in the template but never set.
            expect(r.findings.find(f => f.rule === 'unreachable-state')!.message).toContain("compared with 'about'");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('takes the values of a written parameter from the callers', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'provenflow-params-'));
        try {
            writeFileSync(
                join(dir, 'door.ts'),
                `type DoorState = 'open' | 'closed' | 'locked';
export class Door {
    state: DoorState = 'closed';
    private move(to: DoorState): void {
        this.state = to;
    }
    open(): void {
        this.move('open');
    }
    close(): void {
        this.move('closed');
    }
}
`
            );
            const r = await extractProject(dir, { analyzers: false, config: {} });
            const m = r.models.find(x => x.subject === 'Door.state')!;
            expect(m.model.transitions.map(t => `${t.source}->${t.target}`).sort()).toEqual(['closed->open', 'locked->closed', 'locked->open', 'open->closed']);
            expect(r.findings.find(f => f.rule === 'unreachable-state')!.message).toContain("'locked'");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('LLM assistance (verified)', () => {
    /** A scripted model: answers by what the prompt asks for. */
    function scripted(answers: Array<[RegExp, unknown]>): LlmProvider & { prompts: string[] } {
        const prompts: string[] = [];
        return {
            name: 'test:scripted',
            prompts,
            async complete(_system, user) {
                prompts.push(user);
                const answer = answers.find(([re]) => re.test(user));
                return answer ? JSON.stringify(answer[1]) : '{}';
            }
        };
    }

    it('accepts computed writes only when they cite a real write and valid values', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'provenflow-llm-'));
        try {
            writeFileSync(
                join(dir, 'lamp.ts'),
                `type Mode = 'off' | 'on' | 'blink';
export class Lamp {
    mode: Mode = 'off';
    apply(next: Mode): void {
        this.mode = next;
    }
}
`
            );
            const llm = scripted([
                [
                    /computed value/,
                    {
                        writes: [
                            { file: 'lamp.ts', line: 5, targets: ['on', 'blink'], sources: null, reason: 'apply is called with on or blink' },
                            { file: 'lamp.ts', line: 99, targets: ['on'], sources: null }
                        ]
                    }
                ]
            ]);
            const r = await extractProject(dir, { analyzers: false, config: {}, llm, cacheDir: join(dir, 'cache') });
            expect(r.llm!.accepted).toHaveLength(1);
            expect(r.llm!.rejected[0]).toContain('lamp.ts:99');
            const m = r.models.find(x => x.subject === 'Lamp.mode')!;
            expect(m.model.transitions.map(t => `${t.source}->${t.target}`)).toContain('off->blink');
            // Cached: a second run does not ask again.
            const again = scripted([]);
            await extractProject(dir, { analyzers: false, config: {}, llm: { ...again, name: 'test:scripted' }, cacheDir: join(dir, 'cache') });
            expect(again.prompts).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('marks a proposed fix verified only when the re-run no longer reports the finding', async () => {
        const llm = scripted([
            [
                /Poller can lose the interval/,
                {
                    edits: [
                        { file: 'src/ui/widgets.ts', search: "    start(): void {\n        this.timer", replace: "    start(): void {\n        if (this.timer) return;\n        this.timer" },
                        { file: 'src/ui/widgets.ts', search: '    stop(): void {', replace: '    dispose(): void {\n        this.stop();\n    }\n\n    stop(): void {' }
                    ],
                    explanation: 'Do not start twice, and stop the timer when the poller is disposed.'
                }
            ],
            [/EventBus registers observers/, { edits: [{ file: 'src/core/registry.ts', search: 'text that is not in the file', replace: 'x' }] }]
        ]);
        const r = await extractProject(SHOP, { analyzers: false, config: CONFIG, llm, llmFixes: 30, cacheDir: mkdtempSync(join(tmpdir(), 'provenflow-cache-')) });
        const leak = r.findings.find(f => f.rule === 'resource-leak' && f.subject.startsWith('Poller'))!;
        expect(leak.suggestedPatch?.verified).toBe(true);
        expect(leak.suggestedPatch?.diff).toContain('+        if (this.timer) return;');
        const observer = r.findings.find(f => f.rule === 'observer-cannot-unsubscribe')!;
        expect(observer.suggestedPatch?.verified).toBe(false);
        // The fixture itself is unchanged.
        expect(readFileSync(join(SHOP, 'src/ui/widgets.ts'), 'utf8')).not.toContain('if (this.timer) return;');
    });

    it('builds providers from a spec and refuses unknown ones', () => {
        expect(providerFromSpec('ollama:qwen2.5-coder').name).toBe('ollama:qwen2.5-coder');
        expect(() => providerFromSpec('anthropic:claude-sonnet-5', {})).toThrow(/ANTHROPIC_API_KEY/);
        expect(() => providerFromSpec('nope:x')).toThrow(/Unknown LLM provider/);
    });
});
