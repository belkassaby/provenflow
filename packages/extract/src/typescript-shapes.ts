/** The shape of the code: classes, interfaces, functions and modules (imports, mutation), for the pattern, paradigm and architecture analyses. */
import { relative } from 'node:path';
import ts from 'typescript';
import type { ClassFact, DeclaredMachineFact, FieldFact, FunctionFact, InterfaceFact, MethodFact, ModuleFact } from './ir.js';
import type { SourceContext } from './typescript-context.js';
import { complexityOf } from './typescript-complexity.js';
import { COMPILER_OPTIONS, escape, isFunctionLike, memberName, skipParens, TEMPLATE_PREFIX } from './typescript-util.js';

export class ShapeFacts {
    constructor(private readonly ctx: SourceContext) {}

        classFact(node: ts.ClassDeclaration): ClassFact {
        const name = node.name!.text;
        const fields: FieldFact[] = [];
        const methods: MethodFact[] = [];
        let privateConstructor = false;
        for (const member of node.members) {
            const modifiers = ts.getCombinedModifierFlags(member as ts.Declaration);
            const visibility = modifiers & ts.ModifierFlags.Private || (member.name && ts.isPrivateIdentifier(member.name)) ? 'private' : modifiers & ts.ModifierFlags.Protected ? 'protected' : 'public';
            const isStatic = !!(modifiers & ts.ModifierFlags.Static);
            if (member.name && member.name.getText(this.ctx.sf).startsWith(TEMPLATE_PREFIX)) continue;
            if (ts.isConstructorDeclaration(member)) {
                if (visibility === 'private') privateConstructor = true;
                if (member.body) methods.push(this.methodFact('constructor', member, visibility, false, false));
                for (const p of member.parameters) {
                    const pm = ts.getCombinedModifierFlags(p);
                    if (pm & (ts.ModifierFlags.Private | ts.ModifierFlags.Public | ts.ModifierFlags.Protected | ts.ModifierFlags.Readonly)) {
                        fields.push({ name: p.name.getText(this.ctx.sf), visibility: pm & ts.ModifierFlags.Private ? 'private' : pm & ts.ModifierFlags.Protected ? 'protected' : 'public', readonly: !!(pm & ts.ModifierFlags.Readonly), static: false, type: p.type?.getText(this.ctx.sf) });
                    }
                }
                continue;
            }
            if (ts.isPropertyDeclaration(member)) {
                const init = member.initializer;
                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                    methods.push(this.methodFact(member.name.getText(this.ctx.sf), init, visibility, isStatic, false));
                } else {
                    fields.push({ name: member.name.getText(this.ctx.sf), visibility, readonly: !!(modifiers & ts.ModifierFlags.Readonly), static: isStatic, type: member.type?.getText(this.ctx.sf) ?? (init && ts.isNewExpression(init) ? init.expression.getText(this.ctx.sf) : undefined) });
                }
            } else if (ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
                methods.push(this.methodFact(member.name.getText(this.ctx.sf), member, visibility, isStatic, !!(modifiers & ts.ModifierFlags.Abstract)));
            }
        }
        const heritage = node.heritageClauses ?? [];
        const decorators = ts.getDecorators(node) ?? [];
        return {
            id: `${this.ctx.file}#${name}`,
            name,
            language: 'typescript',
            loc: this.ctx.loc(node),
            lines: lineCount(this.ctx.sf, node),
            abstract: !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Abstract),
            extends: heritage.find(h => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText(this.ctx.sf),
            implements: heritage.filter(h => h.token === ts.SyntaxKind.ImplementsKeyword).flatMap(h => h.types.map(t => t.expression.getText(this.ctx.sf))),
            decorators: decorators.map(d => d.expression.getText(this.ctx.sf).replace(/\(.*$/s, '')),
            providedInRoot: decorators.some(d => /Injectable\s*\(\s*\{[^}]*providedIn\s*:\s*['"]root['"]/.test(d.getText(this.ctx.sf))),
            privateConstructor,
            fields,
            methods
        };
    }

    private methodFact(name: string, fn: ts.FunctionLikeDeclaration, visibility: FieldFact['visibility'], isStatic: boolean, abstract: boolean): MethodFact {
        const params = new Set(fn.parameters.map(p => p.name.getText(this.ctx.sf)));
        const fact: MethodFact = {
            name,
            visibility,
            static: isStatic,
            abstract,
            loc: this.ctx.loc(fn),
            lines: lineCount(this.ctx.sf, fn),
            params: fn.parameters.length,
            returnsThis: false,
            returnsNew: [],
            returnsFunction: false,
            calls: [],
            iteratesAndCalls: [],
            addsParamTo: [],
            removesFrom: [],
            notImplemented: false,
            assigns: [],
            validates: false
        };
        const body = fn.body;
        if (!body) return fact;
        const thisField = (e: ts.Expression): string | undefined =>
            ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword ? e.name.text : undefined;
        const add = (list: string[], v: string | undefined) => {
            if (v && !list.includes(v)) list.push(v);
        };
        const visit = (n: ts.Node): void => {
            if (n !== fn && isFunctionLike(n) && !ts.isArrowFunction(n)) return;
            if (ts.isReturnStatement(n) && n.expression) {
                const e = skipParens(n.expression);
                if (e.kind === ts.SyntaxKind.ThisKeyword) fact.returnsThis = true;
                if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) add(fact.returnsNew, e.expression.text);
                if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) fact.returnsFunction = true;
            }
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
                const method = n.expression.name.text;
                const owner = n.expression.expression;
                if (owner.kind === ts.SyntaxKind.ThisKeyword) add(fact.calls, method);
                const field = thisField(owner);
                if (field) {
                    const arg = n.arguments[0];
                    if (['push', 'add', 'set', 'unshift'].includes(method) && n.arguments.some(a => ts.isIdentifier(a) && params.has(a.text))) add(fact.addsParamTo, field);
                    if (['delete', 'splice', 'remove', 'clear'].includes(method)) add(fact.removesFrom, field);
                    if (method === 'forEach' && arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && callsParameter(arg)) add(fact.iteratesAndCalls, field);
                }
            }
            if (ts.isForOfStatement(n)) {
                const field = thisField(skipParens(n.expression)) ?? (ts.isCallExpression(n.expression) ? thisField((n.expression.expression as ts.PropertyAccessExpression).expression ?? n.expression) : undefined);
                const variable = ts.isVariableDeclarationList(n.initializer) ? n.initializer.declarations[0]?.name.getText(this.ctx.sf) : undefined;
                if (field && variable && new RegExp(`\\b${escape(variable)}(\\.\\w+)?\\s*\\(`).test(n.statement.getText(this.ctx.sf))) add(fact.iteratesAndCalls, field);
            }
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const field = thisField(n.left);
                if (field) {
                    add(fact.assigns, field);
                    if (ts.isCallExpression(n.right) && ts.isPropertyAccessExpression(n.right.expression) && n.right.expression.name.text === 'filter' && thisField(n.right.expression.expression) === field) add(fact.removesFrom, field);
                }
            }
            if (ts.isIfStatement(n) && containsThrow(n.thenStatement)) fact.validates = true;
            ts.forEachChild(n, visit);
        };
        visit(body);
        if (ts.isBlock(body) && body.statements.length === 1) {
            const only = body.statements[0];
            if (ts.isThrowStatement(only)) fact.notImplemented = true;
            const expression = ts.isReturnStatement(only) ? only.expression : ts.isExpressionStatement(only) ? only.expression : undefined;
            const call = expression && skipParens(ts.isAwaitExpression(expression) ? expression.expression : expression);
            if (call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
                const field = thisField(call.expression.expression);
                if (field) fact.delegatesTo = field;
            }
        } else if (!ts.isBlock(body)) {
            const call = skipParens(body);
            if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
                const field = thisField(call.expression.expression);
                if (field) fact.delegatesTo = field;
            }
        }
        return fact;
    }

    interfaceFact(node: ts.InterfaceDeclaration): InterfaceFact {
        const methods: string[] = [];
        let callSignatures = 0;
        for (const member of node.members) {
            if (ts.isMethodSignature(member)) methods.push(member.name.getText(this.ctx.sf));
            else if (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type)) methods.push(member.name.getText(this.ctx.sf));
            else if (ts.isCallSignatureDeclaration(member)) callSignatures++;
        }
        return { name: node.name.text, loc: this.ctx.loc(node), language: 'typescript', methods, callable: callSignatures > 0 && node.members.length === callSignatures };
    }

    // ------------------------------------------------------------- functions

    functionFact(fn: ts.FunctionLikeDeclaration): FunctionFact | undefined {
        const name = memberName(fn);
        if (!name || name === 'anonymous' || name.startsWith(TEMPLATE_PREFIX)) return undefined;
        const free = !ts.findAncestor(fn.parent, n => ts.isClassDeclaration(n) || ts.isClassExpression(n)) && !ts.findAncestor(fn.parent, isFunctionLike);
        const params = fn.parameters.map(p => p.name.getText(this.ctx.sf));
        const paramSet = new Set(params);
        const mutatesParams = new Set<string>();
        const writesOuter = new Set<string>();
        const effects = new Set<string>();
        let usesThis = false;
        let higherOrder = fn.parameters.some(p => p.type && ts.isFunctionTypeNode(p.type)) || (!!fn.type && ts.isFunctionTypeNode(fn.type));
        const root = (e: ts.Expression): ts.Expression => {
            let r = e;
            while (ts.isPropertyAccessExpression(r) || ts.isElementAccessExpression(r) || ts.isNonNullExpression(r)) r = r.expression;
            return r;
        };
        const visit = (n: ts.Node): void => {
            if (n.kind === ts.SyntaxKind.ThisKeyword && !ts.findAncestor(n.parent, x => x !== fn && isFunctionLike(x) && !ts.isArrowFunction(x))) usesThis = true;
            if (ts.isBinaryExpression(n) && isAssignment(n.operatorToken.kind)) {
                const lhs = n.left;
                if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) {
                    const r = root(lhs);
                    if (ts.isIdentifier(r) && paramSet.has(r.text)) mutatesParams.add(r.text);
                } else if (ts.isIdentifier(lhs)) {
                    const symbol = this.ctx.checker.getSymbolAtLocation(lhs);
                    const decl = symbol?.valueDeclaration;
                    if (decl && ts.isVariableDeclaration(decl) && !isInside(decl, fn)) writesOuter.add(lhs.text);
                }
            }
            if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(n.operand)) {
                const decl = this.ctx.checker.getSymbolAtLocation(n.operand)?.valueDeclaration;
                if (decl && ts.isVariableDeclaration(decl) && !isInside(decl, fn)) writesOuter.add(n.operand.text);
            }
            if (ts.isCallExpression(n)) {
                const callee = n.expression;
                const text = callee.getText(this.ctx.sf);
                if (ts.isPropertyAccessExpression(callee)) {
                    const method = callee.name.text;
                    const r = root(callee.expression);
                    if (MUTATORS.has(method) && ts.isIdentifier(r) && paramSet.has(r.text)) mutatesParams.add(r.text);
                    if (HIGHER_ORDER.has(method) && n.arguments.some(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a))) higherOrder = true;
                }
                const effect = EFFECTS.find(re => re.test(text));
                if (effect) effects.add(text.replace(/\(.*$/s, ''));
            }
            if (ts.isNewExpression(n) && n.expression.getText(this.ctx.sf) === 'Date' && !n.arguments?.length) effects.add('new Date');
            if (n !== fn.body && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isReturnStatement(n.parent)) higherOrder = true;
            ts.forEachChild(n, visit);
        };
        if (fn.body) visit(fn.body);
        const exported = ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Export || (ts.isVariableDeclaration(fn.parent) && ts.getCombinedModifierFlags(fn.parent) & ts.ModifierFlags.Export);
        return {
            id: `${this.ctx.file}#${name}`,
            name,
            loc: this.ctx.loc(fn),
            lines: lineCount(this.ctx.sf, fn),
            exported: !!exported,
            free,
            params: params.length,
            higherOrder,
            mutatesParams: [...mutatesParams],
            writesOuter: [...writesOuter],
            effects: [...effects],
            usesThis,
            complexity: complexityOf(fn, name)
        };
    }

    // --------------------------------------------------------------- modules

    moduleFact(sf: ts.SourceFile): ModuleFact {
        const imports: ModuleFact['imports'] = [];
        const mutableGlobals: ModuleFact['mutableGlobals'] = [];
        let mutations = 0;
        let reassignments = 0;
        let immutableDeclarations = 0;
        const addImport = (spec: ts.Expression, node: ts.Node, typeOnly: boolean) => {
            if (!ts.isStringLiteral(spec)) return;
            const resolved = ts.resolveModuleName(spec.text, sf.fileName, COMPILER_OPTIONS, ts.sys).resolvedModule?.resolvedFileName;
            let file = resolved && !resolved.includes('/node_modules/') ? relative(this.ctx.root, resolved).split('\\').join('/') : undefined;
            if (file?.startsWith('..')) file = undefined;
            imports.push({ specifier: spec.text, resolved: file, loc: this.ctx.loc(node), typeOnly });
        };
        for (const statement of sf.statements) {
            if (ts.isImportDeclaration(statement)) {
                const clause = statement.importClause;
                const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(e => e.isTypeOnly)));
                addImport(statement.moduleSpecifier, statement, typeOnly);
            } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
                addImport(statement.moduleSpecifier, statement, statement.isTypeOnly);
            } else if (ts.isVariableStatement(statement)) {
                const flags = statement.declarationList.flags;
                if (!(flags & ts.NodeFlags.Const)) {
                    for (const d of statement.declarationList.declarations) mutableGlobals.push({ name: d.name.getText(sf), loc: this.ctx.loc(d) });
                }
            }
        }
        const visit = (n: ts.Node): void => {
            if (ts.isVariableDeclarationList(n) && n.flags & ts.NodeFlags.Const) immutableDeclarations += n.declarations.length;
            if (ts.isPropertyDeclaration(n) && ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Readonly) immutableDeclarations++;
            if (ts.isBinaryExpression(n) && isAssignment(n.operatorToken.kind)) {
                if (ts.isIdentifier(n.left)) {
                    const decl = this.ctx.checker.getSymbolAtLocation(n.left)?.valueDeclaration;
                    if (decl && ts.isVariableDeclaration(decl) && !(decl.parent.flags & ts.NodeFlags.Const) && ts.findAncestor(decl, isFunctionLike)) reassignments++;
                } else if ((ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) && n.left.expression.kind !== ts.SyntaxKind.ThisKeyword) {
                    mutations++;
                }
            }
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text) && n.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) {
                mutations++;
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
        return { file: this.ctx.file, language: 'typescript', lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1, imports, mutableGlobals, mutations, reassignments, immutableDeclarations, isTest: this.ctx.test };
    }

    declaredMachines(sf: ts.SourceFile): DeclaredMachineFact[] {
        const machines: DeclaredMachineFact[] = [];
        const visit = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'createMachine' && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
                const id = n.arguments[0].properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'id') as ts.PropertyAssignment | undefined;
                const name = id && ts.isStringLiteral(id.initializer) ? id.initializer.text : `machine_${this.ctx.loc(n).line}`;
                machines.push({ name, loc: this.ctx.loc(n), library: 'xstate', text: n.getText(sf) });
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
        return machines;
    }

}

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'delete', 'add', 'clear']);
const HIGHER_ORDER = new Set(['map', 'filter', 'reduce', 'flatMap', 'some', 'every', 'find', 'findIndex', 'forEach', 'sort']);
const EFFECTS = [/^console\./, /^(fs\.)?(readFile|writeFile|mkdir|mkdtemp|rm|readdir|stat|appendFile)(Sync)?$/, /^fetch$/, /^Date\.now$/, /^Math\.random$/, /^process\./, /^(window\.)?(localStorage|sessionStorage)\./, /^document\./, /^window\./, /^spawn(Sync)?$/, /^exec(Sync|File)?$/];

function isAssignment(kind: ts.SyntaxKind): boolean {
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function containsThrow(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found || isFunctionLike(n)) return;
        if (ts.isThrowStatement(n)) found = true;
        else ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
}

function callsParameter(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
    const name = fn.parameters[0]?.name.getText();
    return !!name && new RegExp(`\\b${escape(name)}(\\.\\w+)?\\s*\\(`).test(fn.body.getText());
}

function isInside(inner: ts.Node, outer: ts.Node): boolean {
    return inner.pos >= outer.pos && inner.end <= outer.end && inner.getSourceFile() === outer.getSourceFile();
}

function lineCount(sf: ts.SourceFile, node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.end).line - sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
