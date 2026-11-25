/**
 * Facts extracted from source files. Each language front end (TypeScript,
 * Python) turns its syntax trees into these facts; every analysis after that
 * (state machines, lifecycles, patterns, paradigm, architecture) only reads
 * facts, so it works the same for every language.
 */

export type Language = 'typescript' | 'python' | 'java' | 'kotlin' | 'groovy' | 'scala' | 'c' | 'cpp' | 'c_sharp' | 'go' | 'rust' | 'swift' | 'ruby' | 'php' | 'r';

/** A place in the code base: file relative to the project root, 1-based line. */
export interface Location {
    file: string;
    line: number;
}

/** A variable whose value is one of a small set of names: a state variable. */
export interface StateVariableFact {
    /** Unique key, e.g. `packages/app/src/live-link.ts#LiveLink.status`. */
    id: string;
    /** Name shown to people, e.g. `LiveLink.status`. */
    name: string;
    language: Language;
    /** The declared values; for an inferred domain, the values written anywhere. */
    values: string[];
    /** True when there is no declared type and the values come from what the code writes. */
    inferred: boolean;
    /** Values the variable starts with (initialisers, constructors, object creations). */
    initial: string[];
    loc: Location;
    /** The class (or module) owning the variable. */
    owner?: string;
}

/** An assignment of a state variable. */
export interface StateWriteFact {
    variable: string;
    /** The values written; null when the value is not a literal (a parameter, a computed value). */
    targets: string[] | null;
    /** The values the variable can have just before the write; null means any value. */
    sources: string[] | null;
    /** The function or method doing the write, e.g. `LiveLink.connect`. */
    event: string;
    loc: Location;
    /** An `await` separates this write from the last check or write of the variable in the same function. */
    afterAwait: boolean;
    /** The source line, for reports and for the LLM. */
    text: string;
    /** Some of the values come from callers passing computed arguments: `targets` is partial. */
    incomplete?: boolean;
}

/** A comparison or `case` testing a state variable against values. */
export interface StateReadFact {
    variable: string;
    values: string[];
    loc: Location;
}

/** A `switch`/`match` over a value whose type is a finite union (state variables, command kinds, strategy keys). */
export interface SwitchFact {
    /** The switched expression as written. */
    subject: string;
    /** State variable id when the subject is one. */
    variable?: string;
    /** All values of the subject's type. */
    domain: string[];
    cases: string[];
    hasDefault: boolean;
    loc: Location;
    event: string;
}

export type ResourceKind =
    | 'interval'
    | 'timeout'
    | 'listener'
    | 'subscription'
    | 'event-source'
    | 'observer'
    | 'process'
    | 'temp-dir'
    | 'file'
    | 'lock'
    | 'graph'
    | 'memory'
    | 'socket'
    | 'executor';

/** Acquisition or release of a resource that must be given back. */
export interface ResourceOpFact {
    kind: ResourceKind;
    op: 'acquire' | 'release';
    /** Class id (for methods) or function id (for free functions). */
    owner: string;
    ownerKind: 'class' | 'function';
    /** Method or function name inside the owner. */
    member: string;
    loc: Location;
    /** Where the handle is kept, e.g. `this.timer` or `dir`; undefined when it is dropped. */
    handle?: string;
    /** The release is in a `finally` block (or a `with` statement), so it also runs on errors. */
    guaranteed: boolean;
    /** Listener on a long-lived global target (window, document, process). */
    global?: boolean;
    /** The listener is an inline function, so it cannot be removed later. */
    anonymous?: boolean;
    /** The release happens in a callback registered by the acquisition (e.g. DestroyRef.onDestroy). */
    selfReleasing?: boolean;
    /** The acquisition returns early when the handle is already set. */
    guarded?: boolean;
    text: string;
}

export interface FieldFact {
    name: string;
    visibility: 'public' | 'protected' | 'private';
    readonly: boolean;
    static: boolean;
    /** Type name as written, if any. */
    type?: string;
}

export interface MethodFact {
    name: string;
    visibility: 'public' | 'protected' | 'private';
    static: boolean;
    abstract: boolean;
    loc: Location;
    lines: number;
    params: number;
    /** Returns `this` (fluent interface). */
    returnsThis: boolean;
    /** Classes instantiated in return statements. */
    returnsNew: string[];
    /** Methods of the same class it calls through `this`. */
    calls: string[];
    /** Fields it iterates while calling each element (notify loop of an observer). */
    iteratesAndCalls: string[];
    /** Fields it adds a parameter to (register a listener). */
    addsParamTo: string[];
    /** Fields it removes elements from. */
    removesFrom: string[];
    /** When the whole body forwards to one field, the field name (adapter, decorator, proxy). */
    delegatesTo?: string;
    /** Returns a function (e.g. the unsubscribe function of a subscribe method). */
    returnsFunction: boolean;
    /** The body only throws (not implemented). */
    notImplemented: boolean;
    /** Fields assigned. */
    assigns: string[];
    /** The method checks some fields and throws when they are missing (validation). */
    validates: boolean;
}

export interface ClassFact {
    id: string;
    name: string;
    language: Language;
    loc: Location;
    lines: number;
    abstract: boolean;
    extends?: string;
    implements: string[];
    decorators: string[];
    /** Angular `@Injectable({ providedIn: 'root' })`: one instance per application. */
    providedInRoot: boolean;
    privateConstructor: boolean;
    fields: FieldFact[];
    methods: MethodFact[];
    /** Python classes: overrides `__new__`. */
    overridesNew?: boolean;
    /** The language makes it a single instance (Kotlin/Scala `object`, Ruby `include Singleton`, Swift `static let shared`...). */
    declaredSingleton?: boolean;
}

export interface InterfaceFact {
    name: string;
    loc: Location;
    language: Language;
    methods: string[];
    /** A single call signature, or a function type alias: the functional form of a strategy/command. */
    callable: boolean;
}

export interface InstantiationFact {
    className: string;
    /** Language of the file (classes of other languages with the same name are not this one). */
    language?: Language;
    loc: Location;
    /** The class and method containing the `new`, if any. */
    inClass?: string;
    inMember?: string;
    /** The file is a test. */
    inTest: boolean;
    /** The default value of a constructor parameter of a class the dependency injector creates. */
    injectedDefault?: boolean;
}

export interface FunctionFact {
    id: string;
    name: string;
    loc: Location;
    lines: number;
    exported: boolean;
    /** Free function (not a method). */
    free: boolean;
    params: number;
    /** Takes or returns functions, or passes callbacks to map/filter/reduce. */
    higherOrder: boolean;
    /** Changes one of its parameters (property assignment, push, splice, sort...). */
    mutatesParams: string[];
    /** Writes variables declared outside the function. */
    writesOuter: string[];
    /** Calls with side effects: I/O, clock, randomness. */
    effects: string[];
    usesThis: boolean;
    /** Control-flow measures of the body (absent when the front end could not compute them). */
    complexity?: ComplexityFact;
}

/**
 * Cognitive Complexity (SonarSource whitepaper v1.7: +1 per break in linear flow, plus the nesting
 * level for nested structures), cyclomatic complexity (1 + decision points) and the deepest nesting
 * of control structures.
 */
export interface ComplexityFact {
    cognitive: number;
    cyclomatic: number;
    nesting: number;
}

export interface ImportFact {
    specifier: string;
    /** Resolved file relative to the root, when inside the project. */
    resolved?: string;
    loc: Location;
    /** Only types are imported (erased at run time). */
    typeOnly: boolean;
}

export interface ModuleFact {
    file: string;
    language: Language;
    lines: number;
    imports: ImportFact[];
    /** Module-level mutable variables (`let`/`var`, Python globals reassigned). */
    mutableGlobals: Array<{ name: string; loc: Location }>;
    /** In-place mutations of values not owned by the function doing them. */
    mutations: number;
    /** `let` variables reassigned inside functions. */
    reassignments: number;
    /** `const`/`readonly` declarations. */
    immutableDeclarations: number;
    isTest: boolean;
}

/** A state machine read directly from a library definition (XState, LangGraph, python-transitions). */
export interface DeclaredMachineFact {
    name: string;
    loc: Location;
    library: string;
    /** Source text handed to the importer, or an already built description. */
    text?: string;
    states?: string[];
    initial?: string;
    transitions?: Array<{ source: string; target: string; event?: string; line?: number }>;
}

export interface Facts {
    root: string;
    files: string[];
    modules: ModuleFact[];
    stateVariables: StateVariableFact[];
    writes: StateWriteFact[];
    reads: StateReadFact[];
    switches: SwitchFact[];
    resources: ResourceOpFact[];
    classes: ClassFact[];
    interfaces: InterfaceFact[];
    instantiations: InstantiationFact[];
    functions: FunctionFact[];
    declaredMachines: DeclaredMachineFact[];
    /** Problems of the front ends themselves (parse errors, missing python3). */
    notes: string[];
}

export function emptyFacts(root: string): Facts {
    return {
        root,
        files: [],
        modules: [],
        stateVariables: [],
        writes: [],
        reads: [],
        switches: [],
        resources: [],
        classes: [],
        interfaces: [],
        instantiations: [],
        functions: [],
        declaredMachines: [],
        notes: []
    };
}

/** Facts of both inputs (neither is changed). */
export function mergeFacts(a: Facts, b: Facts): Facts {
    return {
        root: a.root,
        files: [...a.files, ...b.files],
        modules: [...a.modules, ...b.modules],
        stateVariables: [...a.stateVariables, ...b.stateVariables],
        writes: [...a.writes, ...b.writes],
        reads: [...a.reads, ...b.reads],
        switches: [...a.switches, ...b.switches],
        resources: [...a.resources, ...b.resources],
        classes: [...a.classes, ...b.classes],
        interfaces: [...a.interfaces, ...b.interfaces],
        instantiations: [...a.instantiations, ...b.instantiations],
        functions: [...a.functions, ...b.functions],
        declaredMachines: [...a.declaredMachines, ...b.declaredMachines],
        notes: [...a.notes, ...b.notes]
    };
}

export function formatLocation(loc: Location): string {
    return `${loc.file}:${loc.line}`;
}
