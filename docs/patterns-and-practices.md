# Patterns and practices

What `pflow extract` and the editor's Code base review check, entry by entry. Select entries with `checks` in provenflow.config.json (`"select"` replaces the default selection, `"skip"` removes entries), or in the editor under **Import code base → Patterns and practices**. Each entry follows the form of Martin Fowler's [Writing Software Patterns](https://martinfowler.com/articles/writingPatterns.html): the solution first, the problem, when to use it and when not to, and an example.

| Entry | Kind | Rules | Default |
| --- | --- | --- | --- |
| [Singleton](#singleton) | pattern | `singleton-bypassed` | on |
| [Observer](#observer) | pattern | `observer-cannot-unsubscribe`, `unremovable-listener` | on |
| [Factory](#factory) | pattern | `factory-products-unrelated` | on |
| [Strategy](#strategy) | pattern | `strategy-not-implemented` | on |
| [Builder](#builder) | pattern | `builder-builds-unconfigured` | on |
| [Adapter](#adapter) | pattern | `adapter-incomplete` | on |
| [Decorator](#decorator) | pattern | `decorator-incomplete` | on |
| [State](#state) | pattern | `unreachable-state` | on |
| [Command](#command) | pattern | `command-missing-undo` | on |
| [Facade](#facade) | pattern | `facade-bypassed` | on |
| [DRY: Don't Repeat Yourself](#dry-dont-repeat-yourself) | principle | `duplicated-code`, `similar-function` | on |
| [Orthogonality](#orthogonality) | principle | `layer-violation`, `layer-cycle` | on |
| [Law of Demeter](#law-of-demeter) | principle | `train-wreck` | on |
| [Tell, Don't Ask](#tell-dont-ask) | principle | `oop-mutates-foreign-object` | on |
| [No Global Data](#no-global-data) | principle | `fp-mutable-global`, `oop-mutable-global` | on |
| [Transforming Programming](#transforming-programming) | principle | `fp-mutates-argument`, `fp-writes-outer-state`, `fp-class` | on |
| [Inheritance Tax](#inheritance-tax) | principle | `deep-inheritance` | on |
| [Dead Programs Tell No Lies](#dead-programs-tell-no-lies) | principle | `empty-catch` | on |
| [Assertive Programming](#assertive-programming) | principle | `non-exhaustive-dispatch` | on |
| [Finish What You Start](#finish-what-you-start) | principle | `resource-leak`, `release-not-guaranteed` | on |
| [Shared State Is Incorrect State](#shared-state-is-incorrect-state) | principle | `stale-write-after-await` | on |
| [Naming Things](#naming-things) | principle | `naming-convention` | on |
| [Test to Code](#test-to-code) | principle | `untested-complex-function`, `uncovered-change`, `change-without-test`, `mutant-survived` | on |
| [God Class](#god-class) | anti-pattern | `god-class` | on |
| [Long Function](#long-function) | anti-pattern | `long-function` | on |
| [Long Parameter List](#long-parameter-list) | anti-pattern | `many-parameters` | on |
| [Complex Function](#complex-function) | anti-pattern | `cognitive-complexity` | on |
| [Arrow Code](#arrow-code) | anti-pattern | `deep-nesting` | on |
| [Cyclic Dependency](#cyclic-dependency) | anti-pattern | `import-cycle` | on |
| [Commented-Out Code](#commented-out-code) | anti-pattern | `commented-out-code` | on |
| [Flag Argument](#flag-argument) | anti-pattern | `flag-argument` | on |
| [Magic Number](#magic-number) | anti-pattern | `magic-number` | off |

## Design patterns

### Singleton

`singleton` · **One shared instance of a class, obtained through one access point.**

Some objects must exist once per program: a store of application state, a connection pool, a registry. If code creates them freely, two copies drift apart and each part of the program sees a different truth.

**How it works.** Hide the constructor (or let the dependency-injection container own the instance) and hand out the single instance from one place: a static accessor, a module-level instance, or a root-provided service.

**When to use it.** For state or resources that really are global to the program, and when the instance is reached through the injector rather than a hard-coded global.

**When not to.** Not as a convenient global variable: a singleton is still global state (see No Global Data). Prefer passing the object in when only a few callers need it; tests then get their own copy.

Before:

```ts
export class Settings {
    values = new Map<string, string>();
}

// in two places
const a = new Settings();
const b = new Settings(); // a second, diverging copy
```

After:

```ts
@Injectable({ providedIn: 'root' })
export class Settings {
    values = new Map<string, string>();
}

// everywhere
const settings = inject(Settings);
```

**What ProvenFlow checks.** Recognises singletons (private constructor with a static instance, `providedIn: 'root'`, language-level objects) and reports any code that creates another instance. A model checked with nuXmv proves the instance is never created twice. Rules: `singleton-bypassed`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Singleton, p. 127. Related: [No Global Data](#no-global-data).

### Observer

`observer` · **Subscribers register with a subject and are notified when it changes; each can unsubscribe.**

Several parts of a program react to the same change. If the subject calls each of them directly, it depends on all of them and every new reaction means editing it.

**How it works.** The subject keeps a collection of listeners, offers subscribe() returning a way to unsubscribe, and calls every listener in notify(). Listeners know the subject; the subject knows only the listener interface.

**When to use it.** When the set of reactions changes at run time, or belongs to other modules.

**When not to.** When there is one fixed reaction: a direct call is simpler to follow. Every subscription that is never removed is a memory leak and a source of calls on dead objects.

Before:

```ts
class Cart {
    private listeners: Array<() => void> = [];
    onChange(listener: () => void) {
        this.listeners.push(listener); // no way to stop listening
    }
}
```

After:

```ts
class Cart {
    private listeners = new Set<() => void>();
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
```

**What ProvenFlow checks.** Recognises subjects (a listener collection, subscribe and notify) and reports those whose listeners cannot be removed, and listeners added to DOM or event sources that are never removed. A model proves a subscriber can always detach. Rules: `observer-cannot-unsubscribe`, `unremovable-listener`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Observer, p. 293. Related: [Finish What You Start](#finish-what-you-start).

### Factory

`factory` · **One function or method creates the right product and returns it as their common interface.**

Code that needs one of several related objects ends up full of `new` calls and conditions choosing which class to build, repeated wherever such an object is needed.

**How it works.** Put the choice and the construction in one create function, returning the products' shared interface, so callers depend on the interface only.

**When to use it.** When the class to create depends on data or configuration, or construction is involved enough to deserve one home.

**When not to.** For a single concrete class with a plain constructor: the factory adds a name and nothing else.

Before:

```ts
const exporter = format === 'csv' ? new CsvExporter() : new JsonExporter();
// ... the same choice again in three other files
```

After:

```ts
export function createExporter(format: 'csv' | 'json'): Exporter {
    return format === 'csv' ? new CsvExporter() : new JsonExporter();
}
```

**What ProvenFlow checks.** Recognises factories (create functions returning several classes) and reports those whose products share no interface or base class. Rules: `factory-products-unrelated`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Factory Method, p. 107; Abstract Factory, p. 87. Related: [Strategy](#strategy).

### Strategy

`strategy` · **A family of interchangeable algorithms behind one interface, chosen at run time.**

A function switches on a kind to decide how to do something, and each new kind means another branch in it and in every other function that switches the same way.

**How it works.** Define the behaviour as an interface (or a function type), give each variant its own implementation, and let the caller hold whichever one applies.

**When to use it.** When variants are added over time, or chosen by configuration.

**When not to.** For two variants that will not grow: an if is easier to read than an interface and two classes.

Before:

```ts
function price(order: Order): number {
    if (order.customer === 'staff') return order.total * 0.8;
    if (order.customer === 'member') return order.total * 0.9;
    return order.total;
}
```

After:

```ts
interface Pricing { price(total: number): number }
const STAFF: Pricing = { price: total => total * STAFF_RATE };
const MEMBER: Pricing = { price: total => total * MEMBER_RATE };

function price(order: Order, pricing: Pricing): number {
    return pricing.price(order.total);
}
```

**What ProvenFlow checks.** Recognises strategy families (an interface with several implementations used through it) and reports implementations that leave methods unimplemented. Rules: `strategy-not-implemented`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Strategy, p. 315. Related: [Factory](#factory), [State](#state).

### Builder

`builder` · **An object assembled step by step through fluent methods, checked once in build().**

A constructor with many optional parameters is hard to call correctly, and an object filled in field by field can be used before it is complete.

**How it works.** A builder collects the parts through methods returning the builder, and build() validates that the required parts are there before creating the object.

**When to use it.** For objects with many optional parts, or parts that must be consistent with each other.

**When not to.** For objects with two or three required fields: a constructor (or an options object) says it in one line.

Before:

```ts
class RequestBuilder {
    private url?: string;
    to(url: string) { this.url = url; return this; }
    build() { return new Request(this.url!); } // builds without a URL
}
```

After:

```ts
class RequestBuilder {
    private url?: string;
    to(url: string) { this.url = url; return this; }
    build() {
        if (!this.url) throw new Error('A request needs a URL: call to() first.');
        return new Request(this.url);
    }
}
```

**What ProvenFlow checks.** Recognises builders (fluent methods returning this, a build method) and reports a build() that does not validate. A model proves the product is never built unconfigured. Rules: `builder-builds-unconfigured`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Builder, p. 97. Related: [Assertive Programming](#assertive-programming).

### Adapter

`adapter` · **A class that gives an existing object the interface its callers expect.**

A library or legacy component does the right thing behind the wrong interface, and the calls translating between the two are spread through the code.

**How it works.** Implement the expected interface in one class that holds the adaptee and translates each call to it.

**When to use it.** At the boundary with code you do not own or cannot change.

**When not to.** Between two of your own interfaces that could simply agree.

Before:

```ts
class LegacyLoggerAdapter implements Logger {
    constructor(private legacy: LegacyLogger) {}
    info(message: string) { this.legacy.write('INFO', message); }
    error(message: string): void { throw new Error('not implemented'); }
}
```

After:

```ts
class LegacyLoggerAdapter implements Logger {
    constructor(private legacy: LegacyLogger) {}
    info(message: string) { this.legacy.write('INFO', message); }
    error(message: string) { this.legacy.write('ERROR', message); }
}
```

**What ProvenFlow checks.** Recognises adapters (most methods forward to one wrapped object) and reports methods that only throw. Rules: `adapter-incomplete`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Adapter, p. 139. Related: [Decorator](#decorator), [Facade](#facade).

### Decorator

`decorator` · **A wrapper with the same interface as the object it wraps, adding behaviour around each call.**

Behaviour such as caching, logging or retries is wanted on some instances, and subclassing for every combination multiplies classes.

**How it works.** Implement the same interface as the wrapped object, forward each call to it, and add the extra behaviour before or after.

**When to use it.** For cross-cutting behaviour to combine freely at run time.

**When not to.** When a single fixed behaviour belongs in the class itself.

Before:

```ts
class CachedRepository implements Repository {
    constructor(private inner: Repository) {}
    find(id: string) { return this.inner.find(id); }
    save(item: Item): void { throw new Error('TODO'); }
}
```

After:

```ts
class CachedRepository implements Repository {
    private cache = new Map<string, Item>();
    constructor(private inner: Repository) {}
    find(id: string) { return this.cache.get(id) ?? this.inner.find(id); }
    save(item: Item) { this.cache.delete(item.id); this.inner.save(item); }
}
```

**What ProvenFlow checks.** Recognises decorators (same interface as the forwarded-to field) and reports methods that only throw. Rules: `decorator-incomplete`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Decorator, p. 175. Related: [Adapter](#adapter).

### State

`state` · **An object's behaviour delegated to one class per state, each returning the next state.**

Every method of an object starts with a switch on its current state, and the rules of which state follows which are scattered across them.

**How it works.** Give each state a class implementing a common interface; the object delegates to its current state, and each state decides the next one.

**When to use it.** When behaviour differs a lot between states and the states form a real lifecycle.

**When not to.** For two or three states with little behaviour each: an enum and a switch (checked for exhaustiveness) are clearer.

Before:

```ts
class Order {
    state: 'new' | 'paid' | 'shipped' | 'refunded' = 'new';
    pay() { if (this.state === 'new') this.state = 'paid'; }
    ship() { if (this.state === 'paid') this.state = 'shipped'; }
    // nothing ever sets 'refunded'
}
```

After:

```ts
interface OrderState { pay(): OrderState; ship(): OrderState }
class New implements OrderState { pay() { return new Paid(); } ship() { return this; } }
class Paid implements OrderState { pay() { return this; } ship() { return new Shipped(); } }
class Shipped implements OrderState { pay() { return this; } ship() { return this; } }
```

**What ProvenFlow checks.** Recognises State patterns (a family of state classes) and builds their transition model; nuXmv proves every state is reachable. Rules: `unreachable-state`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), State, p. 305. Related: [Strategy](#strategy), [Assertive Programming](#assertive-programming).

### Command

`command` · **Each action as an object with execute(), and undo() when it can be reversed.**

Actions must be queued, logged, retried or undone, but they are method calls that leave no trace once made.

**How it works.** Represent each action as an object implementing a common interface, holding what it needs to execute, and to undo when undo is supported.

**When to use it.** For undo and redo, macros, job queues, and auditable operations.

**When not to.** For actions that are only ever called directly once.

Before:

```ts
class RenameCommand implements Command {
    constructor(private file: File, private name: string) {}
    execute() { this.file.rename(this.name); }
}
```

After:

```ts
class RenameCommand implements Command {
    private previous = '';
    constructor(private file: File, private name: string) {}
    execute() { this.previous = this.file.name; this.file.rename(this.name); }
    undo() { this.file.rename(this.previous); }
}
```

**What ProvenFlow checks.** Recognises command families and reports commands missing the undo() their siblings have. Rules: `command-missing-undo`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Command, p. 233.

### Facade

`facade` · **One entry module through which a package is used, hiding its inner files.**

Callers import files deep inside a package, so every internal move or rename breaks them, and nothing says what the package offers.

**How it works.** Give the package an entry module (index) that exports its public interface, and import only from it.

**When to use it.** For every package or layer used by others.

**When not to.** Inside a package: its own files import each other directly.

Before:

```ts
import { parse } from '@acme/language/src/internal/parser';
```

After:

```ts
import { parse } from '@acme/language';
```

**What ProvenFlow checks.** Recognises packages with an entry module and reports imports that bypass it (with `packageEntries` or a facade declared in provenflow.config.json). Rules: `facade-bypassed`.

**Sources.** Design Patterns: Elements of Reusable Object-Oriented Software (Gamma, Helm, Johnson and Vlissides, 1994), Facade, p. 185. Related: [Orthogonality](#orthogonality).

## Principles

### DRY: Don't Repeat Yourself

`dry` · **Every piece of knowledge has a single, unambiguous, authoritative representation in the system.**

The same logic copied into several places has to be changed in all of them; the copy someone forgets is the next bug. AI coding agents copy readily, because writing new code is easier for them than finding the existing one.

**How it works.** Find the existing implementation and reuse it; when two copies exist, extract the shared logic into one function and call it from both.

**When to use it.** Whenever the same rule, algorithm or fact appears twice. DRY is about knowledge, not text: two lines that look alike but mean different things may stay apart.

**When not to.** Do not merge code that is only coincidentally similar, or tie together modules that should evolve independently just to share three lines.

Before:

```ts
function cartTotal(items: Item[]) {
    return items.reduce((sum, i) => sum + i.price * i.quantity * (1 + i.taxRate), 0);
}
function invoiceTotal(lines: Item[]) {
    return lines.reduce((sum, l) => sum + l.price * l.quantity * (1 + l.taxRate), 0);
}
```

After:

```ts
export function total(items: Item[]) {
    return items.reduce((sum, i) => sum + i.price * i.quantity * (1 + i.taxRate), 0);
}
const cartTotal = total;
const invoiceTotal = total;
```

**What ProvenFlow checks.** Finds copied blocks (exact and renamed, 100 tokens or more) and functions that are about 80% alike, and says which copy to reuse. The MCP tool find_existing_code lets an agent look before it writes. Rules: `duplicated-code`, `similar-function`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 9: DRY—The Evils of Duplication. Related: [Orthogonality](#orthogonality).

### Orthogonality

`orthogonality` · **Unrelated things stay independent: changing one never requires changing the other.**

When modules reach into each other freely, a change in one ripples through the others, and nothing can be tested, replaced or understood alone.

**How it works.** Group the code into layers with declared dependencies, keep each layer to what it may import, and make the dependencies point one way.

**When to use it.** Everywhere; layers declared in provenflow.config.json make the intended structure checkable.

**When not to.** Do not split code that changes together into separate layers just for symmetry.

Before:

```ts
// packages/core/src/prices.ts
import { showToast } from '../../ui/src/toast'; // core now depends on the UI
```

After:

```ts
// packages/core/src/prices.ts
export function price(...) { ... } // returns a value; the UI decides how to show it
```

**What ProvenFlow checks.** Checks every import against the layers declared in provenflow.config.json, and reports cycles between layers. Rules: `layer-violation`, `layer-cycle`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 10: Orthogonality. Related: [Law of Demeter](#law-of-demeter), [Cyclic Dependency](#cyclic-dependency), [Facade](#facade).

### Law of Demeter

`law-of-demeter` · **A method talks only to its friends: its object, its parameters, what it creates, and its direct parts.**

A chain such as `order.customer().address().country().code()` hard-codes the structure of four objects into the caller. Any change in that structure breaks code far away. The Pragmatic Programmer calls these chains train wrecks.

**How it works.** Ask the nearest object for what you need: give it a method that does the work (or returns exactly the value needed), or pass the value in.

**When to use it.** Whenever a method navigates through objects it does not own to reach the one it needs.

**When not to.** Fluent interfaces and pipelines that return the same kind of object (collections, strings, builders, queries) are not train wrecks: they do not reveal anyone's structure.

Before:

```ts
function shippingZone(order: Order) {
    return order.customer.address.country.zone();
}
```

After:

```ts
function shippingZone(order: Order) {
    return order.shippingZone(); // Order knows how to find it
}
```

**What ProvenFlow checks.** Finds member chains reaching through three or more objects, other than fluent calls and namespaces (a heuristic on the code's text). Rules: `train-wreck`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 28: Decoupling (Train Wrecks; Don't Chain Method Calls). Related: [Tell, Don't Ask](#tell-dont-ask), [Orthogonality](#orthogonality).

### Tell, Don't Ask

`tell-dont-ask` · **Tell an object what to do; do not ask for its state, decide for it and change it from outside.**

Logic that reads an object's fields and then writes them back lives outside the object that owns the data, so the object's rules are repeated, and bypassed, by every caller.

**How it works.** Move the decision into a method of the object that owns the data, and call that method.

**When to use it.** In object-oriented code, whenever a function changes an object it received.

**When not to.** Plain data records passed through a pipeline of functions are meant to be transformed (see Transforming Programming).

Before:

```ts
function applyDiscount(cart: Cart, rate: number) {
    if (cart.total > 100) cart.total = cart.total * (1 - rate);
}
```

After:

```ts
class Cart {
    applyDiscount(rate: number) {
        if (this.total > DISCOUNT_THRESHOLD) this.total *= 1 - rate;
    }
}
```

**What ProvenFlow checks.** In layers declared object-oriented, reports free functions that change the objects they receive. Rules: `oop-mutates-foreign-object`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 28: Decoupling (Tell, Don't Ask). Related: [Law of Demeter](#law-of-demeter).

### No Global Data

`no-global-data` · **Mutable state lives in an object or is passed in, never in a module-level variable.**

Every function can read and change a global, so it couples them all: their order matters, tests leak state into each other, and concurrent code races on it.

**How it works.** Put the state into the object (or service) that owns it, or pass it as a parameter; keep module-level values constant.

**When to use it.** Always for mutable state. Constants and lazily created, immutable caches are fine at module level.

**When not to.** A single, injected service (see Singleton) is the accepted way to share program-wide state.

Before:

```ts
let currentUser: User | undefined;
export function login(user: User) { currentUser = user; }
```

After:

```ts
export class Session {
    private user?: User;
    login(user: User) { this.user = user; }
}
```

**What ProvenFlow checks.** Reports module-level mutable variables in every layer, by declared style. Rules: `fp-mutable-global`, `oop-mutable-global`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 28: Decoupling (The Evils of Globalization); [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 34: Shared State Is Incorrect State. Related: [Singleton](#singleton), [Shared State Is Incorrect State](#shared-state-is-incorrect-state).

### Transforming Programming

`transforming-programming` · **Functions transform their inputs into new outputs, without changing what they were given.**

A function that changes its arguments or the variables around it has effects its signature does not show; callers cannot reason about it, and it cannot be reused safely.

**How it works.** Return new values instead of changing inputs; keep state in data passed from one transformation to the next.

**When to use it.** In layers declared functional (provenflow.config.json "style": "functional").

**When not to.** Local mutation inside a function, invisible to its callers, is fine and often clearer.

Before:

```ts
export function addTax(items: Item[]) {
    for (const i of items) i.price *= 1 + TAX_RATE; // changes the caller's items
}
```

After:

```ts
export function withTax(items: Item[]): Item[] {
    return items.map(i => ({ ...i, price: i.price * (1 + TAX_RATE) }));
}
```

**What ProvenFlow checks.** In layers declared functional, reports exported functions that change their arguments or outer variables, and classes with mutable state. Rules: `fp-mutates-argument`, `fp-writes-outer-state`, `fp-class`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 30: Transforming Programming. Related: [No Global Data](#no-global-data), [Tell, Don't Ask](#tell-dont-ask).

### Inheritance Tax

`inheritance-tax` · **Prefer interfaces, delegation and composition to deep class hierarchies.**

Each level of inheritance couples a class to every ancestor's implementation; a change at the top ripples down, and understanding a method means reading the whole chain.

**How it works.** Share behaviour through interfaces (or protocols) and delegate to helper objects; keep hierarchies shallow.

**When to use it.** Whenever a hierarchy grows beyond the limit (three levels by default).

**When not to.** Framework base classes you must extend count as one level; that is not a design choice.

Before:

```ts
class Animal {}
class Mammal extends Animal {}
class Dog extends Mammal {}
class GuideDog extends Dog {}
```

After:

```ts
interface Guide { guide(person: Person): void }
class GuideDog implements Guide {
    constructor(private dog: Dog) {}
    guide(person: Person) { ... }
}
```

**What ProvenFlow checks.** Reports classes whose inheritance chain is deeper than limits.inheritanceDepth. Rules: `deep-inheritance`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 31: Inheritance Tax. Related: [Decorator](#decorator).

### Dead Programs Tell No Lies

`dead-programs-tell-no-lies` · **Crash early: a program that stops where the problem is does less damage than one that carries on.**

An empty catch (or `except: pass`) drops an error on the floor. The program continues in a state nobody checked, and the failure shows up later, far from its cause, or as silently wrong data.

**How it works.** Handle the error where something can be done about it (recover, retry, return an error value), or let it propagate. When ignoring it really is right, say why in the block.

**When to use it.** For every error handler.

**When not to.** Cleanup that may fail harmlessly (removing a temporary file that may not exist) can ignore its error, with a comment saying so.

Before:

```ts
try {
    config = JSON.parse(text);
} catch {}
```

After:

```ts
try {
    config = JSON.parse(text);
} catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
}
```

**What ProvenFlow checks.** Finds empty handlers in every supported language: catch {}, except: pass, rescue with no body, if err != nil {}. Handlers holding a comment are taken as deliberate. Rules: `empty-catch`. Automatic fix: Rethrows the caught error (raise in Python), for review: if the error is expected, handle it instead.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 24: Dead Programs Tell No Lies. Related: [Assertive Programming](#assertive-programming).

### Assertive Programming

`assertive-programming` · **If it can't happen, make sure it won't: handle every case, and fail loudly on the impossible one.**

A switch over a set of kinds that misses one silently does nothing for it, and adding a kind later leaves every such switch quietly incomplete.

**How it works.** Handle every case; end the switch with a default that throws, and in TypeScript assign the subject to `never` so the compiler flags new kinds.

**When to use it.** For every dispatch over a closed set of values: enums, union types, state names.

**When not to.** Assertions are not error handling for expected conditions such as bad user input.

Before:

```ts
switch (shape.kind) {
    case 'circle': return circleArea(shape);
    case 'square': return squareArea(shape);
} // 'triangle' falls through, returns undefined
```

After:

```ts
switch (shape.kind) {
    case 'circle': return circleArea(shape);
    case 'square': return squareArea(shape);
    case 'triangle': return triangleArea(shape);
    default: { const unreachable: never = shape; throw new Error(`Unknown shape ${unreachable}`); }
}
```

**What ProvenFlow checks.** Reports switches and if-chains over an enum or union type that miss values and have no default, with a verified fix adding the missing cases. Rules: `non-exhaustive-dispatch`. Automatic fix: Adds the missing cases (verified by re-running the checks and the build).

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 25: Assertive Programming; [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 23: Design by Contract. Related: [Dead Programs Tell No Lies](#dead-programs-tell-no-lies), [State](#state).

### Finish What You Start

`finish-what-you-start` · **The code that acquires a resource releases it, on every path, including errors.**

A file, connection, timer or subscription opened in one place and closed somewhere else, or only on the happy path, leaks when an error or early return skips the release.

**How it works.** Release in the same scope that acquired: try/finally, using/with/defer, or a scope that owns the resource and disposes of it.

**When to use it.** For every resource: files, sockets, locks, timers, listeners, subscriptions.

**When not to.** Resources owned by a framework lifecycle (released in its destroy hook) belong to that object; the check follows them there.

Before:

```ts
const handle = await open(path);
const text = await handle.readFile('utf8'); // throws: the handle stays open
await handle.close();
```

After:

```ts
const handle = await open(path);
try {
    return await handle.readFile('utf8');
} finally {
    await handle.close();
}
```

**What ProvenFlow checks.** Models each resource's lifecycle and proves with nuXmv that it is released on every path; reports leaks and releases that an error can skip. Rules: `resource-leak`, `release-not-guaranteed`. Automatic fix: Adds the release in a finally block (verified).

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 26: How to Balance Resources. Related: [Observer](#observer).

### Shared State Is Incorrect State

`shared-state` · **State read before an await may be stale after it: check again, or do not share it.**

Code reads a shared value, awaits something, then writes based on what it read. Meanwhile another task changed the value, and the write undoes that change: a race with no threads in sight.

**How it works.** Re-read (and re-check) the state after the await, make the update atomic, or give the state a single owner that serialises changes.

**When to use it.** In asynchronous code that updates state other tasks can see.

**When not to.** State local to the function, which nothing else can change during the await.

Before:

```ts
if (this.state === 'idle') {
    await this.load();
    this.state = 'ready'; // another call may have closed it meanwhile
}
```

After:

```ts
if (this.state === 'idle') {
    await this.load();
    if (this.state === 'idle') this.state = 'ready';
}
```

**What ProvenFlow checks.** Reports writes to state variables after an await that were decided before it, with a verified fix re-checking the state. Rules: `stale-write-after-await`. Automatic fix: Re-checks the state after the await (verified).

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 34: Shared State Is Incorrect State; [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 33: Breaking Temporal Coupling. Related: [No Global Data](#no-global-data).

### Naming Things

`naming-things` · **Names follow one convention per kind, the project's own first, so a name says what a thing is.**

Mixed conventions (getUser, get_order, FetchItem) make readers stop and wonder whether the difference means something, and make code harder to search.

**How it works.** Follow the project's convention for each kind of name (class, function, method, field, constant), falling back on the language's style guide.

**When to use it.** For every new name, and when renaming.

**When not to.** Names imposed from outside (framework hooks, generated code, external APIs) keep their own spelling: list them under "ignore" with the reason.

Before:

```python
def GetUser(id):
    ...

def get_order(id):
    ...
```

After:

```python
def get_user(id):
    ...

def get_order(id):
    ...
```

**What ProvenFlow checks.** Infers the convention for each kind of name from the code (80% of at least 8 names), else applies the language's style guide, and reports names that do not fit, with the rename. Rules: `naming-convention`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 44: Naming Things.

### Test to Code

`test-to-code` · **Test early, test often, test automatically; and test the tests by breaking the code on purpose.**

Complex functions without tests, and changes merged without one, are where regressions hide. Coverage alone can be satisfied by tests that assert nothing.

**How it works.** Add a test with each change, cover the complex functions first, and run mutation testing (a saboteur) to check that the tests notice when the code is broken.

**When to use it.** For every change; in CI with coverage reports, and mutation testing on the changed lines.

**When not to.** Do not chase 100% coverage of trivial code; spend the tests where the complexity is.

Before:

```ts
// src/discount.ts changed: a new rule for members
// no test file changed
```

After:

```ts
// test/discount.test.ts
it('gives members 10% off', () => {
    expect(price({ total: 50, customer: 'member' })).toBe(45);
});
```

**What ProvenFlow checks.** Reports complex functions with no coverage, changed lines no test covers, source changes without a test change, and mutants the tests do not kill (with coverage reports and pflow mutate). Rules: `untested-complex-function`, `uncovered-change`, `change-without-test`, `mutant-survived`.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 41: Test to Code; [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 51: Pragmatic Starter Kit (Use Saboteurs to Test Your Testing). Related: [Complex Function](#complex-function).

## Anti-patterns

### God Class

`god-class` · **One class that knows and does too much: split it by responsibility.**

A class with dozens of methods and hundreds of lines becomes the place every change goes. Everything depends on it, it is hard to test, and two people cannot work on it at once.

**How it works.** Find the groups of fields and methods used together and extract each into its own class (Extract Class); keep the original as a thin coordinator, or remove it.

**When it is reported.** Classes over the size limits (30 methods or 600 lines by default) are reported.

**When it is acceptable.** Generated classes and facades that only forward calls are large without being responsible for much.

Before:

```ts
class OrderManager {
    // pricing, tax, stock, shipping, invoices, e-mails... 45 methods
}
```

After:

```ts
class Pricing { ... }
class Stock { ... }
class Shipping { ... }
class Invoicing { ... }
```

**What ProvenFlow checks.** Reports classes over limits.classMethods or limits.classLines. Rules: `god-class`.

**Sources.** AntiPatterns (Brown, Malveau, McCormick and Mowbray, 1998), The Blob; [Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code](https://refactoring.com/catalog/), Large Class; Extract Class. Related: [Long Function](#long-function), [Orthogonality](#orthogonality).

### Long Function

`long-function` · **A function too long to see at once: extract the parts into well-named functions.**

A long function mixes several steps and levels of detail; readers have to hold all of it in mind, and its parts cannot be reused or tested alone.

**How it works.** Extract each step into a function whose name says what it does (Extract Function); the original reads as a list of steps.

**When it is reported.** Functions over the language's limit (50 lines for TypeScript and Python by default) are reported.

**When it is acceptable.** A long but flat table or switch of data may read better whole.

Before:

```ts
function report(data: Row[]) {
    // 30 lines validating
    // 40 lines aggregating
    // 30 lines formatting
}
```

After:

```ts
function report(data: Row[]) {
    const rows = validate(data);
    const totals = aggregate(rows);
    return format(totals);
}
```

**What ProvenFlow checks.** Reports functions over limits.functionLines (per language). Rules: `long-function`.

**Sources.** [Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code](https://refactoring.com/catalog/), Long Function; Extract Function. Related: [Complex Function](#complex-function), [God Class](#god-class).

### Long Parameter List

`long-parameter-list` · **Too many parameters: group the ones that travel together into an object.**

Calls with many positional arguments are easy to get wrong (two numbers swapped compile fine), and every new option changes every caller.

**How it works.** Introduce a parameter object for values that go together, or pass the object the values come from (Introduce Parameter Object, Preserve Whole Object).

**When it is reported.** Functions over the language's limit (7 for TypeScript, 5 for Python by default) are reported.

**When it is acceptable.** Constructors used by a dependency injector take their dependencies as parameters by design.

Before:

```ts
function book(name: string, from: Date, to: Date, rooms: number, adults: number, children: number, breakfast: boolean) { ... }
```

After:

```ts
interface Booking { name: string; stay: { from: Date; to: Date }; rooms: number; guests: { adults: number; children: number }; breakfast: boolean }
function book(booking: Booking) { ... }
```

**What ProvenFlow checks.** Reports functions over limits.functionParams (per language). Rules: `many-parameters`.

**Sources.** [Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code](https://refactoring.com/catalog/), Long Parameter List; Introduce Parameter Object. Related: [Flag Argument](#flag-argument).

### Complex Function

`complex-function` · **Logic too tangled to follow: simplify the conditions and split the function.**

Every branch, loop and boolean operator adds to what a reader must track, and nesting multiplies it. Past a point nobody can tell what the function does in every case, or test them all.

**How it works.** Replace nested conditions with guard clauses, extract conditions and loop bodies into named functions, and replace a conditional on type with polymorphism.

**When it is reported.** Functions over the Cognitive Complexity limit (15 by default) are reported.

**When it is acceptable.** A flat switch over many cases scores low by design: it is easy to read.

Before:

```ts
function shipping(order: Order) {
    if (order.items.length) {
        if (order.country === 'US') {
            if (order.total > 100) return 0; else return 5;
        } else { ... }
    }
}
```

After:

```ts
function shipping(order: Order) {
    if (!order.items.length) return 0;
    if (order.country !== 'US') return international(order);
    return order.total > FREE_SHIPPING ? 0 : US_SHIPPING;
}
```

**What ProvenFlow checks.** Measures Cognitive Complexity (SonarSource) for each function in every supported language and reports those over the limit. Rules: `cognitive-complexity`.

**Sources.** [Cognitive Complexity (G. Ann Campbell, SonarSource, 2018)](https://www.sonarsource.com/docs/CognitiveComplexity.pdf), white paper; [Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code](https://refactoring.com/catalog/), Decompose Conditional; Replace Nested Conditional with Guard Clauses. Related: [Arrow Code](#arrow-code), [Long Function](#long-function).

### Arrow Code

`arrow-code` · **Code nested so deep it points right like an arrowhead: flatten it with guard clauses.**

Each level of nesting is another condition the reader must keep in mind to understand a line; deep nesting hides which branch handles what.

**How it works.** Return early for the exceptional cases (guard clauses), invert conditions, and extract inner blocks into functions.

**When it is reported.** Functions nested deeper than the language's limit (4 for TypeScript, 5 for Python by default) are reported.

**When it is acceptable.** Nested data literals are not control flow and are not counted.

Before:

```python
def process(request):
    if request:
        if request.user:
            if request.user.active:
                for item in request.items:
                    if item.valid:
                        handle(item)
```

After:

```python
def process(request):
    if not request or not request.user or not request.user.active:
        return
    for item in request.items:
        if item.valid:
            handle(item)
```

**What ProvenFlow checks.** Measures the deepest nesting of control flow in each function and reports those over the limit. Rules: `deep-nesting`.

**Sources.** [Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code](https://refactoring.com/catalog/), Replace Nested Conditional with Guard Clauses. Related: [Complex Function](#complex-function).

### Cyclic Dependency

`cyclic-dependency` · **Modules that import each other in a cycle: break it by moving the shared part or inverting a dependency.**

Modules in an import cycle cannot be understood, tested or built separately; load order starts to matter, and a change anywhere in the cycle can break all of it.

**How it works.** Move what both sides need into a third module they both import, or invert one dependency through an interface owned by the lower module.

**When it is reported.** Every cycle between files is reported.

**When it is acceptable.** Type-only imports in TypeScript do not create a cycle at run time, but they still tie the modules together.

Before:

```ts
// a.ts
import { b } from './b';
// b.ts
import { a } from './a';
```

After:

```ts
// shared.ts: what both need
// a.ts
import { shared } from './shared';
// b.ts
import { shared } from './shared';
```

**What ProvenFlow checks.** Reports import cycles between files. Rules: `import-cycle`.

**Sources.** Granularity (Robert C. Martin, C++ Report, 1996), The Acyclic Dependencies Principle. Related: [Orthogonality](#orthogonality).

### Commented-Out Code

`commented-out-code` · **Code kept in comments: delete it, version control remembers.**

Commented-out code is a broken window. Readers wonder whether it matters, it rots as the code around it changes, and nobody dares to remove it, so it stays forever.

**How it works.** Delete it. Version control keeps every old version; if the old code documents an alternative, explain it in prose.

**When it is reported.** Runs of line comments that read as code are reported.

**When it is acceptable.** Examples in documentation comments are not reported: only line comments are checked.

Before:

```ts
function total(items: Item[]) {
    // const tax = items.length * 0.2;
    // return sum(items) + tax;
    return sum(items);
}
```

After:

```ts
function total(items: Item[]) {
    return sum(items);
}
```

**What ProvenFlow checks.** Finds runs of // and # comments that read as code (statements, assignments, calls, blocks), a heuristic on the code's text. Rules: `commented-out-code`. Automatic fix: Deletes the commented-out lines.

**Sources.** [The Pragmatic Programmer, 20th Anniversary Edition (David Thomas and Andrew Hunt, 2019)](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/), Topic 3: Software Entropy (Don't Live with Broken Windows); Clean Code (Robert C. Martin, 2008), chapter 4: Comments. Related: [Dead Programs Tell No Lies](#dead-programs-tell-no-lies).

### Flag Argument

`flag-argument` · **A boolean parameter that picks what a function does: split the function, or name the choice.**

At the call site `render(page, true)` says nothing about what true means, and the function behind it does two things selected by the flag.

**How it works.** Split it into one function per case, named for what each does (Remove Flag Argument), or replace the flag with an options object or an enum naming the choice.

**When it is reported.** Parameters typed boolean in functions that are not setters, toggles or predicates are reported.

**When it is acceptable.** A boolean that is data (setVisible(visible), enable(on)) rather than a choice of behaviour.

Before:

```ts
function bookConcert(customer: Customer, premium: boolean) { ... }
bookConcert(customer, true);
```

After:

```ts
function bookPremiumConcert(customer: Customer) { ... }
function bookRegularConcert(customer: Customer) { ... }
bookPremiumConcert(customer);
```

**What ProvenFlow checks.** Reads each function's parameter list and reports boolean parameters (all supported languages), except in setters, toggles, predicates and constructors. Rules: `flag-argument`.

**Sources.** [FlagArgument (Martin Fowler, 2011)](https://martinfowler.com/bliki/FlagArgument.html), bliki; [Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code](https://refactoring.com/catalog/), Remove Flag Argument. Related: [Long Parameter List](#long-parameter-list).

### Magic Number

`magic-number` · **A number in the logic with no name: give it a constant saying what it is.**

A literal such as 86400 or 0.2 in the middle of a function does not say what it stands for, and when it changes every copy has to be found.

**How it works.** Replace it with a named constant (Replace Magic Literal), or a configuration value when it may differ between deployments.

**When it is reported.** Numbers other than 0, 1, 2, 10, 100, 1000 and common HTTP status codes, used in a function without being named where they appear, are reported.

**When it is acceptable.** Numbers whose meaning is plain from the expression (an index, a halving, a percentage) are often clearer as they are. Off by default: it is the noisiest of these checks.

Before:

```ts
if (Date.now() - session.started > 1800000) logout();
```

After:

```ts
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
if (Date.now() - session.started > SESSION_TIMEOUT_MS) logout();
```

**What ProvenFlow checks.** Finds numeric literals in function bodies that are not given a name where they appear (assigned to a variable, a key, a default value, a case label). Rules: `magic-number`.

**Sources.** [Refactoring, 2nd edition (Martin Fowler, 2018), chapter 3: Bad Smells in Code](https://refactoring.com/catalog/), Replace Magic Literal.
