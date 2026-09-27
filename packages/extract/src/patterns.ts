/**
 * Design patterns (https://en.wikipedia.org/wiki/Software_design_pattern):
 * each pattern found in the code is checked twice.
 *
 *  - Structure: the parts the pattern needs are there (an observer can be
 *    removed, every strategy implements its interface, a builder validates).
 *  - Behaviour: a contract model of how the pattern is used, verified by
 *    nuXmv (a singleton is never instantiated twice, a subscriber can always
 *    detach, a builder never builds unconfigured, every state of a State
 *    pattern is reachable).
 *
 * Patterns declared in provenflow.config.json must be found and must pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATTERNS, type PatternExpectation, type PatternName, type ProvenflowConfig } from './config.js';
import { formatLocation, type ClassFact, type Facts, type Location, type MethodFact } from './ir.js';
import { ModelBuilder, slug, type ExtractedModel, type Finding } from './models.js';

export interface PatternInstance {
    pattern: PatternName;
    subject: string;
    loc: Location;
    /** Why the code is recognised as this pattern. */
    evidence: string;
    /** Model checking the behaviour of the pattern, when it has one. */
    model?: string;
    /**
     * How sure the recognition is: declared (provenflow.config.json or an `@pattern` comment),
     * structural (the language or the types say so: implements, providedIn, private constructor),
     * heuristic (names and shapes only). Findings on heuristic instances are notes, not warnings.
     */
    confidence?: PatternConfidence;
}

export type PatternConfidence = 'declared' | 'structural' | 'heuristic';

export interface PatternResult {
    instances: PatternInstance[];
    models: ExtractedModel[];
    findings: Finding[];
}

export function analysePatterns(facts: Facts, config: ProvenflowConfig): PatternResult {
    const result: PatternResult = { instances: [], models: [], findings: [] };
    const classes = facts.classes.filter(c => !c.loc.file.match(/(^|\/)(test|tests)\//));
    const byName = new Map<string, ClassFact[]>();
    for (const c of classes) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    const used = new Set<string>();
    const modelId = (base: string) => {
        let id = slug(base);
        for (let i = 2; used.has(id); i++) id = `${slug(base)}_${i}`;
        used.add(id);
        return id;
    };

    singletons(facts, classes, result, modelId);
    observers(classes, result, modelId);
    builders(classes, result, modelId);
    const families = implementations(facts, classes);
    strategies(facts, families, byName, result);
    wrappers(classes, facts, result);
    statePattern(facts, families, byName, result, modelId);
    commands(facts, families, byName, result);
    factories(facts, classes, byName, result);
    exhaustiveDispatch(facts, result);
    const declared = [...(config.patterns ?? []), ...declaredInCode(facts)];
    for (const i of result.instances) {
        i.confidence ??= declared.some(d => d.pattern === i.pattern && (i.subject === d.subject || i.subject.startsWith(`${d.subject}.`))) ? 'declared' : STRUCTURAL.has(i.pattern) ? 'structural' : 'heuristic';
    }
    return result;
}

/** Patterns whose recognition rests on types or language constructs; the others rest on names and shapes. */
const STRUCTURAL = new Set<PatternName>(['singleton', 'observer', 'strategy', 'state']);

/**
 * Patterns declared in the code: a comment `@pattern <name>` or `provenflow: pattern <name>`
 * just before a class (or on its line) says the class implements it.
 */
export function declaredInCode(facts: Facts): PatternExpectation[] {
    const found: PatternExpectation[] = [];
    const byFile = new Map<string, ClassFact[]>();
    for (const c of facts.classes) byFile.set(c.loc.file, [...(byFile.get(c.loc.file) ?? []), c]);
    for (const [file, classes] of byFile) {
        let text: string;
        try {
            text = readFileSync(join(facts.root, file), 'utf8');
        } catch {
            continue;
        }
        if (!/pattern/.test(text)) continue;
        const lines = text.split('\n');
        lines.forEach((line, index) => {
            const m = /(?:@pattern|provenflow:\s*pattern)\s+([a-z-]+)/i.exec(line);
            const pattern = m?.[1].toLowerCase() as PatternName | undefined;
            if (!pattern || !(PATTERNS as readonly string[]).includes(pattern)) return;
            const next = classes.filter(c => c.loc.line >= index + 1 && c.loc.line <= index + 12).sort((a, b) => a.loc.line - b.loc.line)[0];
            if (next) found.push({ subject: next.name, pattern });
        });
    }
    return found;
}

/** Findings on patterns recognised only by heuristics become notes: the code may not mean to be that pattern. */
export function gradePatternFindings(findings: Finding[], instances: PatternInstance[]): Finding[] {
    return findings.map(f => {
        if (f.category !== 'pattern' || f.rule === 'pattern-expected' || f.severity === 'info') return f;
        const instance = instances.find(i => (f.model && i.model === f.model) || i.subject === f.subject || f.subject.startsWith(`${i.subject}.`));
        if (instance?.confidence !== 'heuristic') return f;
        return {
            ...f,
            severity: 'info',
            message: `${f.message} (Recognised as a ${instance.pattern} from names and shapes only; add \`@pattern ${instance.pattern}\` above ${instance.subject} or list it under "patterns" in provenflow.config.json to make this a warning.)`
        };
    });
}

// ------------------------------------------------------------------ singleton

function singletons(facts: Facts, classes: ClassFact[], result: PatternResult, modelId: (b: string) => string): void {
    for (const c of classes) {
        const staticSelf = c.fields.some(f => f.static && (f.type === c.name || /instance/i.test(f.name)));
        const accessor = c.methods.find(m => m.static && /^(getInstance|instance|get|shared|default)$/i.test(m.name));
        const classic = ((c.privateConstructor || c.overridesNew) && (staticSelf || !!accessor)) || !!c.declaredSingleton;
        if (!c.providedInRoot && !classic) continue;
        const how = c.providedInRoot
            ? "@Injectable({ providedIn: 'root' }): one instance per application, obtained with inject()"
            : c.declaredSingleton
              ? 'declared as a single instance by the language (object / Singleton / shared instance)'
              : `${c.overridesNew ? '__new__' : 'private constructor'} with ${accessor ? `${accessor.name}()` : 'a static instance'}`;
        const id = modelId(`pattern-singleton-${c.name}`);
        const b = new ModelBuilder(id, 'pattern', `${c.name} (singleton)`, c.loc);
        b.state('none', true);
        b.state('one');
        b.state('many');
        const obtain = c.providedInRoot ? `inject(${c.name})` : `${c.name}.${accessor?.name ?? 'instance'}`;
        b.transition('none', 'one', { event: obtain, loc: accessor?.loc ?? c.loc });
        b.transition('one', 'one', { event: obtain, loc: accessor?.loc ?? c.loc });
        const bypasses = facts.instantiations.filter(n => n.className === c.name && !n.inTest && n.inClass !== c.name && (!n.language || n.language === c.language));
        for (const n of bypasses) {
            b.transition('none', 'one', { event: `new ${c.name}`, loc: n.loc });
            b.transition('one', 'many', { event: `new ${c.name}`, loc: n.loc });
        }
        // Classic singleton: the accessor must create lazily or eagerly, but only once.
        if (classic && !c.declaredSingleton && accessor && !c.methods.some(m => m.name === accessor.name && m.validates) && !c.fields.some(f => f.static)) {
            b.transition('one', 'many', { event: `${c.name}.${accessor.name} (no stored instance)`, loc: accessor.loc });
        }
        b.spec('INVARSPEC', 'single_instance', '!(state = many)', {
            rule: 'singleton-bypassed',
            category: 'pattern',
            severity: 'warning',
            message: `${c.name} is a singleton (${how}) but ${bypasses.length > 0 ? `is also constructed with new at ${bypasses.map(n => formatLocation(n.loc)).join(', ')}` : 'can be created more than once'}, giving two independent states.`,
            fix: bypasses.length > 0 ? `Replace new ${c.name}(...) with ${obtain} at ${formatLocation(bypasses[0].loc)} (tests may construct it directly).` : `Store the instance in a static field and return it from ${accessor?.name ?? 'the accessor'}.`,
            loc: bypasses[0]?.loc ?? c.loc,
            fallback: 'avoid',
            states: ['many']
        });
        result.models.push(b.build());
        result.instances.push({ pattern: 'singleton', subject: c.name, loc: c.loc, evidence: how, model: id });
    }
}

// ------------------------------------------------------------------- observer

function observers(classes: ClassFact[], result: PatternResult, modelId: (b: string) => string): void {
    for (const c of classes) {
        for (const field of new Set(c.methods.flatMap(m => m.addsParamTo))) {
            const subscribe = c.methods.filter(m => m.addsParamTo.includes(field));
            const notify = c.methods.filter(m => m.iteratesAndCalls.includes(field));
            if (notify.length === 0) continue;
            const unsubscribe = c.methods.filter(m => m.removesFrom.includes(field) && !m.addsParamTo.includes(field));
            const returnsDisposer = subscribe.some(m => m.returnsFunction);
            const id = modelId(`pattern-observer-${c.name}-${field}`);
            const b = new ModelBuilder(id, 'pattern', `${c.name}.${field} (observer)`, c.loc);
            b.state('detached', true);
            b.state('attached');
            for (const m of subscribe) b.transition('detached', 'attached', { event: `${c.name}.${m.name}`, loc: m.loc });
            for (const m of notify) b.transition('attached', 'attached', { event: `${c.name}.${m.name}`, loc: m.loc });
            for (const m of unsubscribe) b.transition('attached', 'detached', { event: `${c.name}.${m.name}`, loc: m.loc });
            if (returnsDisposer) b.transition('attached', 'detached', { event: 'unsubscribe function returned by subscribe', loc: subscribe.find(m => m.returnsFunction)?.loc });
            b.spec('CTLSPEC', 'can_detach', 'AG (state = attached -> EF state = detached)', {
                rule: 'observer-cannot-unsubscribe',
                category: 'pattern',
                severity: 'warning',
                message: `${c.name} registers observers in ${field} (${subscribe.map(m => m.name).join(', ')}) and notifies them (${notify.map(m => m.name).join(', ')}), but an observer can never be removed: every subscriber lives as long as ${c.name}.`,
                fix: `Add an unsubscribe/off method that removes the listener from ${field}, or return an unsubscribe function from ${subscribe[0].name}().`,
                loc: subscribe[0].loc,
                fallback: 'recover',
                states: ['attached', 'detached']
            });
            result.models.push(b.build());
            result.instances.push({ pattern: 'observer', subject: `${c.name}.${field}`, loc: subscribe[0].loc, evidence: `${subscribe.map(m => m.name).join('/')} adds to ${field}, ${notify.map(m => m.name).join('/')} calls each`, model: id });
        }
    }
}

// -------------------------------------------------------------------- builder

function builders(classes: ClassFact[], result: PatternResult, modelId: (b: string) => string): void {
    for (const c of classes) {
        const fluent = c.methods.filter(m => m.returnsThis && !m.static);
        const build = c.methods.find(m => /^(build|create|done|toModel|result|get)$/.test(m.name) && !m.returnsThis);
        if (fluent.length < 3 || !build) continue;
        const id = modelId(`pattern-builder-${c.name}`);
        const b = new ModelBuilder(id, 'pattern', `${c.name} (builder)`, c.loc);
        b.state('empty', true);
        b.state('configured');
        b.state('built');
        b.state('built_unconfigured');
        for (const m of fluent) {
            b.transition('empty', 'configured', { event: `${c.name}.${m.name}`, loc: m.loc });
            b.transition('configured', 'configured', { event: `${c.name}.${m.name}`, loc: m.loc });
        }
        b.transition('configured', 'built', { event: `${c.name}.${build.name}`, loc: build.loc });
        b.transition('empty', build.validates ? 'empty' : 'built_unconfigured', { event: `${c.name}.${build.name}${build.validates ? ' (throws)' : ''}`, loc: build.loc });
        b.spec('INVARSPEC', 'never_built_unconfigured', '!(state = built_unconfigured)', {
            rule: 'builder-builds-unconfigured',
            category: 'pattern',
            severity: 'info',
            message: `${c.name}.${build.name}() returns a result even when none of ${fluent.map(m => m.name).join(', ')} was called.`,
            fix: `Validate the required parts in ${build.name}() and throw a clear error when they are missing (or give them defaults on purpose).`,
            loc: build.loc,
            fallback: 'avoid',
            states: ['built_unconfigured']
        });
        result.models.push(b.build());
        result.instances.push({ pattern: 'builder', subject: c.name, loc: c.loc, evidence: `${fluent.length} fluent methods and ${build.name}()`, model: id });
    }
}

// ----------------------------------------------------------- families (types)

interface Family {
    base: string;
    loc?: Location;
    methods: string[];
    members: ClassFact[];
}

/** Interfaces or abstract classes with at least two implementations. */
function implementations(facts: Facts, classes: ClassFact[]): Family[] {
    const families = new Map<string, Family>();
    const interfaces = new Map(facts.interfaces.map(i => [i.name, i]));
    const abstracts = new Map(classes.filter(c => c.abstract).map(c => [c.name, c]));
    for (const c of classes) {
        for (const base of [...c.implements, ...(c.extends ? [c.extends] : [])]) {
            const name = base.replace(/<.*$/, '').split('.').pop()!;
            const iface = interfaces.get(name);
            const abstract = abstracts.get(name);
            if (!iface && !abstract) continue;
            const family = families.get(name) ?? { base: name, loc: iface?.loc ?? abstract?.loc, methods: iface?.methods ?? abstract!.methods.filter(m => m.abstract).map(m => m.name), members: [] };
            if (!family.members.includes(c)) family.members.push(c);
            families.set(name, family);
        }
    }
    return [...families.values()].filter(f => f.members.length >= 2);
}

function strategies(facts: Facts, families: Family[], byName: Map<string, ClassFact[]>, result: PatternResult): void {
    for (const f of families) {
        if (isStateFamily(f, byName) || isCommandFamily(f)) continue;
        result.instances.push({ pattern: 'strategy', subject: f.base, loc: f.loc ?? f.members[0].loc, evidence: `${f.members.length} implementations: ${f.members.map(m => m.name).join(', ')}` });
        for (const member of f.members) {
            for (const m of member.methods.filter(x => x.notImplemented && (f.methods.length === 0 || f.methods.includes(x.name)))) {
                result.findings.push({
                    rule: 'strategy-not-implemented',
                    category: 'pattern',
                    severity: 'warning',
                    subject: `${member.name}.${m.name}`,
                    message: `${member.name} implements ${f.base} but ${m.name}() only throws: callers holding a ${f.base} cannot use it (Liskov substitution).`,
                    fix: `Implement ${m.name}() in ${member.name}, or split ${f.base} so ${member.name} only implements what it supports.`,
                    loc: m.loc,
                    source: 'analysis'
                });
            }
        }
    }
    // Functional strategies: a callable type used as a table of interchangeable functions.
    for (const i of facts.interfaces.filter(x => x.callable)) {
        result.instances.push({ pattern: 'strategy', subject: i.name, loc: i.loc, evidence: 'function type used as an interchangeable behaviour' });
    }
}

// ------------------------------------------------------- adapter / decorator

function wrappers(classes: ClassFact[], facts: Facts, result: PatternResult): void {
    const interfaces = new Map(facts.interfaces.map(i => [i.name, i]));
    for (const c of classes) {
        // An adapter/decorator presents an interface: forwarding alone (a UI component calling its store) is plain delegation.
        if (c.implements.length === 0) continue;
        const delegating = c.methods.filter(m => m.delegatesTo);
        if (delegating.length < 2 || delegating.length < c.methods.length / 2) continue;
        const field = mostCommon(delegating.map(m => m.delegatesTo!));
        const fieldType = c.fields.find(f => f.name === field)?.type?.replace(/<.*$/, '');
        const iface = c.implements.map(n => n.replace(/<.*$/, '')).find(n => interfaces.has(n));
        const pattern: PatternName = iface && fieldType === iface ? 'decorator' : 'adapter';
        result.instances.push({ pattern, subject: c.name, loc: c.loc, evidence: `${delegating.length}/${c.methods.length} methods forward to ${field}${fieldType ? ` (${fieldType})` : ''}` });
        const required = iface ? interfaces.get(iface)!.methods : [];
        const broken = c.methods.filter(m => m.notImplemented && (required.length === 0 || required.includes(m.name)));
        for (const m of broken) {
            result.findings.push({
                rule: `${pattern}-incomplete`,
                category: 'pattern',
                severity: 'warning',
                subject: `${c.name}.${m.name}`,
                message: `${c.name} wraps ${field} as a${pattern === 'adapter' ? 'n adapter' : ' decorator'} but ${m.name}() only throws.`,
                fix: `Forward ${m.name}() to ${field} (or translate it), or remove it from the interface ${c.name} exposes.`,
                loc: m.loc,
                source: 'analysis'
            });
        }
    }
}

// ---------------------------------------------------------------------- state

function isStateFamily(f: Family, byName: Map<string, ClassFact[]>): boolean {
    const names = new Set(f.members.map(m => m.name));
    return f.members.some(m => m.methods.some(x => x.returnsNew.some(n => names.has(n)))) && byName.size > 0;
}

function statePattern(facts: Facts, families: Family[], byName: Map<string, ClassFact[]>, result: PatternResult, modelId: (b: string) => string): void {
    for (const f of families.filter(x => isStateFamily(x, byName))) {
        const names = new Set(f.members.map(m => m.name));
        const id = modelId(`pattern-state-${f.base}`);
        const b = new ModelBuilder(id, 'pattern', `${f.base} (state pattern)`, f.loc);
        // Initial: states created outside the family (the context's starting state).
        const starts = facts.instantiations.filter(n => names.has(n.className) && (!n.inClass || !names.has(n.inClass)) && !n.inTest).map(n => n.className);
        const initial = starts.length > 0 ? [...new Set(starts)] : [f.members[0].name];
        initial.forEach(s => b.state(s, true));
        f.members.forEach(m => b.state(m.name));
        for (const member of f.members) {
            for (const method of member.methods) {
                for (const target of method.returnsNew.filter(n => names.has(n))) b.transition(member.name, target, { event: `${member.name}.${method.name}`, loc: method.loc });
            }
        }
        for (const member of f.members) {
            b.spec('CTLSPEC', `reach_${member.name}`, `EF state = ${b.idOf(member.name)}`, {
                rule: 'unreachable-state',
                category: 'pattern',
                severity: 'warning',
                message: `State class ${member.name} of ${f.base} is never entered: no state returns it and nothing starts in it.`,
                fix: `Add the transition that returns new ${member.name}(), or delete the class.`,
                loc: member.loc,
                fallback: 'reach',
                states: [member.name]
            });
        }
        result.models.push(b.build());
        result.instances.push({ pattern: 'state', subject: f.base, loc: f.loc ?? f.members[0].loc, evidence: `${f.members.length} state classes returning each other`, model: id });
    }
}

// -------------------------------------------------------------------- command

function isCommandFamily(f: Family): boolean {
    return f.members.every(m => m.methods.some(x => /^(execute|run|apply|invoke|handle|do)$/.test(x.name)));
}

function commands(facts: Facts, families: Family[], byName: Map<string, ClassFact[]>, result: PatternResult): void {
    for (const f of families.filter(x => isCommandFamily(x) && !isStateFamily(x, byName))) {
        result.instances.push({ pattern: 'command', subject: f.base, loc: f.loc ?? f.members[0].loc, evidence: `${f.members.length} command classes with execute()` });
        const undoable = f.members.filter(m => m.methods.some(x => /^(undo|revert|rollback)$/.test(x.name)));
        if (undoable.length > 0 && undoable.length < f.members.length) {
            for (const m of f.members.filter(x => !undoable.includes(x))) {
                result.findings.push({
                    rule: 'command-missing-undo',
                    category: 'pattern',
                    severity: 'warning',
                    subject: m.name,
                    message: `${undoable.length} of the ${f.members.length} ${f.base} commands can be undone, but ${m.name} cannot: undoing a history that contains it will fail.`,
                    fix: `Implement undo() in ${m.name}, or mark it as not undoable and clear the history when it runs.`,
                    loc: m.loc,
                    source: 'analysis'
                });
            }
        }
    }
    void facts;
}

// -------------------------------------------------------------------- factory

function factories(facts: Facts, classes: ClassFact[], byName: Map<string, ClassFact[]>, result: PatternResult): void {
    const candidates: Array<{ name: string; loc: Location; products: string[] }> = [];
    for (const c of classes) {
        for (const m of c.methods.filter(x => x.returnsNew.length > 0 && (/^(create|make|build|new|from|of)/.test(x.name) || x.returnsNew.length >= 2))) {
            if (m.returnsNew.length === 1 && m.returnsNew[0] === c.name && !m.static) continue;
            candidates.push({ name: `${c.name}.${m.name}`, loc: m.loc, products: m.returnsNew });
        }
    }
    for (const { name, loc, products } of candidates) {
        const known = products.filter(p => byName.has(p));
        if (known.length === 0) continue;
        result.instances.push({ pattern: 'factory', subject: name, loc, evidence: `creates ${products.join(', ')}` });
        if (known.length >= 2) {
            const supertypes = known.map(p => new Set(ancestry(p, byName)));
            const shared = [...supertypes[0]].filter(t => supertypes.every(s => s.has(t)));
            if (shared.length === 0) {
                result.findings.push({
                    rule: 'factory-products-unrelated',
                    category: 'pattern',
                    severity: 'info',
                    subject: name,
                    message: `${name} creates ${known.join(', ')}, which share no interface or base class: callers have to know which concrete class they got.`,
                    fix: `Give the products a common interface and declare it as the return type of ${name}.`,
                    loc,
                    source: 'analysis'
                });
            }
        }
    }
    void facts;
}

function ancestry(name: string, byName: Map<string, ClassFact[]>, seen = new Set<string>()): string[] {
    if (seen.has(name)) return [];
    seen.add(name);
    const c = byName.get(name)?.[0];
    if (!c) return [];
    const parents = [...c.implements, ...(c.extends ? [c.extends] : [])].map(p => p.replace(/<.*$/, ''));
    return [...parents, ...parents.flatMap(p => ancestry(p, byName, seen))];
}

// ------------------------------------------------ command / strategy dispatch

/** `switch` over a finite union (command kinds, strategy keys, message types) that misses values. */
function exhaustiveDispatch(facts: Facts, result: PatternResult): void {
    for (const sw of facts.switches) {
        if (sw.variable) continue; // reported with the state machine
        const missing = sw.domain.filter(v => !sw.cases.includes(v));
        if (missing.length === 0 || sw.hasDefault) continue;
        result.findings.push({
            rule: 'non-exhaustive-dispatch',
            category: 'pattern',
            severity: 'warning',
            subject: sw.event,
            message: `The switch over ${sw.subject} in ${sw.event} dispatches ${sw.cases.length} of ${sw.domain.length} kinds; ${missing.map(v => `'${v}'`).join(', ')} fall through silently.`,
            fix: `Handle ${missing.join(', ')}, or add a default branch that throws (with \`const unreachable: never = ${sw.subject}\` in TypeScript the compiler then catches new kinds).`,
            loc: sw.loc,
            source: 'analysis'
        });
    }
}

// ------------------------------------------------------------ expectations

/** Patterns declared in provenflow.config.json that the code does not implement. */
export function checkExpectations(config: ProvenflowConfig, instances: PatternInstance[], inCode: PatternExpectation[] = []): Finding[] {
    const findings: Finding[] = [];
    for (const expected of [...(config.patterns ?? []), ...inCode]) {
        const found = instances.find(i => i.pattern === expected.pattern && (i.subject === expected.subject || i.subject.startsWith(`${expected.subject}.`)));
        if (!found) {
            findings.push({
                rule: 'pattern-expected',
                category: 'pattern',
                severity: 'error',
                subject: expected.subject,
                message: `${inCode.includes(expected) ? 'An @pattern comment' : 'provenflow.config.json'} declares ${expected.subject} as a ${expected.pattern}, but the code does not implement it as one.`,
                fix: patternRecipe(expected.pattern, expected.subject),
                source: 'analysis'
            });
        }
    }
    return findings;
}

export function patternRecipe(pattern: PatternName, subject: string): string {
    switch (pattern) {
        case 'singleton':
            return `Make ${subject} a single shared instance: @Injectable({ providedIn: 'root' }) and inject(${subject}), or a private constructor with a static instance.`;
        case 'observer':
            return `Keep the listeners in a collection with subscribe() (returning an unsubscribe function) and a notify() calling each of them.`;
        case 'factory':
            return `Create the products in one function/method (create...) that returns their common interface.`;
        case 'strategy':
            return `Define an interface (or function type) for the behaviour and give ${subject} one implementation per variant.`;
        case 'builder':
            return `Give ${subject} fluent methods returning this and a build() that validates the required parts.`;
        case 'adapter':
            return `Implement the target interface in ${subject} and forward each method to the wrapped object.`;
        case 'decorator':
            return `Implement the same interface as the wrapped object in ${subject}, forward to it and add the extra behaviour.`;
        case 'state':
            return `Give each state its own class implementing a common interface, with methods returning the next state.`;
        case 'command':
            return `Represent each action as an object with execute() (and undo() if needed) implementing a common interface.`;
        case 'facade':
            return `Expose ${subject} through a single entry module (index) and import only from it.`;
    }
}

function mostCommon(values: string[]): string {
    const counts = new Map<string, number>();
    values.forEach(v => counts.set(v, (counts.get(v) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export type { MethodFact };
