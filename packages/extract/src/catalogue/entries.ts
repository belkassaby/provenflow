/**
 * The entries of the patterns and practices catalogue. Each one is written in the narrative form of
 * Fowler's "Writing Software Patterns" (https://martinfowler.com/articles/writingPatterns.html):
 * a short noun-phrase name, the solution first (summary), the problem that triggers it, how it works,
 * when to use it and when not to, and a small example. `rules` are the findings that check it.
 */
import type { Practice } from './types.js';

const PRAGMATIC = 'The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)';
const PRAGMATIC_URL = 'https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/';
const GOF = 'Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994)';
const REFACTORING = 'Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code';
const REFACTORING_URL = 'https://refactoring.com/catalog/';

const pragmatic = (topic: string) => ({ title: PRAGMATIC, where: topic, url: PRAGMATIC_URL });
const gof = (where: string) => ({ title: GOF, where });
const refactoring = (where: string) => ({ title: REFACTORING, where, url: REFACTORING_URL });

export const PATTERNS_CATALOGUE: Practice[] = [
    {
        id: 'singleton',
        name: 'Singleton',
        kind: 'pattern',
        summary: 'One shared instance of a class, obtained through one access point.',
        problem: 'Some objects must exist once per program: a store of application state, a connection pool, a registry. If code creates them freely, two copies drift apart and each part of the program sees a different truth.',
        solution: 'Hide the constructor (or let the dependency-injection container own the instance) and hand out the single instance from one place: a static accessor, a module-level instance, or a root-provided service.',
        use: 'For state or resources that really are global to the program, and when the instance is reached through the injector rather than a hard-coded global.',
        avoid: 'Not as a convenient global variable: a singleton is still global state (see No Global Data). Prefer passing the object in when only a few callers need it; tests then get their own copy.',
        example: {
            file: 'example.ts',
            before: `export class Settings {\n    values = new Map<string, string>();\n}\n\n// in two places\nconst a = new Settings();\nconst b = new Settings(); // a second, diverging copy\n`,
            after: `@Injectable({ providedIn: 'root' })\nexport class Settings {\n    values = new Map<string, string>();\n}\n\n// everywhere\nconst settings = inject(Settings);\n`
        },
        checks: 'Recognises singletons (private constructor with a static instance, `providedIn: \'root\'`, language-level objects) and reports any code that creates another instance. A model checked with nuXmv proves the instance is never created twice.',
        rules: ['singleton-bypassed'],
        detects: true,
        sources: [gof('Singleton, p. 127')],
        related: ['no-global-data'],
        selected: true
    },
    {
        id: 'observer',
        name: 'Observer',
        kind: 'pattern',
        summary: 'Subscribers register with a subject and are notified when it changes; each can unsubscribe.',
        problem: 'Several parts of a program react to the same change. If the subject calls each of them directly, it depends on all of them and every new reaction means editing it.',
        solution: 'The subject keeps a collection of listeners, offers subscribe() returning a way to unsubscribe, and calls every listener in notify(). Listeners know the subject; the subject knows only the listener interface.',
        use: 'When the set of reactions changes at run time, or belongs to other modules.',
        avoid: 'When there is one fixed reaction: a direct call is simpler to follow. Every subscription that is never removed is a memory leak and a source of calls on dead objects.',
        example: {
            file: 'example.ts',
            before: `class Cart {\n    private listeners: Array<() => void> = [];\n    onChange(listener: () => void) {\n        this.listeners.push(listener); // no way to stop listening\n    }\n}\n`,
            after: `class Cart {\n    private listeners = new Set<() => void>();\n    onChange(listener: () => void): () => void {\n        this.listeners.add(listener);\n        return () => this.listeners.delete(listener);\n    }\n}\n`
        },
        checks: 'Recognises subjects (a listener collection, subscribe and notify) and reports those whose listeners cannot be removed, and listeners added to DOM or event sources that are never removed. A model proves a subscriber can always detach.',
        rules: ['observer-cannot-unsubscribe', 'unremovable-listener'],
        detects: true,
        sources: [gof('Observer, p. 293')],
        related: ['finish-what-you-start'],
        selected: true
    },
    {
        id: 'factory',
        name: 'Factory',
        kind: 'pattern',
        summary: 'One function or method creates the right product and returns it as their common interface.',
        problem: 'Code that needs one of several related objects ends up full of `new` calls and conditions choosing which class to build, repeated wherever such an object is needed.',
        solution: 'Put the choice and the construction in one create function, returning the products\' shared interface, so callers depend on the interface only.',
        use: 'When the class to create depends on data or configuration, or construction is involved enough to deserve one home.',
        avoid: 'For a single concrete class with a plain constructor: the factory adds a name and nothing else.',
        example: {
            file: 'example.ts',
            before: `const exporter = format === 'csv' ? new CsvExporter() : new JsonExporter();\n// ... the same choice again in three other files\n`,
            after: `export function createExporter(format: 'csv' | 'json'): Exporter {\n    return format === 'csv' ? new CsvExporter() : new JsonExporter();\n}\n`
        },
        checks: 'Recognises factories (create functions returning several classes) and reports those whose products share no interface or base class.',
        rules: ['factory-products-unrelated'],
        detects: true,
        sources: [gof('Factory Method, p. 107; Abstract Factory, p. 87')],
        related: ['strategy'],
        selected: true
    },
    {
        id: 'strategy',
        name: 'Strategy',
        kind: 'pattern',
        summary: 'A family of interchangeable algorithms behind one interface, chosen at run time.',
        problem: 'A function switches on a kind to decide how to do something, and each new kind means another branch in it and in every other function that switches the same way.',
        solution: 'Define the behaviour as an interface (or a function type), give each variant its own implementation, and let the caller hold whichever one applies.',
        use: 'When variants are added over time, or chosen by configuration.',
        avoid: 'For two variants that will not grow: an if is easier to read than an interface and two classes.',
        example: {
            file: 'example.ts',
            before: `function price(order: Order): number {\n    if (order.customer === 'staff') return order.total * 0.8;\n    if (order.customer === 'member') return order.total * 0.9;\n    return order.total;\n}\n`,
            after: `interface Pricing { price(total: number): number }\nconst STAFF: Pricing = { price: total => total * STAFF_RATE };\nconst MEMBER: Pricing = { price: total => total * MEMBER_RATE };\n\nfunction price(order: Order, pricing: Pricing): number {\n    return pricing.price(order.total);\n}\n`
        },
        checks: 'Recognises strategy families (an interface with several implementations used through it) and reports implementations that leave methods unimplemented.',
        rules: ['strategy-not-implemented'],
        detects: true,
        sources: [gof('Strategy, p. 315')],
        related: ['factory', 'state'],
        selected: true
    },
    {
        id: 'builder',
        name: 'Builder',
        kind: 'pattern',
        summary: 'An object assembled step by step through fluent methods, checked once in build().',
        problem: 'A constructor with many optional parameters is hard to call correctly, and an object filled in field by field can be used before it is complete.',
        solution: 'A builder collects the parts through methods returning the builder, and build() validates that the required parts are there before creating the object.',
        use: 'For objects with many optional parts, or parts that must be consistent with each other.',
        avoid: 'For objects with two or three required fields: a constructor (or an options object) says it in one line.',
        example: {
            file: 'example.ts',
            before: `class RequestBuilder {\n    private url?: string;\n    to(url: string) { this.url = url; return this; }\n    build() { return new Request(this.url!); } // builds without a URL\n}\n`,
            after: `class RequestBuilder {\n    private url?: string;\n    to(url: string) { this.url = url; return this; }\n    build() {\n        if (!this.url) throw new Error('A request needs a URL: call to() first.');\n        return new Request(this.url);\n    }\n}\n`
        },
        checks: 'Recognises builders (fluent methods returning this, a build method) and reports a build() that does not validate. A model proves the product is never built unconfigured.',
        rules: ['builder-builds-unconfigured'],
        detects: true,
        sources: [gof('Builder, p. 97')],
        related: ['assertive-programming'],
        selected: true
    },
    {
        id: 'adapter',
        name: 'Adapter',
        kind: 'pattern',
        summary: 'A class that gives an existing object the interface its callers expect.',
        problem: 'A library or legacy component does the right thing behind the wrong interface, and the calls translating between the two are spread through the code.',
        solution: 'Implement the expected interface in one class that holds the adaptee and translates each call to it.',
        use: 'At the boundary with code you do not own or cannot change.',
        avoid: 'Between two of your own interfaces that could simply agree.',
        example: {
            file: 'example.ts',
            before: `class LegacyLoggerAdapter implements Logger {\n    constructor(private legacy: LegacyLogger) {}\n    info(message: string) { this.legacy.write('INFO', message); }\n    error(message: string): void { throw new Error('not implemented'); }\n}\n`,
            after: `class LegacyLoggerAdapter implements Logger {\n    constructor(private legacy: LegacyLogger) {}\n    info(message: string) { this.legacy.write('INFO', message); }\n    error(message: string) { this.legacy.write('ERROR', message); }\n}\n`
        },
        checks: 'Recognises adapters (most methods forward to one wrapped object) and reports methods that only throw.',
        rules: ['adapter-incomplete'],
        detects: true,
        sources: [gof('Adapter, p. 139')],
        related: ['decorator', 'facade'],
        selected: true
    },
    {
        id: 'decorator',
        name: 'Decorator',
        kind: 'pattern',
        summary: 'A wrapper with the same interface as the object it wraps, adding behaviour around each call.',
        problem: 'Behaviour such as caching, logging or retries is wanted on some instances, and subclassing for every combination multiplies classes.',
        solution: 'Implement the same interface as the wrapped object, forward each call to it, and add the extra behaviour before or after.',
        use: 'For cross-cutting behaviour to combine freely at run time.',
        avoid: 'When a single fixed behaviour belongs in the class itself.',
        example: {
            file: 'example.ts',
            before: `class CachedRepository implements Repository {\n    constructor(private inner: Repository) {}\n    find(id: string) { return this.inner.find(id); }\n    save(item: Item): void { throw new Error('TODO'); }\n}\n`,
            after: `class CachedRepository implements Repository {\n    private cache = new Map<string, Item>();\n    constructor(private inner: Repository) {}\n    find(id: string) { return this.cache.get(id) ?? this.inner.find(id); }\n    save(item: Item) { this.cache.delete(item.id); this.inner.save(item); }\n}\n`
        },
        checks: 'Recognises decorators (same interface as the forwarded-to field) and reports methods that only throw.',
        rules: ['decorator-incomplete'],
        detects: true,
        sources: [gof('Decorator, p. 175')],
        related: ['adapter'],
        selected: true
    },
    {
        id: 'state',
        name: 'State',
        kind: 'pattern',
        summary: 'An object\'s behaviour delegated to one class per state, each returning the next state.',
        problem: 'Every method of an object starts with a switch on its current state, and the rules of which state follows which are scattered across them.',
        solution: 'Give each state a class implementing a common interface; the object delegates to its current state, and each state decides the next one.',
        use: 'When behaviour differs a lot between states and the states form a real lifecycle.',
        avoid: 'For two or three states with little behaviour each: an enum and a switch (checked for exhaustiveness) are clearer.',
        example: {
            file: 'example.ts',
            before: `class Order {\n    state: 'new' | 'paid' | 'shipped' | 'refunded' = 'new';\n    pay() { if (this.state === 'new') this.state = 'paid'; }\n    ship() { if (this.state === 'paid') this.state = 'shipped'; }\n    // nothing ever sets 'refunded'\n}\n`,
            after: `interface OrderState { pay(): OrderState; ship(): OrderState }\nclass New implements OrderState { pay() { return new Paid(); } ship() { return this; } }\nclass Paid implements OrderState { pay() { return this; } ship() { return new Shipped(); } }\nclass Shipped implements OrderState { pay() { return this; } ship() { return this; } }\n`
        },
        checks: 'Recognises State patterns (a family of state classes) and builds their transition model; nuXmv proves every state is reachable.',
        rules: ['pattern:unreachable-state'],
        detects: true,
        sources: [gof('State, p. 305')],
        related: ['strategy', 'assertive-programming'],
        selected: true
    },
    {
        id: 'command',
        name: 'Command',
        kind: 'pattern',
        summary: 'Each action as an object with execute(), and undo() when it can be reversed.',
        problem: 'Actions must be queued, logged, retried or undone, but they are method calls that leave no trace once made.',
        solution: 'Represent each action as an object implementing a common interface, holding what it needs to execute, and to undo when undo is supported.',
        use: 'For undo and redo, macros, job queues, and auditable operations.',
        avoid: 'For actions that are only ever called directly once.',
        example: {
            file: 'example.ts',
            before: `class RenameCommand implements Command {\n    constructor(private file: File, private name: string) {}\n    execute() { this.file.rename(this.name); }\n}\n`,
            after: `class RenameCommand implements Command {\n    private previous = '';\n    constructor(private file: File, private name: string) {}\n    execute() { this.previous = this.file.name; this.file.rename(this.name); }\n    undo() { this.file.rename(this.previous); }\n}\n`
        },
        checks: 'Recognises command families and reports commands missing the undo() their siblings have.',
        rules: ['command-missing-undo'],
        detects: true,
        sources: [gof('Command, p. 233')],
        related: [],
        selected: true
    },
    {
        id: 'facade',
        name: 'Facade',
        kind: 'pattern',
        summary: 'One entry module through which a package is used, hiding its inner files.',
        problem: 'Callers import files deep inside a package, so every internal move or rename breaks them, and nothing says what the package offers.',
        solution: 'Give the package an entry module (index) that exports its public interface, and import only from it.',
        use: 'For every package or layer used by others.',
        avoid: 'Inside a package: its own files import each other directly.',
        example: {
            file: 'example.ts',
            before: `import { parse } from '@acme/language/src/internal/parser';\n`,
            after: `import { parse } from '@acme/language';\n`
        },
        checks: 'Recognises packages with an entry module and reports imports that bypass it (with `packageEntries` or a facade declared in provenflow.config.json).',
        rules: ['facade-bypassed'],
        detects: true,
        sources: [gof('Facade, p. 185')],
        related: ['orthogonality'],
        selected: true
    },
    {
        id: 'dry',
        name: 'DRY: Don\'t Repeat Yourself',
        kind: 'principle',
        summary: 'Every piece of knowledge has a single, unambiguous, authoritative representation in the system.',
        problem: 'The same logic copied into several places has to be changed in all of them; the copy someone forgets is the next bug. AI coding agents copy readily, because writing new code is easier for them than finding the existing one.',
        solution: 'Find the existing implementation and reuse it; when two copies exist, extract the shared logic into one function and call it from both.',
        use: 'Whenever the same rule, algorithm or fact appears twice. DRY is about knowledge, not text: two lines that look alike but mean different things may stay apart.',
        avoid: 'Do not merge code that is only coincidentally similar, or tie together modules that should evolve independently just to share three lines.',
        example: {
            file: 'example.ts',
            before: `function cartTotal(items: Item[]) {\n    return items.reduce((sum, i) => sum + i.price * i.quantity * (1 + i.taxRate), 0);\n}\nfunction invoiceTotal(lines: Item[]) {\n    return lines.reduce((sum, l) => sum + l.price * l.quantity * (1 + l.taxRate), 0);\n}\n`,
            after: `export function total(items: Item[]) {\n    return items.reduce((sum, i) => sum + i.price * i.quantity * (1 + i.taxRate), 0);\n}\nconst cartTotal = total;\nconst invoiceTotal = total;\n`
        },
        checks: 'Finds copied blocks (exact and renamed, 100 tokens or more) and functions that are about 80% alike, and says which copy to reuse. The MCP tool find_existing_code lets an agent look before it writes.',
        rules: ['duplicated-code', 'similar-function'],
        sources: [pragmatic('Topic 9: DRY—The Evils of Duplication')],
        related: ['orthogonality'],
        selected: true
    },
    {
        id: 'orthogonality',
        name: 'Orthogonality',
        kind: 'principle',
        summary: 'Unrelated things stay independent: changing one never requires changing the other.',
        problem: 'When modules reach into each other freely, a change in one ripples through the others, and nothing can be tested, replaced or understood alone.',
        solution: 'Group the code into layers with declared dependencies, keep each layer to what it may import, and make the dependencies point one way.',
        use: 'Everywhere; layers declared in provenflow.config.json make the intended structure checkable.',
        avoid: 'Do not split code that changes together into separate layers just for symmetry.',
        example: {
            file: 'example.ts',
            before: `// packages/core/src/prices.ts\nimport { showToast } from '../../ui/src/toast'; // core now depends on the UI\n`,
            after: `// packages/core/src/prices.ts\nexport function price(...) { ... } // returns a value; the UI decides how to show it\n`
        },
        checks: 'Checks every import against the layers declared in provenflow.config.json, and reports cycles between layers.',
        rules: ['layer-violation', 'layer-cycle'],
        sources: [pragmatic('Topic 10: Orthogonality')],
        related: ['law-of-demeter', 'cyclic-dependency', 'facade'],
        selected: true
    },
    {
        id: 'law-of-demeter',
        name: 'Law of Demeter',
        kind: 'principle',
        summary: 'A method talks only to its friends: its object, its parameters, what it creates, and its direct parts.',
        problem: 'A chain such as `order.customer().address().country().code()` hard-codes the structure of four objects into the caller. Any change in that structure breaks code far away. The Pragmatic Programmer calls these chains train wrecks.',
        solution: 'Ask the nearest object for what you need: give it a method that does the work (or returns exactly the value needed), or pass the value in.',
        use: 'Whenever a method navigates through objects it does not own to reach the one it needs.',
        avoid: 'Fluent interfaces and pipelines that return the same kind of object (collections, strings, builders, queries) are not train wrecks: they do not reveal anyone\'s structure.',
        example: {
            file: 'example.ts',
            before: `function shippingZone(order: Order) {\n    return order.customer.address.country.zone();\n}\n`,
            after: `function shippingZone(order: Order) {\n    return order.shippingZone(); // Order knows how to find it\n}\n`
        },
        checks: 'Finds member chains reaching through three or more objects, other than fluent calls and namespaces (a heuristic on the code\'s text).',
        rules: ['train-wreck'],
        sources: [pragmatic('Topic 28: Decoupling (Train Wrecks; Don\'t Chain Method Calls)')],
        related: ['tell-dont-ask', 'orthogonality'],
        selected: true
    },
    {
        id: 'tell-dont-ask',
        name: 'Tell, Don\'t Ask',
        kind: 'principle',
        summary: 'Tell an object what to do; do not ask for its state, decide for it and change it from outside.',
        problem: 'Logic that reads an object\'s fields and then writes them back lives outside the object that owns the data, so the object\'s rules are repeated, and bypassed, by every caller.',
        solution: 'Move the decision into a method of the object that owns the data, and call that method.',
        use: 'In object-oriented code, whenever a function changes an object it received.',
        avoid: 'Plain data records passed through a pipeline of functions are meant to be transformed (see Transforming Programming).',
        example: {
            file: 'example.ts',
            before: `function applyDiscount(cart: Cart, rate: number) {\n    if (cart.total > 100) cart.total = cart.total * (1 - rate);\n}\n`,
            after: `class Cart {\n    applyDiscount(rate: number) {\n        if (this.total > DISCOUNT_THRESHOLD) this.total *= 1 - rate;\n    }\n}\n`
        },
        checks: 'In layers declared object-oriented, reports free functions that change the objects they receive.',
        rules: ['oop-mutates-foreign-object'],
        sources: [pragmatic('Topic 28: Decoupling (Tell, Don\'t Ask)')],
        related: ['law-of-demeter'],
        selected: true
    },
    {
        id: 'no-global-data',
        name: 'No Global Data',
        kind: 'principle',
        summary: 'Mutable state lives in an object or is passed in, never in a module-level variable.',
        problem: 'Every function can read and change a global, so it couples them all: their order matters, tests leak state into each other, and concurrent code races on it.',
        solution: 'Put the state into the object (or service) that owns it, or pass it as a parameter; keep module-level values constant.',
        use: 'Always for mutable state. Constants and lazily created, immutable caches are fine at module level.',
        avoid: 'A single, injected service (see Singleton) is the accepted way to share program-wide state.',
        example: {
            file: 'example.ts',
            before: `let currentUser: User | undefined;\nexport function login(user: User) { currentUser = user; }\n`,
            after: `export class Session {\n    private user?: User;\n    login(user: User) { this.user = user; }\n}\n`
        },
        checks: 'Reports module-level mutable variables in every layer, by declared style.',
        rules: ['fp-mutable-global', 'oop-mutable-global'],
        sources: [pragmatic('Topic 28: Decoupling (The Evils of Globalization)'), pragmatic('Topic 34: Shared State Is Incorrect State')],
        related: ['singleton', 'shared-state'],
        selected: true
    },
    {
        id: 'transforming-programming',
        name: 'Transforming Programming',
        kind: 'principle',
        summary: 'Functions transform their inputs into new outputs, without changing what they were given.',
        problem: 'A function that changes its arguments or the variables around it has effects its signature does not show; callers cannot reason about it, and it cannot be reused safely.',
        solution: 'Return new values instead of changing inputs; keep state in data passed from one transformation to the next.',
        use: 'In layers declared functional (provenflow.config.json "style": "functional").',
        avoid: 'Local mutation inside a function, invisible to its callers, is fine and often clearer.',
        example: {
            file: 'example.ts',
            before: `export function addTax(items: Item[]) {\n    for (const i of items) i.price *= 1 + TAX_RATE; // changes the caller's items\n}\n`,
            after: `export function withTax(items: Item[]): Item[] {\n    return items.map(i => ({ ...i, price: i.price * (1 + TAX_RATE) }));\n}\n`
        },
        checks: 'In layers declared functional, reports exported functions that change their arguments or outer variables, and classes with mutable state.',
        rules: ['fp-mutates-argument', 'fp-writes-outer-state', 'fp-class'],
        sources: [pragmatic('Topic 30: Transforming Programming')],
        related: ['no-global-data', 'tell-dont-ask'],
        selected: true
    },
    {
        id: 'inheritance-tax',
        name: 'Inheritance Tax',
        kind: 'principle',
        summary: 'Prefer interfaces, delegation and composition to deep class hierarchies.',
        problem: 'Each level of inheritance couples a class to every ancestor\'s implementation; a change at the top ripples down, and understanding a method means reading the whole chain.',
        solution: 'Share behaviour through interfaces (or protocols) and delegate to helper objects; keep hierarchies shallow.',
        use: 'Whenever a hierarchy grows beyond the limit (three levels by default).',
        avoid: 'Framework base classes you must extend count as one level; that is not a design choice.',
        example: {
            file: 'example.ts',
            before: `class Animal {}\nclass Mammal extends Animal {}\nclass Dog extends Mammal {}\nclass GuideDog extends Dog {}\n`,
            after: `interface Guide { guide(person: Person): void }\nclass GuideDog implements Guide {\n    constructor(private dog: Dog) {}\n    guide(person: Person) { ... }\n}\n`
        },
        checks: 'Reports classes whose inheritance chain is deeper than limits.inheritanceDepth.',
        rules: ['deep-inheritance'],
        sources: [pragmatic('Topic 31: Inheritance Tax')],
        related: ['decorator'],
        selected: true
    },
    {
        id: 'dead-programs-tell-no-lies',
        name: 'Dead Programs Tell No Lies',
        kind: 'principle',
        summary: 'Crash early: a program that stops where the problem is does less damage than one that carries on.',
        problem: 'An empty catch (or `except: pass`) drops an error on the floor. The program continues in a state nobody checked, and the failure shows up later, far from its cause, or as silently wrong data.',
        solution: 'Handle the error where something can be done about it (recover, retry, return an error value), or let it propagate. When ignoring it really is right, say why in the block.',
        use: 'For every error handler.',
        avoid: 'Cleanup that may fail harmlessly (removing a temporary file that may not exist) can ignore its error, with a comment saying so.',
        example: {
            file: 'example.ts',
            before: `try {\n    config = JSON.parse(text);\n} catch {}\n`,
            after: `try {\n    config = JSON.parse(text);\n} catch (error) {\n    throw new Error(\`\${file} is not valid JSON: \${(error as Error).message}\`);\n}\n`
        },
        checks: 'Finds empty handlers in every supported language: catch {}, except: pass, rescue with no body, if err != nil {}. Handlers holding a comment are taken as deliberate.',
        rules: ['empty-catch'],
        autoFix: 'Rethrows the caught error (raise in Python), for review: if the error is expected, handle it instead.',
        sources: [pragmatic('Topic 24: Dead Programs Tell No Lies')],
        related: ['assertive-programming'],
        selected: true
    },
    {
        id: 'assertive-programming',
        name: 'Assertive Programming',
        kind: 'principle',
        summary: 'If it can\'t happen, make sure it won\'t: handle every case, and fail loudly on the impossible one.',
        problem: 'A switch over a set of kinds that misses one silently does nothing for it, and adding a kind later leaves every such switch quietly incomplete.',
        solution: 'Handle every case; end the switch with a default that throws, and in TypeScript assign the subject to `never` so the compiler flags new kinds.',
        use: 'For every dispatch over a closed set of values: enums, union types, state names.',
        avoid: 'Assertions are not error handling for expected conditions such as bad user input.',
        example: {
            file: 'example.ts',
            before: `switch (shape.kind) {\n    case 'circle': return circleArea(shape);\n    case 'square': return squareArea(shape);\n} // 'triangle' falls through, returns undefined\n`,
            after: `switch (shape.kind) {\n    case 'circle': return circleArea(shape);\n    case 'square': return squareArea(shape);\n    case 'triangle': return triangleArea(shape);\n    default: { const unreachable: never = shape; throw new Error(\`Unknown shape \${unreachable}\`); }\n}\n`
        },
        checks: 'Reports switches and if-chains over an enum or union type that miss values and have no default, with a verified fix adding the missing cases.',
        rules: ['non-exhaustive-dispatch'],
        autoFix: 'Adds the missing cases (verified by re-running the checks and the build).',
        sources: [pragmatic('Topic 25: Assertive Programming'), pragmatic('Topic 23: Design by Contract')],
        related: ['dead-programs-tell-no-lies', 'state'],
        selected: true
    },
    {
        id: 'finish-what-you-start',
        name: 'Finish What You Start',
        kind: 'principle',
        summary: 'The code that acquires a resource releases it, on every path, including errors.',
        problem: 'A file, connection, timer or subscription opened in one place and closed somewhere else, or only on the happy path, leaks when an error or early return skips the release.',
        solution: 'Release in the same scope that acquired: try/finally, using/with/defer, or a scope that owns the resource and disposes of it.',
        use: 'For every resource: files, sockets, locks, timers, listeners, subscriptions.',
        avoid: 'Resources owned by a framework lifecycle (released in its destroy hook) belong to that object; the check follows them there.',
        example: {
            file: 'example.ts',
            before: `const handle = await open(path);\nconst text = await handle.readFile('utf8'); // throws: the handle stays open\nawait handle.close();\n`,
            after: `const handle = await open(path);\ntry {\n    return await handle.readFile('utf8');\n} finally {\n    await handle.close();\n}\n`
        },
        checks: 'Models each resource\'s lifecycle and proves with nuXmv that it is released on every path; reports leaks and releases that an error can skip.',
        rules: ['resource-leak', 'release-not-guaranteed'],
        autoFix: 'Adds the release in a finally block (verified).',
        sources: [pragmatic('Topic 26: How to Balance Resources')],
        related: ['observer'],
        selected: true
    },
    {
        id: 'shared-state',
        name: 'Shared State Is Incorrect State',
        kind: 'principle',
        summary: 'State read before an await may be stale after it: check again, or do not share it.',
        problem: 'Code reads a shared value, awaits something, then writes based on what it read. Meanwhile another task changed the value, and the write undoes that change: a race with no threads in sight.',
        solution: 'Re-read (and re-check) the state after the await, make the update atomic, or give the state a single owner that serialises changes.',
        use: 'In asynchronous code that updates state other tasks can see.',
        avoid: 'State local to the function, which nothing else can change during the await.',
        example: {
            file: 'example.ts',
            before: `if (this.state === 'idle') {\n    await this.load();\n    this.state = 'ready'; // another call may have closed it meanwhile\n}\n`,
            after: `if (this.state === 'idle') {\n    await this.load();\n    if (this.state === 'idle') this.state = 'ready';\n}\n`
        },
        checks: 'Reports writes to state variables after an await that were decided before it, with a verified fix re-checking the state.',
        rules: ['stale-write-after-await'],
        autoFix: 'Re-checks the state after the await (verified).',
        sources: [pragmatic('Topic 34: Shared State Is Incorrect State'), pragmatic('Topic 33: Breaking Temporal Coupling')],
        related: ['no-global-data'],
        selected: true
    },
    {
        id: 'naming-things',
        name: 'Naming Things',
        kind: 'principle',
        summary: 'Names follow one convention per kind, the project\'s own first, so a name says what a thing is.',
        problem: 'Mixed conventions (getUser, get_order, FetchItem) make readers stop and wonder whether the difference means something, and make code harder to search.',
        solution: 'Follow the project\'s convention for each kind of name (class, function, method, field, constant), falling back on the language\'s style guide.',
        use: 'For every new name, and when renaming.',
        avoid: 'Names imposed from outside (framework hooks, generated code, external APIs) keep their own spelling: list them under "ignore" with the reason.',
        example: {
            file: 'example.py',
            before: `def GetUser(id):\n    ...\n\ndef get_order(id):\n    ...\n`,
            after: `def get_user(id):\n    ...\n\ndef get_order(id):\n    ...\n`
        },
        checks: 'Infers the convention for each kind of name from the code (80% of at least 8 names), else applies the language\'s style guide, and reports names that do not fit, with the rename.',
        rules: ['naming-convention'],
        sources: [pragmatic('Topic 44: Naming Things')],
        related: [],
        selected: true
    },
    {
        id: 'test-to-code',
        name: 'Test to Code',
        kind: 'principle',
        summary: 'Test early, test often, test automatically; and test the tests by breaking the code on purpose.',
        problem: 'Complex functions without tests, and changes merged without one, are where regressions hide. Coverage alone can be satisfied by tests that assert nothing.',
        solution: 'Add a test with each change, cover the complex functions first, and run mutation testing (a saboteur) to check that the tests notice when the code is broken.',
        use: 'For every change; in CI with coverage reports, and mutation testing on the changed lines.',
        avoid: 'Do not chase 100% coverage of trivial code; spend the tests where the complexity is.',
        example: {
            file: 'example.ts',
            before: `// src/discount.ts changed: a new rule for members\n// no test file changed\n`,
            after: `// test/discount.test.ts\nit('gives members 10% off', () => {\n    expect(price({ total: 50, customer: 'member' })).toBe(45);\n});\n`
        },
        checks: 'Reports complex functions with no coverage, changed lines no test covers, source changes without a test change, and mutants the tests do not kill (with coverage reports and pflow mutate).',
        rules: ['untested-complex-function', 'uncovered-change', 'change-without-test', 'mutant-survived'],
        sources: [pragmatic('Topic 41: Test to Code'), pragmatic('Topic 51: Pragmatic Starter Kit (Use Saboteurs to Test Your Testing)')],
        related: ['complex-function'],
        selected: true
    },
    {
        id: 'god-class',
        name: 'God Class',
        kind: 'anti-pattern',
        summary: 'One class that knows and does too much: split it by responsibility.',
        problem: 'A class with dozens of methods and hundreds of lines becomes the place every change goes. Everything depends on it, it is hard to test, and two people cannot work on it at once.',
        solution: 'Find the groups of fields and methods used together and extract each into its own class (Extract Class); keep the original as a thin coordinator, or remove it.',
        use: 'Classes over the size limits (30 methods or 600 lines by default) are reported.',
        avoid: 'Generated classes and facades that only forward calls are large without being responsible for much.',
        example: {
            file: 'example.ts',
            before: `class OrderManager {\n    // pricing, tax, stock, shipping, invoices, e-mails... 45 methods\n}\n`,
            after: `class Pricing { ... }\nclass Stock { ... }\nclass Shipping { ... }\nclass Invoicing { ... }\n`
        },
        checks: 'Reports classes over limits.classMethods or limits.classLines.',
        rules: ['god-class'],
        sources: [{ title: 'AntiPatterns (Brown, Malveau, McCormick and Mowbray, 1998)', where: 'The Blob' }, refactoring('Large Class; Extract Class')],
        related: ['long-function', 'orthogonality'],
        selected: true
    },
    {
        id: 'long-function',
        name: 'Long Function',
        kind: 'anti-pattern',
        summary: 'A function too long to see at once: extract the parts into well-named functions.',
        problem: 'A long function mixes several steps and levels of detail; readers have to hold all of it in mind, and its parts cannot be reused or tested alone.',
        solution: 'Extract each step into a function whose name says what it does (Extract Function); the original reads as a list of steps.',
        use: 'Functions over the language\'s limit (50 lines for TypeScript and Python by default) are reported.',
        avoid: 'A long but flat table or switch of data may read better whole.',
        example: {
            file: 'example.ts',
            before: `function report(data: Row[]) {\n    // 30 lines validating\n    // 40 lines aggregating\n    // 30 lines formatting\n}\n`,
            after: `function report(data: Row[]) {\n    const rows = validate(data);\n    const totals = aggregate(rows);\n    return format(totals);\n}\n`
        },
        checks: 'Reports functions over limits.functionLines (per language).',
        rules: ['long-function'],
        sources: [refactoring('Long Function; Extract Function')],
        related: ['complex-function', 'god-class'],
        selected: true
    },
    {
        id: 'long-parameter-list',
        name: 'Long Parameter List',
        kind: 'anti-pattern',
        summary: 'Too many parameters: group the ones that travel together into an object.',
        problem: 'Calls with many positional arguments are easy to get wrong (two numbers swapped compile fine), and every new option changes every caller.',
        solution: 'Introduce a parameter object for values that go together, or pass the object the values come from (Introduce Parameter Object, Preserve Whole Object).',
        use: 'Functions over the language\'s limit (7 for TypeScript, 5 for Python by default) are reported.',
        avoid: 'Constructors used by a dependency injector take their dependencies as parameters by design.',
        example: {
            file: 'example.ts',
            before: `function book(name: string, from: Date, to: Date, rooms: number, adults: number, children: number, breakfast: boolean) { ... }\n`,
            after: `interface Booking { name: string; stay: { from: Date; to: Date }; rooms: number; guests: { adults: number; children: number }; breakfast: boolean }\nfunction book(booking: Booking) { ... }\n`
        },
        checks: 'Reports functions over limits.functionParams (per language).',
        rules: ['many-parameters'],
        sources: [refactoring('Long Parameter List; Introduce Parameter Object')],
        related: ['flag-argument'],
        selected: true
    },
    {
        id: 'complex-function',
        name: 'Complex Function',
        kind: 'anti-pattern',
        summary: 'Logic too tangled to follow: simplify the conditions and split the function.',
        problem: 'Every branch, loop and boolean operator adds to what a reader must track, and nesting multiplies it. Past a point nobody can tell what the function does in every case, or test them all.',
        solution: 'Replace nested conditions with guard clauses, extract conditions and loop bodies into named functions, and replace a conditional on type with polymorphism.',
        use: 'Functions over the Cognitive Complexity limit (15 by default) are reported.',
        avoid: 'A flat switch over many cases scores low by design: it is easy to read.',
        example: {
            file: 'example.ts',
            before: `function shipping(order: Order) {\n    if (order.items.length) {\n        if (order.country === 'US') {\n            if (order.total > 100) return 0; else return 5;\n        } else { ... }\n    }\n}\n`,
            after: `function shipping(order: Order) {\n    if (!order.items.length) return 0;\n    if (order.country !== 'US') return international(order);\n    return order.total > FREE_SHIPPING ? 0 : US_SHIPPING;\n}\n`
        },
        checks: 'Measures Cognitive Complexity (SonarSource) for each function in every supported language and reports those over the limit.',
        rules: ['cognitive-complexity'],
        sources: [{ title: 'Cognitive Complexity (G. Ann Campbell, SonarSource, 2018)', where: 'white paper', url: 'https://www.sonarsource.com/docs/CognitiveComplexity.pdf' }, refactoring('Decompose Conditional; Replace Nested Conditional with Guard Clauses')],
        related: ['arrow-code', 'long-function'],
        selected: true
    },
    {
        id: 'arrow-code',
        name: 'Arrow Code',
        kind: 'anti-pattern',
        summary: 'Code nested so deep it points right like an arrowhead: flatten it with guard clauses.',
        problem: 'Each level of nesting is another condition the reader must keep in mind to understand a line; deep nesting hides which branch handles what.',
        solution: 'Return early for the exceptional cases (guard clauses), invert conditions, and extract inner blocks into functions.',
        use: 'Functions nested deeper than the language\'s limit (4 for TypeScript, 5 for Python by default) are reported.',
        avoid: 'Nested data literals are not control flow and are not counted.',
        example: {
            file: 'example.py',
            before: `def process(request):\n    if request:\n        if request.user:\n            if request.user.active:\n                for item in request.items:\n                    if item.valid:\n                        handle(item)\n`,
            after: `def process(request):\n    if not request or not request.user or not request.user.active:\n        return\n    for item in request.items:\n        if item.valid:\n            handle(item)\n`
        },
        checks: 'Measures the deepest nesting of control flow in each function and reports those over the limit.',
        rules: ['deep-nesting'],
        sources: [refactoring('Replace Nested Conditional with Guard Clauses')],
        related: ['complex-function'],
        selected: true
    },
    {
        id: 'cyclic-dependency',
        name: 'Cyclic Dependency',
        kind: 'anti-pattern',
        summary: 'Modules that import each other in a cycle: break it by moving the shared part or inverting a dependency.',
        problem: 'Modules in an import cycle cannot be understood, tested or built separately; load order starts to matter, and a change anywhere in the cycle can break all of it.',
        solution: 'Move what both sides need into a third module they both import, or invert one dependency through an interface owned by the lower module.',
        use: 'Every cycle between files is reported.',
        avoid: 'Type-only imports in TypeScript do not create a cycle at run time, but they still tie the modules together.',
        example: {
            file: 'example.ts',
            before: `// a.ts\nimport { b } from './b';\n// b.ts\nimport { a } from './a';\n`,
            after: `// shared.ts: what both need\n// a.ts\nimport { shared } from './shared';\n// b.ts\nimport { shared } from './shared';\n`
        },
        checks: 'Reports import cycles between files.',
        rules: ['import-cycle'],
        sources: [{ title: 'Granularity (Robert C. Martin, C++ Report, 1996)', where: 'The Acyclic Dependencies Principle' }],
        related: ['orthogonality'],
        selected: true
    },
    {
        id: 'commented-out-code',
        name: 'Commented-Out Code',
        kind: 'anti-pattern',
        summary: 'Code kept in comments: delete it, version control remembers.',
        problem: 'Commented-out code is a broken window. Readers wonder whether it matters, it rots as the code around it changes, and nobody dares to remove it, so it stays forever.',
        solution: 'Delete it. Version control keeps every old version; if the old code documents an alternative, explain it in prose.',
        use: 'Runs of line comments that read as code are reported.',
        avoid: 'Examples in documentation comments are not reported: only line comments are checked.',
        example: {
            file: 'example.ts',
            before: `function total(items: Item[]) {\n    // const tax = items.length * 0.2;\n    // return sum(items) + tax;\n    return sum(items);\n}\n`,
            after: `function total(items: Item[]) {\n    return sum(items);\n}\n`
        },
        checks: 'Finds runs of // and # comments that read as code (statements, assignments, calls, blocks), a heuristic on the code\'s text.',
        rules: ['commented-out-code'],
        autoFix: 'Deletes the commented-out lines.',
        sources: [pragmatic('Topic 3: Software Entropy (Don\'t Live with Broken Windows)'), { title: 'Clean Code (Robert C. Martin, 2008)', where: 'chapter 4: Comments' }],
        related: ['dead-programs-tell-no-lies'],
        selected: true
    },
    {
        id: 'flag-argument',
        name: 'Flag Argument',
        kind: 'anti-pattern',
        summary: 'A boolean parameter that picks what a function does: split the function, or name the choice.',
        problem: 'At the call site `render(page, true)` says nothing about what true means, and the function behind it does two things selected by the flag.',
        solution: 'Split it into one function per case, named for what each does (Remove Flag Argument), or replace the flag with an options object or an enum naming the choice.',
        use: 'Parameters typed boolean in functions that are not setters, toggles or predicates are reported.',
        avoid: 'A boolean that is data (setVisible(visible), enable(on)) rather than a choice of behaviour.',
        example: {
            file: 'example.ts',
            before: `function bookConcert(customer: Customer, premium: boolean) { ... }\nbookConcert(customer, true);\n`,
            after: `function bookPremiumConcert(customer: Customer) { ... }\nfunction bookRegularConcert(customer: Customer) { ... }\nbookPremiumConcert(customer);\n`
        },
        checks: 'Reads each function\'s parameter list and reports boolean parameters (all supported languages), except in setters, toggles, predicates and constructors.',
        rules: ['flag-argument'],
        sources: [{ title: 'FlagArgument (Martin Fowler, 2011)', where: 'bliki', url: 'https://martinfowler.com/bliki/FlagArgument.html' }, refactoring('Remove Flag Argument')],
        related: ['long-parameter-list'],
        selected: true
    },
    {
        id: 'magic-number',
        name: 'Magic Number',
        kind: 'anti-pattern',
        summary: 'A number in the logic with no name: give it a constant saying what it is.',
        problem: 'A literal such as 86400 or 0.2 in the middle of a function does not say what it stands for, and when it changes every copy has to be found.',
        solution: 'Replace it with a named constant (Replace Magic Literal), or a configuration value when it may differ between deployments.',
        use: 'Numbers other than 0, 1, 2, 10, 100, 1000 and common HTTP status codes, used in a function without being named where they appear, are reported.',
        avoid: 'Numbers whose meaning is plain from the expression (an index, a halving, a percentage) are often clearer as they are. Off by default: it is the noisiest of these checks.',
        example: {
            file: 'example.ts',
            before: `if (Date.now() - session.started > 1800000) logout();\n`,
            after: `const SESSION_TIMEOUT_MS = 30 * 60 * 1000;\nif (Date.now() - session.started > SESSION_TIMEOUT_MS) logout();\n`
        },
        checks: 'Finds numeric literals in function bodies that are not given a name where they appear (assigned to a variable, a key, a default value, a case label).',
        rules: ['magic-number'],
        sources: [refactoring('Replace Magic Literal')],
        related: [],
        selected: false
    }
];
