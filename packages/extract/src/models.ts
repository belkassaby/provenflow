/**
 * Extracted models and findings. Every model is an ordinary ProvenFlow
 * diagram (so it opens in the editor and runs through the same nuXmv
 * generator) plus the code evidence behind each transition and, for each
 * property, the finding to report when nuXmv says it is false.
 */
import { nuxmvIdentifier, serializeDiagram, type DiagramModel, type SpecKind } from '@provenflow/language';
import { formatLocation, type Location } from './ir.js';

export type Severity = 'error' | 'warning' | 'info';
export type Category = 'state-machine' | 'lifecycle' | 'pattern' | 'paradigm' | 'architecture' | 'security' | 'memory' | 'heap' | 'build';

export interface CounterexampleStep {
    state: string;
    /** The code event leading into this state. */
    event?: string;
    loc?: Location;
}

export interface Finding {
    rule: string;
    category: Category;
    severity: Severity;
    /** What the finding is about: a machine, class, function, file or layer. */
    subject: string;
    message: string;
    /** A concrete way to fix it. */
    fix: string;
    loc?: Location;
    related?: Location[];
    /** Model (file name without extension) that proves the finding. */
    model?: string;
    /** The property nuXmv found false. */
    spec?: string;
    counterexample?: CounterexampleStep[];
    /** How the finding was established: ProvenFlow's own checks, or an external tool (semgrep, codeql, infer, esbmc, cbmc, kani, sarif). */
    source: 'analysis' | 'nuxmv' | 'graph' | 'llm' | 'semgrep' | 'codeql' | 'infer' | 'esbmc' | 'cbmc' | 'kani' | 'sarif' | 'build';
    /** Whether the problem was reproduced on the real code (replay of the counterexample, bounded model checking of the code). */
    confirmation?: Confirmation;
    /** Code values of the states the finding is about (e.g. the unreachable value). */
    states?: string[];
    /** A proposed code change (quick fix or LLM) and whether re-running every check confirmed it. */
    suggestedPatch?: SuggestedPatch;
}

/** A finding checked against the code itself, not only the model. */
export interface Confirmation {
    /** `replay` (the counterexample run on the code), or the model checker that checked the code. */
    by: string;
    /** confirmed: the code does it; refuted: the code does not (the model is coarser); unknown: could not tell. */
    status: 'confirmed' | 'refuted' | 'unknown';
    detail: string;
}

/** A property of the code proved or refuted by a model checker of the code (bounded). */
export interface CodeProof {
    tool: string;
    subject: string;
    property: string;
    status: 'proved' | 'refuted' | 'unknown';
    /** Loop unwinding / call depth the proof holds for. */
    bound?: number;
    loc?: Location;
    detail?: string;
}

/** One file of a proposed change, whole, before and after. */
export interface PatchFile {
    file: string;
    before: string;
    after: string;
}

export interface SuggestedPatch {
    /** Unified diff of all files. */
    diff: string;
    /** For a change the LLM wrote on request: its token usage and thinking (when it gave any). */
    llm?: { usage?: import('./llm-types.js').LlmUsage; thinking?: string; ms: number };
    files?: PatchFile[];
    verified: boolean;
    note: string;
    /** `quick fix` or the LLM provider that proposed it. */
    by?: string;
    /** Models whose extraction changes with the patch: before and after, and their false properties. */
    models?: ModelChange[];
    /** Build, type check and tests run on a copy of the project with the change. */
    checks?: Array<{ name: string; command: string; ok: boolean; output: string; ms: number }>;
    /** The change as exact search/replace edits, to apply it on top of other changes to the same file. */
    edits?: Array<{ file: string; search: string; replace: string }>;
    /** State values the change adds (as cases) or removes (from a declaration). */
    touches?: { variable: string; adds?: string[]; removes?: string[] };
}

/** A model re-extracted from the changed code. */
export interface ModelChange {
    id: string;
    subject: string;
    /** .pflow text before the change ('' if the model is new). */
    before: string;
    /** .pflow text after the change ('' if the model disappears). */
    after: string;
    falseBefore: string[];
    falseAfter: string[];
}

export interface Evidence {
    event: string;
    loc?: Location;
    text?: string;
}

/** What a false property means: turned into a finding by the verification step. */
export interface SpecOrigin {
    rule: string;
    category: Category;
    severity: Severity;
    message: string;
    fix: string;
    loc?: Location;
    related?: Location[];
    /** Explicit-state check used when nuXmv is not available. */
    fallback?: 'reach' | 'avoid' | 'settle' | 'recover' | 'no-return';
    /** State(s) the fallback check is about. */
    states?: string[];
}

export interface ExtractedModel {
    /** File name (without extension), unique within a run. */
    id: string;
    kind: 'state-machine' | 'lifecycle' | 'pattern' | 'architecture';
    subject: string;
    loc?: Location;
    model: DiagramModel;
    /** `source->target` -> code evidence. */
    evidence: Record<string, Evidence[]>;
    origins: Record<string, SpecOrigin>;
    /** State id -> value in the code. */
    values: Record<string, string>;
    notes: string[];
    /** Values in which the machine may rest (declared in the config, or by their names). */
    terminal?: string[];
    /** Key of the machine in provenflow.config.json `machines`. */
    configKey?: string;
    /** The state variable a state machine was extracted from. */
    variableId?: string;
}

export class ModelBuilder {
    private readonly model: DiagramModel;
    private readonly used = new Set<string>();
    private readonly ids = new Map<string, string>();
    private readonly evidence: Record<string, Evidence[]> = {};
    private readonly origins: Record<string, SpecOrigin> = {};
    private readonly specNames = new Set<string>();
    readonly notes: string[] = [];

    constructor(
        readonly id: string,
        readonly kind: ExtractedModel['kind'],
        readonly subject: string,
        readonly loc?: Location
    ) {
        this.model = { name: nuxmvIdentifier(subject, new Set()), attributes: [], variables: [], states: [], transitions: [], fairness: [], specs: [] };
    }

    /** Adds (once) the state for a code value and returns its identifier. */
    state(value: string, initial = false): string {
        let id = this.ids.get(value);
        if (!id) {
            id = nuxmvIdentifier(value, this.used);
            this.ids.set(value, id);
            this.model.states.push({ name: id, label: id === value ? undefined : value, initial, values: {} });
        } else if (initial) {
            this.model.states.find(s => s.name === id)!.initial = true;
        }
        return id;
    }

    has(value: string): boolean {
        return this.ids.has(value);
    }

    idOf(value: string): string | undefined {
        return this.ids.get(value);
    }

    get states(): string[] {
        return [...this.ids.keys()];
    }

    transition(source: string, target: string, evidence: Evidence): void {
        const s = this.state(source);
        const t = this.state(target);
        const key = `${s}->${t}`;
        const list = (this.evidence[key] ??= []);
        if (!list.some(e => e.event === evidence.event && e.loc?.line === evidence.loc?.line && e.loc?.file === evidence.loc?.file)) list.push(evidence);
        let transition = this.model.transitions.find(tr => tr.source === s && tr.target === t);
        if (!transition) {
            transition = { source: s, target: t };
            this.model.transitions.push(transition);
        }
        const events = [...new Set(list.map(e => e.event))];
        transition.label = events.length > 3 ? `${events.slice(0, 3).join(', ')}, +${events.length - 3}` : events.join(', ');
    }

    /** `state = a | state = b` over code values. */
    anyOf(values: string[]): string {
        const ids = values.map(v => this.state(v));
        return ids.length === 0 ? 'FALSE' : ids.map(id => `state = ${id}`).join(' | ');
    }

    spec(kind: SpecKind, name: string, expression: string, origin: SpecOrigin): void {
        let unique = name.replace(/[^\w]/g, '_');
        for (let i = 2; this.specNames.has(unique); i++) unique = `${name}_${i}`;
        this.specNames.add(unique);
        this.model.specs.push({ kind, name: unique, expression });
        this.origins[unique] = origin;
    }

    build(): ExtractedModel {
        // States no code leaves stay where they are: explicit, so the model opens in the editor
        // without dead-end warnings (nuXmv would stutter there anyway).
        for (const st of this.model.states) {
            if (!this.model.transitions.some(t => t.source === st.name)) this.model.transitions.push({ source: st.name, target: st.name, label: 'stays' });
        }
        const values: Record<string, string> = {};
        for (const [value, id] of this.ids) values[id] = value;
        return { id: this.id, kind: this.kind, subject: this.subject, loc: this.loc, model: this.model, evidence: this.evidence, origins: this.origins, values, notes: this.notes };
    }
}

/** The .pflow text of a model, with the code evidence of each transition as comments. */
export function modelToPflow(m: ExtractedModel): string {
    const header = [`// ${m.kind} model of ${m.subject}, extracted by pflow extract${m.loc ? ` from ${formatLocation(m.loc)}` : ''}.`];
    header.push('// Each transition lists the code that performs it.');
    for (const t of m.model.transitions) {
        const list = m.evidence[`${t.source}->${t.target}`] ?? [];
        for (const e of list.slice(0, 6)) header.push(`//   ${t.source} -> ${t.target}: ${e.event}${e.loc ? ` (${formatLocation(e.loc)})` : ''}`);
        if (list.length > 6) header.push(`//   ${t.source} -> ${t.target}: ... ${list.length - 6} more`);
    }
    for (const note of m.notes) header.push(`// Note: ${note}`);
    return `${header.join('\n')}\n\n${serializeDiagram(m.model)}`;
}

/** File-name friendly identifier. */
export function slug(text: string): string {
    return text.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'model';
}

const TERMINAL = /^(done|complete|completed|closed|close|failed|failure|error|errored|cancell?ed|finished|success|succeeded|stopped|disposed|destroyed|terminated|aborted|rejected|resolved|ended|end|exited|final|dead|expired|archived|deleted|shipped|delivered|merged|released|deployed|idle|ready|none|off|disconnected|offline)$/i;

/** Names that usually mean the machine may rest there (a completed run, an idle component). */
export function looksTerminal(value: string): boolean {
    return TERMINAL.test(value.replace(/[-_\s]/g, '')) || TERMINAL.test(value);
}
