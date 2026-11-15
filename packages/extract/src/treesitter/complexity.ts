/**
 * Complexity of a function in the tree-sitter languages, from the syntax tree's node types (which the
 * grammars name alike: `if_statement`, `for_statement`, `catch_clause`, `match_expression`...).
 * Same measures as the TypeScript and Python front ends (see `ComplexityFact`); the node types are
 * matched by name, so a construct a grammar names differently may be missed.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ComplexityFact } from '../ir.js';

const IF = /^(if_statement|if_expression|if|unless|guard_statement|if_let_expression)$/;
const ELSE_IF = /^(elif_clause|else_if_clause|elsif)$/;
const ELSE = /^(else_clause|else)$/;
const LOOP = /^(for_statement|for_in_statement|for_of_statement|enhanced_for_statement|foreach_statement|for_each_statement|for_range_loop|range_based_for_statement|while_statement|do_statement|do_while_statement|for_expression|while_expression|loop_expression|repeat_statement|repeat_while_statement|for|while|until|while_modifier|until_modifier)$/;
const SWITCH = /^(switch_statement|switch_expression|match_expression|when_expression|case|case_statement|select_statement|expression_switch_statement|type_switch_statement)$/;
const CASE = /^(switch_case|case_clause|switch_label|switch_section|switch_rule|when_entry|match_arm|expression_case|type_case|communication_case|when|switch_entry|case_block|case_item)$/;
const CATCH = /^(catch_clause|rescue|except_clause|catch_block|rescue_modifier)$/;
const TERNARY = /^(conditional_expression|ternary_expression)$/;
const LOGICAL_NODE = /^(binary_expression|binary|boolean_operator|binary_operator|conjunction_expression|disjunction_expression|infix_expression)$/;
const LOGICAL_OP = new Set(['&&', '||', 'and', 'or']);
const JUMP = /^(break|continue)(_statement|_expression)$/;
const LAMBDA = /^(lambda|lambda_expression|lambda_literal|closure_expression|arrow_function|function_literal|anonymous_function|anonymous_function_creation_expression|func_literal|function_expression|block|do_block)$/;
/** Named functions nested in a function are measured on their own. */
const NAMED_FUNCTION = /^(function_definition|function_declaration|method_declaration|method_definition|local_function_statement|function_item|method|singleton_method|class_declaration|class_definition)$/;

interface Count {
    cognitive: number;
    cyclomatic: number;
    deepest: number;
    readonly fn: SyntaxNode;
    readonly name?: string;
}

export function complexityOf(fn: SyntaxNode, name?: string): ComplexityFact {
    const count: Count = { cognitive: 0, cyclomatic: 1, deepest: 0, fn, name };
    const body = fn.childForFieldName('body');
    if (body) visit(count, body, 0, 0);
    else children(count, fn, 0, 0);
    return { cognitive: count.cognitive, cyclomatic: count.cyclomatic, nesting: count.deepest };
}

function children(c: Count, n: SyntaxNode, nesting: number, depth: number): void {
    for (const x of n.namedChildren) if (x) visit(c, x, nesting, depth);
}

function structural(c: Count, nesting: number, depth: number): void {
    c.cognitive += 1 + nesting;
    c.deepest = Math.max(c.deepest, depth + 1);
}

function visit(c: Count, n: SyntaxNode, nesting: number, depth: number): void {
    const type = n.type;
    if (IF.test(type)) return visitIf(c, n, nesting, depth);
    if (ELSE_IF.test(type)) {
        // Reached outside its `if` (grammars that list elif clauses as siblings).
        c.cyclomatic++;
        c.cognitive++;
        return children(c, n, nesting + 1, depth + 1);
    }
    if (LOOP.test(type) || SWITCH.test(type) || CATCH.test(type) || TERNARY.test(type)) {
        if (!SWITCH.test(type)) c.cyclomatic++;
        structural(c, nesting, depth);
        return children(c, n, nesting + 1, depth + 1);
    }
    increments(c, n);
    if (n.id !== c.fn.id && NAMED_FUNCTION.test(type)) return;
    children(c, n, n.id !== c.fn.id && LAMBDA.test(type) ? nesting + 1 : nesting, depth);
}

function visitIf(c: Count, n: SyntaxNode, nesting: number, depth: number): void {
    c.cyclomatic++;
    if (isElseIf(n)) {
        c.cognitive++;
        c.deepest = Math.max(c.deepest, depth + 1);
    } else structural(c, nesting, depth);
    const alternative = n.childForFieldName('alternative');
    for (const x of n.namedChildren) {
        if (!x) continue;
        const isAlternative = (alternative && x.id === alternative.id) || ELSE.test(x.type) || ELSE_IF.test(x.type);
        if (isAlternative) visitAlternative(c, x, nesting, depth);
        else visit(c, x, nesting + 1, depth + 1);
    }
}

function visitAlternative(c: Count, alt: SyntaxNode, nesting: number, depth: number): void {
    if (IF.test(alt.type) || ELSE_IF.test(alt.type)) return visit(c, alt, nesting, depth);
    // An else (clause) holding only an if is an `else if`.
    const inner = alt.namedChildren.filter((x): x is SyntaxNode => !!x && !/comment/.test(x.type));
    if (ELSE.test(alt.type) && inner.length === 1 && IF.test(inner[0].type)) return visit(c, inner[0], nesting, depth);
    c.cognitive++;
    children(c, alt, nesting + 1, depth + 1);
}

/** Increments that do not nest: `case` labels, labelled jumps, sequences of logical operators, recursion. */
function increments(c: Count, n: SyntaxNode): void {
    if (CASE.test(n.type)) c.cyclomatic++;
    if (JUMP.test(n.type) && n.namedChildren.some(x => !!x && /identifier|label/.test(x.type))) c.cognitive++; // a labelled break or continue
    if (LOGICAL_NODE.test(n.type)) {
        const op = operatorOf(n);
        if (op && LOGICAL_OP.has(op)) {
            c.cyclomatic++;
            const parent = n.parent;
            if (!(parent && LOGICAL_NODE.test(parent.type) && operatorOf(parent) === op)) c.cognitive++;
        }
    }
    if (c.name && /call/.test(n.type) && isRecursiveCall(n, c.name)) c.cognitive++;
}

function isRecursiveCall(n: SyntaxNode, name: string): boolean {
    const callee = n.childForFieldName('function') ?? n.namedChildren[0];
    return !!callee && (callee.text === name || (callee.text.endsWith(`.${name}`) && /^(this|self)\./.test(callee.text)));
}

function isElseIf(n: SyntaxNode): boolean {
    const parent = n.parent;
    if (!parent) return false;
    if (ELSE.test(parent.type)) return parent.namedChildren.filter(c => c && !/comment/.test(c.type)).length === 1;
    const alternative = parent.childForFieldName('alternative');
    return IF.test(parent.type) && !!alternative && alternative.id === n.id;
}

function operatorOf(n: SyntaxNode): string | undefined {
    const field = n.childForFieldName('operator');
    if (field) return field.text;
    for (const c of n.children) if (c && !c.isNamed && LOGICAL_OP.has(c.text)) return c.text;
    // Ruby/Python spell some operators as named nodes.
    for (const c of n.children) if (c && LOGICAL_OP.has(c.type)) return c.type;
    return undefined;
}
