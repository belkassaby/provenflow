/**
 * Complexity findings from the measures the front ends computed per function (`FunctionFact.complexity`):
 * Cognitive Complexity above its limit, and control structures nested too deeply. Both carry their
 * measure, so a pull request is held responsible only for raising it (review new-code gating).
 */
import type { FunctionFact, Language } from '../ir.js';
import type { Finding } from '../models.js';
import { functionLabel } from './duplication.js';

export interface ComplexityLimits {
    cognitive: number;
    nesting: number;
}

export function complexityFindings(functions: FunctionFact[], limitsOf: (language: Language | undefined) => ComplexityLimits, languageOf: (file: string) => Language | undefined): Finding[] {
    const findings: Finding[] = [];
    for (const f of functions) {
        const c = f.complexity;
        if (!c) continue;
        const limits = limitsOf(languageOf(f.loc.file));
        const name = functionLabel(f);
        const endLine = f.loc.line + f.lines - 1;
        if (c.cognitive > limits.cognitive) {
            findings.push({
                rule: 'cognitive-complexity',
                category: 'complexity',
                severity: 'warning',
                subject: name,
                message: `${name} has a Cognitive Complexity of ${c.cognitive} (limit ${limits.cognitive}; cyclomatic ${c.cyclomatic}, nesting ${c.nesting}): it is hard to read and to test.`,
                fix: `Split ${name}: extract each nested block or step into a named function, return early instead of nesting (guard clauses), and replace boolean flags that select behaviour with separate functions.`,
                loc: f.loc,
                endLine,
                source: 'analysis',
                measure: { name: 'cognitive complexity', value: c.cognitive, limit: limits.cognitive }
            });
        }
        if (c.nesting > limits.nesting) {
            findings.push({
                rule: 'deep-nesting',
                category: 'complexity',
                severity: 'warning',
                subject: name,
                message: `${name} nests control structures ${c.nesting} deep (limit ${limits.nesting}).`,
                fix: `Flatten ${name}: invert conditions to return or continue early, and move the innermost blocks into functions.`,
                loc: f.loc,
                endLine,
                source: 'analysis',
                measure: { name: 'nesting depth', value: c.nesting, limit: limits.nesting }
            });
        }
    }
    return findings;
}
