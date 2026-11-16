/**
 * TypeScript/JavaScript front end: builds one program over the project files
 * and uses the type checker to find state variables (anything typed as a
 * finite union of string literals or enum members), their writes with the
 * states they can happen in, resource acquisitions and releases, and the
 * class, function and module facts used by the pattern, paradigm and
 * architecture analyses.
 */
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { emptyFacts, type Facts, type StateWriteFact } from './ir.js';
import { isTestFile } from './scan.js';
import { SourceContext } from './typescript-context.js';
import { ResourceFacts } from './typescript-resources.js';
import { ShapeFacts } from './typescript-shapes.js';
import { synthesizeTemplates, type TemplateHandler } from './typescript-templates.js';
import { COMPILER_OPTIONS, enclosingFunction, eventName, isFunctionLike, memberName, rel, skipParens } from './typescript-util.js';

const MAX_DOMAIN = 40;

type Values = Set<string> | null; // null: any value

interface StateSymbol {
    id: string;
    name: string;
    owner: string;
    domain: string[];
    decl: ts.Declaration;
}

/** `overrides`: file (relative to root) -> text to use instead of the file on disk. */
export function extractTypeScript(root: string, files: string[], overrides?: Map<string, string>): Facts {
    const facts = emptyFacts(root);
    const absolute = files.map(f => resolve(root, f));
    const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
    const templates = synthesizeTemplates(root, files, overrides);
    const replaced = new Map([...(overrides ?? [])].map(([f, text]) => [resolve(root, f), text]));
    for (const [file, text] of templates.texts) replaced.set(file, text);
    if (replaced.size) {
        const getSourceFile = host.getSourceFile.bind(host);
        host.getSourceFile = (fileName, language, onError, create) => {
            const text = replaced.get(resolve(fileName));
            return text !== undefined ? ts.createSourceFile(fileName, text, language, true) : getSourceFile(fileName, language, onError, create);
        };
        // Files that exist only as overrides (restored from another revision) resolve as imports too.
        const fileExists = host.fileExists.bind(host);
        const readFile = host.readFile.bind(host);
        host.fileExists = fileName => replaced.has(resolve(fileName)) || fileExists(fileName);
        host.readFile = fileName => replaced.get(resolve(fileName)) ?? readFile(fileName);
    }
    const program = ts.createProgram(absolute, COMPILER_OPTIONS, host);
    const checker = program.getTypeChecker();
    const wanted = new Set(absolute);
    const sources = program.getSourceFiles().filter(sf => wanted.has(resolve(sf.fileName)));
    for (const sf of sources) {
        for (const d of program.getSyntacticDiagnostics(sf).slice(0, 3)) {
            facts.notes.push(`${rel(root, sf)}: syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
        }
    }
    const extractor = new Extractor(root, checker, facts, templates.handlers);
    for (const sf of sources) extractor.findStateSymbols(sf);
    for (const sf of sources) extractor.visitFile(sf);
    extractor.resolveParameters(sources);
    extractor.finish();
    facts.files.push(...sources.map(sf => rel(root, sf)));
    return facts;
}

class Extractor {
    private readonly states = new Map<ts.Symbol, StateSymbol>();
    private readonly initials = new Map<ts.Symbol, Set<string>>();
    private readonly ctx: SourceContext;
    private readonly shapes: ShapeFacts;
    private readonly resources: ResourceFacts;

    private readonly pendingParams: Array<{ write: StateWriteFact; fn: ts.FunctionLikeDeclaration; index: number; param: ts.ParameterDeclaration }> = [];

    constructor(
        private readonly root: string,
        private readonly checker: ts.TypeChecker,
        private readonly facts: Facts,
        handlers: Map<string, TemplateHandler>
    ) {
        this.ctx = new SourceContext(root, checker, facts, handlers);
        this.shapes = new ShapeFacts(this.ctx);
        this.resources = new ResourceFacts(this.ctx);
    }


    // ------------------------------------------------------------------ pass 1

    /** Registers every symbol written with a value of a finite literal type, outside its declaration. */
    findStateSymbols(sf: ts.SourceFile): void {
        const visit = (node: ts.Node): void => {
            const target = this.writeTarget(node);
            if (target && !this.states.has(target.symbol)) this.register(target.symbol);
            if (ts.isObjectLiteralExpression(node) && node.properties.some(ts.isSpreadAssignment)) {
                for (const property of this.stateProperties(node)) {
                    if (!this.states.has(property.symbol)) this.register(property.symbol);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }

    private register(symbol: ts.Symbol): void {
        const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (!decl) return;
        if (!isStateDeclaration(decl)) return;
        const domain = this.domainOf(symbol, decl);
        if (!domain) return;
        const owner = ownerName(decl);
        const file = sourcePath(relative(this.root, decl.getSourceFile().fileName).split('\\').join('/'));
        if (isTestFile(file)) return;
        const name = `${owner}.${symbol.getName()}`;
        this.states.set(symbol, { id: `${file}#${name}`, name, owner, domain, decl });
    }

    /** The finite domain of a state variable, looking through Signal/Subject wrappers. */
    private domainOf(symbol: ts.Symbol, decl: ts.Declaration): string[] | null {
        let type = this.checker.getTypeOfSymbolAtLocation(symbol, decl);
        const wrapped = wrapperElement(this.checker, type);
        if (wrapped) type = wrapped;
        return literalDomain(type);
    }

    /** `x = v`, `this.x = v`, `x.set(v)`, `x.next(v)`, `x.update(f)`: the symbol written. */
    private writeTarget(node: ts.Node): { symbol: ts.Symbol; value?: ts.Expression; wrapper: boolean } | undefined {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const lhs = node.left;
            if (!ts.isIdentifier(lhs) && !ts.isPropertyAccessExpression(lhs)) return undefined;
            const symbol = this.symbolOf(lhs);
            if (!symbol) return undefined;
            const decl = symbol.valueDeclaration;
            if (decl && wrapperElement(this.checker, this.checker.getTypeOfSymbolAtLocation(symbol, decl))) return undefined;
            return { symbol, value: node.right, wrapper: false };
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            if (!['set', 'next', 'update'].includes(method)) return undefined;
            const receiver = node.expression.expression;
            if (!ts.isIdentifier(receiver) && !ts.isPropertyAccessExpression(receiver)) return undefined;
            const symbol = this.symbolOf(receiver);
            const decl = symbol?.valueDeclaration;
            if (!symbol || !decl) return undefined;
            if (!wrapperElement(this.checker, this.checker.getTypeOfSymbolAtLocation(symbol, decl))) return undefined;
            if (method === 'update') return { symbol, wrapper: true };
            if (node.arguments.length !== 1) return undefined;
            return { symbol, value: node.arguments[0], wrapper: true };
        }
        return undefined;
    }

    /** Properties of an object literal that are state variables of its contextual type. */
    private stateProperties(node: ts.ObjectLiteralExpression): Array<{ symbol: ts.Symbol; value: ts.Expression; node: ts.Node }> {
        const contextual = this.checker.getContextualType(node);
        if (!contextual) return [];
        const result: Array<{ symbol: ts.Symbol; value: ts.Expression; node: ts.Node }> = [];
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
            const types = contextual.isUnion() ? contextual.types : [contextual];
            for (const t of types) {
                const symbol = t.getProperty(property.name.text);
                if (symbol && (symbol.valueDeclaration ?? symbol.declarations?.[0]) && isStateDeclaration(symbol.valueDeclaration ?? symbol.declarations![0])) {
                    result.push({ symbol, value: property.initializer, node: property });
                    break;
                }
            }
        }
        return result;
    }

    private symbolOf(node: ts.Node): ts.Symbol | undefined {
        let symbol = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
        if (!symbol) return undefined;
        // Properties of instantiated generics point to the declared property.
        const target = (symbol as ts.Symbol & { links?: { target?: ts.Symbol } }).links?.target;
        return target ?? symbol;
    }

    // ------------------------------------------------------------------ pass 2

    visitFile(sf: ts.SourceFile): void {
        this.ctx.enter(sf);
        this.facts.modules.push(this.shapes.moduleFact(sf));
        if (/\bcreateMachine\s*\(/.test(sf.text) && /from\s+['"]xstate['"]/.test(sf.text) && !this.ctx.test) this.facts.declaredMachines.push(...this.shapes.declaredMachines(sf));
        const visit = (node: ts.Node): void => {
            this.visitNode(node);
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }



    private visitNode(node: ts.Node): void {
        this.stateFacts(node);
        this.resources.visit(node);
        if (ts.isClassDeclaration(node) && node.name) this.facts.classes.push(this.shapes.classFact(node));
        if (ts.isInterfaceDeclaration(node)) this.facts.interfaces.push(this.shapes.interfaceFact(node));
        if (ts.isTypeAliasDeclaration(node) && ts.isFunctionTypeNode(node.type)) {
            this.facts.interfaces.push({ name: node.name.text, loc: this.ctx.loc(node), language: 'typescript', methods: [], callable: true });
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            const cls = ts.findAncestor(node, ts.isClassDeclaration);
            const member = enclosingFunction(node);
            this.facts.instantiations.push({
                className: node.expression.text,
                language: 'typescript',
                loc: this.ctx.loc(node),
                inClass: cls?.name?.text,
                inMember: member ? memberName(member) : undefined,
                inTest: this.ctx.test
            });
        }
        if (isFunctionLike(node) && node.body) {
            const fact = this.shapes.functionFact(node);
            if (fact) this.facts.functions.push(fact);
        }
        if (ts.isSwitchStatement(node)) this.switchFact(node);
    }

    // ---------------------------------------------------------------- states

    private stateFacts(node: ts.Node): void {
        // Initial values: declarations with initialisers, signal('x'), constructor writes, object creations.
        if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.initializer) {
            const symbol = this.checker.getSymbolAtLocation(node.name);
            if (symbol && this.states.has(symbol)) {
                let init: ts.Expression = node.initializer;
                if (ts.isCallExpression(init) && init.arguments.length > 0) init = init.arguments[0];
                this.addInitial(symbol, this.literalValues(init));
            }
        }
        if (ts.isObjectLiteralExpression(node)) {
            const spread = node.properties.some(ts.isSpreadAssignment);
            for (const property of this.stateProperties(node)) {
                const state = this.states.get(property.symbol);
                if (!state) continue;
                if (spread) this.recordWrite(property.node, state, property.value);
                else this.addInitial(property.symbol, this.literalValues(property.value));
            }
        }
        const target = this.writeTarget(node);
        if (target) {
            const state = this.states.get(target.symbol);
            if (!state) return;
            const fn = enclosingFunction(node);
            if (fn && ts.isConstructorDeclaration(fn)) {
                this.addInitial(target.symbol, target.value ? this.literalValues(target.value) : null);
                return;
            }
            this.recordWrite(node, state, target.value);
        }
        this.readFact(node);
    }

    private addInitial(symbol: ts.Symbol, values: string[] | null): void {
        if (!values) return;
        const set = this.initials.get(symbol) ?? new Set<string>();
        values.forEach(v => set.add(v));
        this.initials.set(symbol, set);
    }

    private recordWrite(node: ts.Node, state: StateSymbol, value: ts.Expression | undefined): void {
        const fn = enclosingFunction(node);
        const flow = this.sourcesOf(node, state);
        const handler = this.ctx.handlerOf(node);
        const write: StateWriteFact = {
            variable: state.id,
            targets: value ? this.literalValues(value) : null,
            sources: flow.values ? [...flow.values] : null,
            event: handler ? handler.event : fn ? eventName(fn) : 'module',
            loc: this.ctx.loc(node),
            afterAwait: flow.afterAwait,
            text: this.ctx.lineText(node)
        };
        this.facts.writes.push(write);
        // A parameter written as is: its values come from the callers.
        const e = value && skipParens(value);
        if (e && !write.targets && ts.isIdentifier(e) && fn) {
            const decl = this.checker.getSymbolAtLocation(e)?.valueDeclaration;
            if (decl && ts.isParameter(decl) && decl.parent === fn) this.pendingParams.push({ write, fn, index: fn.parameters.indexOf(decl), param: decl });
        }
    }

    /** Values of an expression when they are statically known literals. */
    private literalValues(expression: ts.Expression): string[] | null {
        const e = skipParens(expression);
        const literalish =
            ts.isStringLiteral(e) ||
            ts.isNoSubstitutionTemplateLiteral(e) ||
            ts.isConditionalExpression(e) ||
            ts.isPropertyAccessExpression(e) ||
            ts.isAsExpression(e) ||
            ts.isIdentifier(e);
        if (!literalish) return null;
        const type = this.checker.getTypeAtLocation(e);
        const values = literalValuesOf(type);
        if (!values || values.length === 0) return null;
        // A variable of the whole union type is not a known value.
        if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && values.length > 1) return null;
        return values;
    }

    private readFact(node: ts.Node): void {
        const leaf = this.comparison(node);
        if (leaf) {
            this.facts.reads.push({ variable: leaf.state.id, values: [...leaf.values], loc: this.ctx.loc(node) });
        }
    }

    /** `x === 'a'`, `x() !== 'a'`, `['a','b'].includes(x)`: the state tested and the values it is tested against. */
    private comparison(node: ts.Node): { state: StateSymbol; values: Set<string>; negated: boolean } | undefined {
        if (ts.isBinaryExpression(node)) {
            const op = node.operatorToken.kind;
            const equal = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
            const notEqual = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
            if (!equal && !notEqual) return undefined;
            for (const [a, b] of [[node.left, node.right], [node.right, node.left]] as const) {
                const state = this.stateRead(a);
                if (!state) continue;
                const values = this.literalValues(b);
                if (!values) continue;
                return { state, values: new Set(values), negated: notEqual };
            }
            return undefined;
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['includes', 'has'].includes(node.expression.name.text) && node.arguments.length === 1) {
            const state = this.stateRead(node.arguments[0]);
            if (!state) return undefined;
            let receiver = skipParens(node.expression.expression);
            if (ts.isNewExpression(receiver) && receiver.arguments?.length === 1) receiver = receiver.arguments[0];
            if (!ts.isArrayLiteralExpression(receiver)) return undefined;
            const values = new Set<string>();
            for (const element of receiver.elements) {
                const v = this.literalValues(element);
                if (!v) return undefined;
                v.forEach(x => values.add(x));
            }
            return { state, values, negated: false };
        }
        return undefined;
    }

    /** The state variable read by `x`, `this.x`, `obj.x` or the signal call `this.x()`. */
    private stateRead(expression: ts.Expression): StateSymbol | undefined {
        let e = skipParens(expression);
        if (ts.isCallExpression(e) && e.arguments.length === 0) e = e.expression;
        if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined;
        const symbol = this.symbolOf(e);
        return symbol ? this.states.get(symbol) : undefined;
    }

    /** Positive (condition true) and negative (condition false) constraints on a state variable. */
    private constraint(expression: ts.Expression, state: StateSymbol, positive: boolean): Values {
        const e = skipParens(expression);
        const domain = new Set(state.domain);
        if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
            return this.constraint(e.operand, state, !positive);
        }
        if (ts.isBinaryExpression(e)) {
            const op = e.operatorToken.kind;
            if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
                const a = this.constraint(e.left, state, positive);
                const b = this.constraint(e.right, state, positive);
                const conjunction = (op === ts.SyntaxKind.AmpersandAmpersandToken) === positive;
                return conjunction ? intersect(a, b) : union(a, b);
            }
        }
        const leaf = this.comparison(e);
        if (!leaf || leaf.state !== state) return null;
        const holds = leaf.negated ? !positive : positive;
        return holds ? leaf.values : new Set([...domain].filter(v => !leaf.values.has(v)));
    }

    /**
     * The values the variable can have when `node` runs, from the conditions,
     * early returns, `case` labels and earlier writes around it in its function.
     */
    private sourcesOf(node: ts.Node, state: StateSymbol): { values: Values; afterAwait: boolean } {
        const boundary = enclosingFunction(node);
        let allowed: Values = null;
        let extra: Set<string> | undefined;
        let anchored = false;
        let afterAwait = containsAwait(node);
        const anchor = (c: Values) => {
            if (c) {
                allowed = intersect(allowed, c);
                anchored = true;
            }
        };
        let current: ts.Node = node;
        while (current.parent && current !== boundary) {
            const parent: ts.Node = current.parent;
            if (ts.isIfStatement(parent) && current !== parent.expression) {
                anchor(this.constraint(parent.expression, state, current === parent.thenStatement));
            } else if (ts.isConditionalExpression(parent) && current !== parent.condition) {
                anchor(this.constraint(parent.condition, state, current === parent.whenTrue));
            } else if (ts.isBinaryExpression(parent) && current === parent.right) {
                if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) anchor(this.constraint(parent.left, state, true));
                if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) anchor(this.constraint(parent.left, state, false));
            } else if ((ts.isCaseClause(parent) || ts.isDefaultClause(parent)) && current !== (parent as ts.CaseClause).expression) {
                anchor(this.caseConstraint(parent, state));
            } else if (ts.isTryStatement(parent) && current !== parent.tryBlock) {
                // In catch/finally the try block may have run partly.
                for (const w of this.writesIn(parent.tryBlock, state)) (extra ??= new Set()).add(w);
                if (!anchored && containsAwait(parent.tryBlock)) afterAwait = true;
            }
            if (ts.isCatchClause(parent) && current === parent.block) {
                // handled when reaching the TryStatement
            }
            const statements = statementList(parent);
            if (statements && !anchored) {
                const index = statements.indexOf(current as ts.Statement);
                for (let i = index - 1; i >= 0 && !anchored; i--) {
                    const statement = statements[i];
                    const definite = this.definiteWrite(statement, state);
                    if (definite) {
                        allowed = intersect(new Set(definite), allowed);
                        anchored = true;
                        break;
                    }
                    const guard = earlyExitCondition(statement);
                    if (guard) anchor(this.constraint(guard, state, false));
                    if (anchored) break;
                    for (const w of this.writesIn(statement, state)) (extra ??= new Set()).add(w);
                    if (containsAwait(statement)) afterAwait = true;
                }
            }
            current = parent;
        }
        if (!anchored) return { values: null, afterAwait: false };
        const values = allowed as Set<string> | null;
        if (values && extra) extra.forEach(v => values.add(v));
        return { values, afterAwait };
    }

    private caseConstraint(clause: ts.CaseClause | ts.DefaultClause, state: StateSymbol): Values {
        const sw = clause.parent.parent;
        if (!this.stateRead(sw.expression) || this.stateRead(sw.expression) !== state) {
            // switch (true) { case x === 'a': ... }
            if (ts.isCaseClause(clause) && sw.expression.kind === ts.SyntaxKind.TrueKeyword) return this.constraint(clause.expression, state, true);
            return null;
        }
        const clauses = sw.caseBlock.clauses;
        const labels = (c: ts.CaseOrDefaultClause) => (ts.isCaseClause(c) ? this.literalValues(c.expression) ?? [] : []);
        if (ts.isDefaultClause(clause)) {
            const listed = new Set(clauses.flatMap(labels));
            return new Set(state.domain.filter(v => !listed.has(v)));
        }
        // Fall-through from empty clauses just above.
        const values = new Set(labels(clause));
        for (let i = clauses.indexOf(clause) - 1; i >= 0 && clauses[i].statements.length === 0; i--) labels(clauses[i]).forEach(v => values.add(v));
        return values;
    }

    /** Values written by a statement that is itself a write of the variable. */
    private definiteWrite(statement: ts.Statement, state: StateSymbol): string[] | null {
        if (!ts.isExpressionStatement(statement)) return null;
        let e: ts.Expression = statement.expression;
        if (ts.isAwaitExpression(e)) return null;
        e = skipParens(e);
        const target = this.writeTarget(e);
        if (!target || this.states.get(target.symbol) !== state || !target.value) return null;
        return this.literalValues(target.value);
    }

    /** Values written anywhere inside a node (not in nested functions). */
    private writesIn(node: ts.Node, state: StateSymbol): string[] {
        const values: string[] = [];
        const visit = (n: ts.Node): void => {
            if (isFunctionLike(n)) return;
            const target = this.writeTarget(n);
            if (target && this.states.get(target.symbol) === state) {
                const v = target.value ? this.literalValues(target.value) : null;
                values.push(...(v ?? state.domain));
            }
            ts.forEachChild(n, visit);
        };
        visit(node);
        return values;
    }

    private switchFact(node: ts.SwitchStatement): void {
        const domain = literalDomain(this.checker.getTypeAtLocation(node.expression));
        if (!domain) return;
        const cases: string[] = [];
        let hasDefault = false;
        for (const clause of node.caseBlock.clauses) {
            if (ts.isDefaultClause(clause)) hasDefault = true;
            else cases.push(...(this.literalValues(clause.expression) ?? []));
        }
        const fn = enclosingFunction(node);
        this.facts.switches.push({
            subject: node.expression.getText(this.ctx.sf),
            variable: this.stateRead(node.expression)?.id,
            domain,
            cases,
            hasDefault,
            loc: this.ctx.loc(node),
            event: fn ? eventName(fn) : 'module'
        });
    }

    // ---------------------------------------------------------------- finish

    /** Writes of a parameter take the literal arguments of every call of the function. */
    resolveParameters(sources: readonly ts.SourceFile[]): void {
        if (this.pendingParams.length === 0) return;
        const names = new Set(this.pendingParams.map(p => memberName(p.fn)));
        const calls = new Map<ts.Node, ts.CallExpression[]>();
        for (const sf of sources) {
            const visit = (n: ts.Node): void => {
                if (ts.isCallExpression(n)) {
                    const callee = n.expression;
                    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
                    if (names.has(name)) {
                        const decl = this.checker.getResolvedSignature(n)?.declaration;
                        if (decl) calls.set(decl, [...(calls.get(decl) ?? []), n]);
                    }
                }
                ts.forEachChild(n, visit);
            };
            visit(sf);
        }
        for (const p of this.pendingParams) {
            const sites = calls.get(p.fn) ?? [];
            if (sites.length === 0) continue;
            const values = new Set<string>();
            let complete = true;
            for (const call of sites) {
                const arg = call.arguments[p.index];
                const v = arg ? this.literalValues(arg) : p.param.initializer ? this.literalValues(p.param.initializer) : null;
                if (v) v.forEach(x => values.add(x));
                else complete = false;
            }
            if (values.size === 0) continue;
            p.write.targets = [...values];
            if (!complete) p.write.incomplete = true;
        }
    }

    finish(): void {
        const seen = new Set<string>();
        for (const [symbol, state] of this.states) {
            const written = this.facts.writes.filter(w => w.variable === state.id);
            if (written.length === 0) continue;
            if (seen.has(state.id)) {
                const existing = this.facts.stateVariables.find(v => v.id === state.id)!;
                for (const v of this.initials.get(symbol) ?? []) if (!existing.initial.includes(v)) existing.initial.push(v);
                continue;
            }
            seen.add(state.id);
            const decl = state.decl;
            const sf = decl.getSourceFile();
            const file = sourcePath(relative(this.root, sf.fileName).split('\\').join('/'));
            this.facts.stateVariables.push({
                id: state.id,
                name: state.name,
                language: 'typescript',
                values: state.domain,
                inferred: false,
                initial: [...(this.initials.get(symbol) ?? [])],
                loc: { file, line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1 },
                owner: state.owner
            });
        }
        const known = new Set(this.facts.stateVariables.map(v => v.id));
        this.facts.writes = this.facts.writes.filter(w => known.has(w.variable));
        this.facts.reads = this.facts.reads.filter(r => known.has(r.variable));
    }
}

/** Declarations in compiled output (out/x.d.ts) are reported at their source (src/x.ts). */
function sourcePath(file: string): string {
    return file.replace(/(^|\/)(out|dist|build|lib)\/(.*)\.d\.ts$/, '$1src/$3.ts');
}

// ---------------------------------------------------------------- helpers

/** Plain data (interfaces, object types) is a state machine only for state-like names; class fields always qualify. */
const STATEISH = /(state|status|phase|stage|mode|step)$/i;

function isStateDeclaration(decl: ts.Declaration): boolean {
    if (ts.isPropertyDeclaration(decl)) return true;
    if (ts.isPropertySignature(decl)) return STATEISH.test(decl.name.getText());
    if (ts.isVariableDeclaration(decl)) return !ts.findAncestor(decl, isFunctionLike);
    if (ts.isParameter(decl)) return ts.isConstructorDeclaration(decl.parent) && !!(ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Private | ts.ModifierFlags.Public | ts.ModifierFlags.Protected));
    return false;
}

function ownerName(decl: ts.Declaration): string {
    const owner = ts.findAncestor(decl.parent, n => ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n));
    if (owner && (owner as ts.ClassDeclaration).name) return (owner as ts.ClassDeclaration).name!.getText();
    const file = decl.getSourceFile().fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    return file;
}

/** For Signal<T>, WritableSignal<T>, BehaviorSubject<T>...: T. */
function wrapperElement(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
    const name = type.getSymbol()?.getName() ?? type.aliasSymbol?.getName() ?? '';
    if (!/Signal$|Subject$/.test(name)) return undefined;
    const set = type.getProperty('set') ?? type.getProperty('next');
    const decl = set?.valueDeclaration ?? set?.declarations?.[0];
    if (!set || !decl) return undefined;
    const signature = checker.getTypeOfSymbolAtLocation(set, decl).getCallSignatures()[0];
    const parameter = signature?.parameters[0];
    if (!parameter) return undefined;
    return checker.getTypeOfSymbol(parameter);
}

/** Values of a finite union of string literals or enum members; null for any other type. */
function literalDomain(type: ts.Type): string[] | null {
    if (type.flags & ts.TypeFlags.Boolean) return null;
    const values = literalValuesOf(type);
    if (!values || values.length < 2 || values.length > MAX_DOMAIN) return null;
    return values;
}

function literalValuesOf(type: ts.Type): string[] | null {
    const members = type.isUnion() ? type.types : [type];
    const values: string[] = [];
    for (const t of members) {
        if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
        if (t.isStringLiteral()) values.push(t.value);
        else if (t.flags & ts.TypeFlags.EnumLiteral && t.symbol) values.push(t.symbol.getName());
        else return null;
    }
    return values;
}

function statementList(node: ts.Node): readonly ts.Statement[] | undefined {
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
    return undefined;
}

/** `if (c) return;` / `if (c) throw ...;` without else: the code after it runs only when c is false. */
function earlyExitCondition(statement: ts.Statement): ts.Expression | undefined {
    if (!ts.isIfStatement(statement) || statement.elseStatement) return undefined;
    let then: ts.Statement = statement.thenStatement;
    if (ts.isBlock(then)) {
        if (then.statements.length === 0) return undefined;
        then = then.statements[then.statements.length - 1];
    }
    return ts.isReturnStatement(then) || ts.isThrowStatement(then) || ts.isContinueStatement(then) || ts.isBreakStatement(then) ? statement.expression : undefined;
}

function containsAwait(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found || (n !== node && isFunctionLike(n))) return;
        if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) {
            found = true;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
}

export function union(a: Values, b: Values): Values {
    if (!a || !b) return null;
    return new Set([...a, ...b]);
}

export function intersect(a: Values, b: Values): Values {
    if (!a) return b ? new Set(b) : null;
    if (!b) return new Set(a);
    return new Set([...a].filter(v => b.has(v)));
}
