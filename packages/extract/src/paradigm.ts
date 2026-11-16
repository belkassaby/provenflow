/**
 * Programming paradigm: measures how object-oriented or functional each
 * part of the code base is and, where provenflow.config.json declares a
 * style for a layer, reports the code that breaks it.
 */
import { limitsFor, type LayerConfig, type Limits, type ProvenflowConfig, type Style } from './config.js';
import type { ClassFact, Facts, FunctionFact, Location } from './ir.js';
import type { Finding } from './models.js';
import { matchesAny } from './scan.js';

export interface ParadigmProfile {
    /** Layer name, or top-level folder when no layers are declared. */
    part: string;
    declared?: Style;
    detected: 'functional' | 'object-oriented' | 'mixed';
    files: number;
    lines: number;
    classes: number;
    methods: number;
    freeFunctions: number;
    /** Free functions without side effects, parameter mutation or outer writes. */
    pureFunctions: number;
    higherOrderFunctions: number;
    /** In-place mutations per 100 lines. */
    mutationDensity: number;
    mutableGlobals: number;
    maxInheritanceDepth: number;
}

export interface ParadigmResult {
    profiles: ParadigmProfile[];
    findings: Finding[];
}

const ALLOWED_CLASSES_IN_FP = /Error$|Exception$|Visitor$|Validator$|Module$|Services?$/;

/** One part of the code base (a layer, or a top-level folder): its code and its declared style. */
interface Part {
    name: string;
    style?: Style;
    modules: Facts['modules'];
    classes: ClassFact[];
    functions: FunctionFact[];
    free: FunctionFact[];
    globals: Array<{ name: string; loc: Location; file: string }>;
}

export function analyseParadigm(facts: Facts, config: ProvenflowConfig): ParadigmResult {
    const languageOf = new Map(facts.modules.map(m => [m.file, m.language]));
    const limitsOf = (file: string) => limitsFor(config, languageOf.get(file));
    const classesByName = new Map(facts.classes.map(c => [c.name, c]));
    const findings: Finding[] = [];
    const profiles: ParadigmProfile[] = [];
    for (const [name, { files, layer }] of partition(facts, config.layers)) {
        const part = partOf(facts, name, files, layer?.style);
        if (part.modules.length === 0) continue;
        profiles.push(profileOf(part, classesByName));
        if (part.style === 'functional') findings.push(...functionalFindings(part));
        if (part.style === 'object-oriented') findings.push(...objectOrientedFindings(part));
        findings.push(...sizeFindings(part, limitsOf, classesByName));
    }
    return { profiles, findings };
}

function partOf(facts: Facts, name: string, files: Set<string>, style: Style | undefined): Part {
    const modules = facts.modules.filter(m => files.has(m.file) && !m.isTest);
    const functions = facts.functions.filter(f => files.has(f.loc.file) && !isTestPath(f.loc.file));
    return {
        name,
        style,
        modules,
        classes: facts.classes.filter(c => files.has(c.loc.file)),
        functions,
        free: functions.filter(f => f.free),
        globals: modules.flatMap(m => m.mutableGlobals.map(g => ({ ...g, file: m.file })))
    };
}

function profileOf(part: Part, classesByName: Map<string, ClassFact>): ParadigmProfile {
    const methods = part.classes.reduce((n, c) => n + c.methods.length, 0);
    const lines = part.modules.reduce((n, m) => n + m.lines, 0);
    const mutations = part.modules.reduce((n, m) => n + m.mutations, 0);
    const oop = methods / Math.max(1, methods + part.free.length);
    return {
        part: part.name,
        declared: part.style,
        detected: oop >= 0.6 ? 'object-oriented' : oop <= 0.35 ? 'functional' : 'mixed',
        files: part.modules.length,
        lines,
        classes: part.classes.length,
        methods,
        freeFunctions: part.free.length,
        pureFunctions: part.free.filter(isPure).length,
        higherOrderFunctions: part.functions.filter(f => f.higherOrder).length,
        mutationDensity: Math.round((mutations / Math.max(1, lines)) * 1000) / 10,
        mutableGlobals: part.globals.length,
        maxInheritanceDepth: Math.max(0, ...part.classes.map(c => inheritanceDepth(c, classesByName)))
    };
}

function functionalFindings(part: Part): Finding[] {
    // Immutable classes (every instance field readonly) are values, which functional code uses too.
    const stateful = (c: ClassFact) => c.fields.some(f => !f.static && !f.readonly);
    const classes = part.classes.filter(c => !ALLOWED_CLASSES_IN_FP.test(c.name) && !c.extends && !isTestPath(c.loc.file) && c.methods.some(m => !m.static && m.name !== 'constructor') && stateful(c));
    return [
        ...classes.map(c => finding('fp-class', 'info', c.name, `${part.name} is declared functional, but ${c.name} is a class with ${c.methods.length} method(s) and mutable fields ${c.fields.filter(f => !f.readonly).map(f => f.name).slice(0, 3).join(', ') || '(none)'}.`, `Turn ${c.name} into plain data plus functions over it (or declare an exception for it in provenflow.config.json "ignore").`, c.loc)),
        // Module-internal helpers filling an accumulator their caller owns are local mutation;
        // what matters is the module's interface: exported functions must not change their inputs.
        ...part.functions.filter(f => f.mutatesParams.length > 0 && f.exported && f.free).map(f => finding('fp-mutates-argument', 'warning', f.name, `${f.name} changes its argument${f.mutatesParams.length > 1 ? 's' : ''} ${f.mutatesParams.join(', ')} in place, in a layer declared functional: callers see their data change.`, `Return a new value instead (spread/map/filter, structuredClone) and let the caller keep or replace the old one.`, f.loc)),
        ...part.functions.filter(f => f.writesOuter.length > 0 && f.free).map(f => finding('fp-writes-outer-state', 'warning', f.name, `${f.name} assigns ${f.writesOuter.join(', ')}, declared outside the function: its result depends on hidden state.`, `Pass the state in as a parameter and return the updated value.`, f.loc)),
        ...part.globals.map(g => finding('fp-mutable-global', 'warning', g.name, `Module-level mutable variable ${g.name} in a layer declared functional.`, `Make it const, or move the state into the caller (a parameter or a closure).`, g.loc))
    ];
}

function objectOrientedFindings(part: Part): Finding[] {
    return [
        ...part.globals.map(g => finding('oop-mutable-global', 'warning', g.name, `Module-level mutable variable ${g.name} in a layer declared object-oriented: state outside any object.`, `Move it into the class (or service) that owns it, so each instance has its own and it can be reset in tests.`, g.loc)),
        ...part.free.filter(f => f.mutatesParams.length > 0).map(f => finding('oop-mutates-foreign-object', 'info', f.name, `${f.name} changes the object(s) ${f.mutatesParams.join(', ')} it receives from outside instead of asking them to change.`, `Move the change into a method of ${f.mutatesParams[0]}'s class (tell, don't ask).`, f.loc))
    ];
}

/** Size rules apply to every style. */
function sizeFindings(part: Part, limitsOf: (file: string) => Limits, classesByName: Map<string, ClassFact>): Finding[] {
    const findings: Finding[] = [];
    for (const c of part.classes) {
        const limits = limitsOf(c.loc.file);
        if (c.methods.length > limits.classMethods || c.lines > limits.classLines) findings.push(finding('god-class', 'warning', c.name, `${c.name} has ${c.methods.length} methods over ${c.lines} lines (limits ${limits.classMethods} methods, ${limits.classLines} lines): it probably has several responsibilities.`, `Split ${c.name} by responsibility (e.g. state, I/O, presentation) and keep it as a thin coordinator.`, c.loc));
        const d = inheritanceDepth(c, classesByName);
        if (d > limits.inheritanceDepth) findings.push(finding('deep-inheritance', 'warning', c.name, `${c.name} is ${d} levels deep in its class hierarchy (limit ${limits.inheritanceDepth}).`, `Prefer composition: hold the behaviour you inherit as a field.`, c.loc));
    }
    for (const f of part.functions) {
        const limits = limitsOf(f.loc.file);
        if (f.lines > limits.functionLines) findings.push(finding('long-function', 'info', f.name, `${f.name} is ${f.lines} lines long (limit ${limits.functionLines}).`, `Extract the steps of ${f.name} into named functions.`, f.loc));
        if (f.params > limits.functionParams) findings.push(finding('many-parameters', 'info', f.name, `${f.name} takes ${f.params} parameters (limit ${limits.functionParams}).`, `Group related parameters into an options object.`, f.loc));
    }
    return findings;
}

function finding(rule: string, severity: Finding['severity'], subject: string, message: string, fix: string, loc: Finding['loc']): Finding {
    return { rule, category: 'paradigm', severity, subject, message, fix, loc, source: 'analysis' };
}

export function isPure(f: FunctionFact): boolean {
    return f.mutatesParams.length === 0 && f.writesOuter.length === 0 && f.effects.length === 0 && !f.usesThis;
}

function inheritanceDepth(c: ClassFact, byName: Map<string, ClassFact>, seen = new Set<string>()): number {
    if (!c.extends || seen.has(c.name)) return 0;
    seen.add(c.name);
    const parent = byName.get(c.extends.replace(/<.*$/, ''));
    return 1 + (parent ? inheritanceDepth(parent, byName, seen) : 0);
}

function isTestPath(file: string): boolean {
    return /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec)\.[tj]sx?$/.test(file) || /(^|\/)test_[^/]*\.py$/.test(file);
}

/** Files of each layer, or of each top-level folder (packages/x counts as one) when there are no layers. */
export function partition(facts: Facts, layers?: LayerConfig[]): Map<string, { files: Set<string>; layer?: LayerConfig }> {
    const parts = new Map<string, { files: Set<string>; layer?: LayerConfig }>();
    for (const file of facts.files) {
        const layer = layers?.find(l => matchesAny(file, l.paths));
        const name = layer?.name ?? (layers?.length ? '(no layer)' : defaultPart(file));
        const part = parts.get(name) ?? { files: new Set<string>(), layer };
        part.files.add(file);
        parts.set(name, part);
    }
    return parts;
}

function defaultPart(file: string): string {
    const segments = file.split('/');
    if (segments.length === 1) return '.';
    if (['packages', 'apps', 'libs', 'services', 'modules'].includes(segments[0]) && segments.length > 2) return `${segments[0]}/${segments[1]}`;
    return segments[0];
}
