/**
 * Complexity of a TypeScript/JavaScript function body, on the compiler's AST:
 *
 * - Cognitive Complexity (SonarSource whitepaper v1.7, Appendix B): +1 for `if`, `else if`, `else`,
 *   `?:`, `switch`, loops, `catch`, labelled jumps, each sequence of like `&&`/`||` operators and
 *   recursion; `if`, `?:`, `switch`, loops and `catch` also add their nesting level, and nested
 *   functions raise the nesting level of what they contain.
 * - Cyclomatic complexity: 1 + decision points (`if`, `?:`, loops, `case`, `catch`, `&&`, `||`, `??`).
 * - Nesting: the deepest nesting of control structures (nested functions not counted).
 */
import ts from 'typescript';
import type { ComplexityFact } from './ir.js';

interface Count {
    cognitive: number;
    cyclomatic: number;
    deepest: number;
    readonly name: string | undefined;
    readonly body: ts.Node;
}

export function complexityOf(fn: ts.Node, name: string | undefined): ComplexityFact {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return { cognitive: 0, cyclomatic: 1, nesting: 0 };
    const count: Count = { cognitive: 0, cyclomatic: 1, deepest: 0, name, body };
    visit(count, body, 0, 0);
    return { cognitive: count.cognitive, cyclomatic: count.cyclomatic, nesting: count.deepest };
}

/** nesting: the whitepaper's nesting level; depth: control structures only (for the nesting measure). */
function visit(c: Count, n: ts.Node, nesting: number, depth: number): void {
    if (ts.isIfStatement(n)) return visitIf(c, n, nesting, depth);
    if (ts.isConditionalExpression(n) || ts.isSwitchStatement(n) || isLoop(n) || ts.isCatchClause(n)) {
        if (!ts.isSwitchStatement(n)) c.cyclomatic++;
        structural(c, nesting, depth);
        ts.forEachChild(n, x => visit(c, x, nesting + 1, depth + 1));
        return;
    }
    increments(c, n);
    if (n !== c.body && isNestedFunction(n)) {
        // A named nested function is measured on its own; an anonymous one (a callback) adds to this one.
        if (!isNamedFunction(n)) ts.forEachChild(n, x => visit(c, x, nesting + 1, depth));
        return;
    }
    ts.forEachChild(n, x => visit(c, x, nesting, depth));
}

function structural(c: Count, nesting: number, depth: number): void {
    c.cognitive += 1 + nesting;
    c.deepest = Math.max(c.deepest, depth + 1);
}

/** `if`: +1 plus nesting; `else if` +1 (it continues the same chain); `else` +1. */
function visitIf(c: Count, n: ts.IfStatement, nesting: number, depth: number): void {
    const elseIf = ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
    c.cyclomatic++;
    if (elseIf) {
        c.cognitive++;
        c.deepest = Math.max(c.deepest, depth + 1);
    } else structural(c, nesting, depth);
    visit(c, n.expression, nesting + 1, depth + 1);
    visit(c, n.thenStatement, nesting + 1, depth + 1);
    if (!n.elseStatement) return;
    // An `else if` is visited at the level of the `if` it continues, so its body is as deep as the first one.
    if (ts.isIfStatement(n.elseStatement)) return visit(c, n.elseStatement, nesting, depth);
    c.cognitive++;
    visit(c, n.elseStatement, nesting + 1, depth + 1);
}

/** Increments that do not nest: `case`, labelled jumps, sequences of logical operators, recursion. */
function increments(c: Count, n: ts.Node): void {
    if (ts.isCaseClause(n)) c.cyclomatic++;
    if ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && n.label) c.cognitive++;
    if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (LOGICAL.has(op) || op === ts.SyntaxKind.QuestionQuestionToken) c.cyclomatic++;
        if (LOGICAL.has(op) && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === op)) c.cognitive++;
    }
    if (c.name && ts.isCallExpression(n) && calls(n.expression, c.name)) c.cognitive++;
}

const LOGICAL = new Set<ts.SyntaxKind>([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]);

function isLoop(n: ts.Node): boolean {
    return ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
}

function isNestedFunction(n: ts.Node): boolean {
    return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassExpression(n);
}

function isNamedFunction(n: ts.Node): boolean {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassExpression(n)) return true;
    return (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && (ts.isVariableDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertyAssignment(n.parent));
}

/** A direct recursive call: `name(...)` or `this.name(...)`. */
function calls(callee: ts.Expression, name: string): boolean {
    if (ts.isIdentifier(callee)) return callee.text === name;
    return ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword && callee.name.text === name;
}
