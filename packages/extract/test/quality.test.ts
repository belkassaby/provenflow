import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
    codeQuality,
    compareResults,
    comparisonMarkdown,
    compareWithReference,
    createBaseline,
    baselineReference,
    dominant,
    extractProject,
    findClones,
    isAgentCommit,
    mergeConfigs,
    mutateLine,
    parseCobertura,
    parseJacoco,
    parseLcov,
    planMutants,
    proposeConfig,
    rdjson,
    restyle,
    runReview,
    sarif,
    shapeOf,
    similarToSnippet,
    tokenize,
    validateFragment,
    type ExtractionResult,
    type Finding,
    type ProvenflowConfig
} from '../src/index.js';
import { complexityOf } from '../src/typescript-complexity.js';

const QUALITY = fileURLToPath(new URL('./fixtures/quality', import.meta.url));
const POLYGLOT = fileURLToPath(new URL('./fixtures/polyglot', import.meta.url));
const LAYERS: ProvenflowConfig = { layers: [{ name: 'core', paths: ['src/core/**'], mayImport: [] }, { name: 'ui', paths: ['src/ui/**'], mayImport: ['core'] }] };
const quick = { analyzers: false, confirm: false } as const;

function tsComplexity(code: string) {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
    const fn = sf.statements.find(ts.isFunctionDeclaration)!;
    return complexityOf(fn, fn.name?.text);
}

describe('tokenizer', () => {
    it('drops comments and import lines, keeps strings exact, normalises names and numbers', () => {
        const tokens = tokenize(`import {\n  a,\n  b\n} from './x';\n// comment\nconst total = price * 3; /* block\n comment */ log("text");`, 'f.ts');
        expect(tokens.map(t => t.norm)).toEqual(['const', '$id', '=', '$id', '*', '$num', ';', '$id', '(', '"text"', ')', ';']);
        expect(tokens.find(t => t.text === 'log')!.line).toBe(7);
    });

    it('reads Python comments, triple-quoted strings and Rust lifetimes', () => {
        expect(tokenize('x = """a\nb"""  # note\ny = 1', 'f.py').map(t => t.line)).toEqual([1, 1, 1, 3, 3, 3]);
        expect(tokenize("fn f<'a>(x: &'a str) -> char { 'c' }", 'f.rs').some(t => t.kind === 'lit' && t.text === "'c'")).toBe(true);
    });
});

describe('duplication', () => {
    const block = (name: string) => `function ${name}(xs) {\n${Array.from({ length: 12 }, (_, i) => `  if (xs[${i}] > limit) { total = total + xs[${i}] * rate; count++; }`).join('\n')}\n}`;

    it('finds a block copied with other names (Type-2), once', () => {
        const a = { file: 'a.ts', tokens: tokenize(block('first'), 'a.ts') };
        const b = { file: 'b.ts', tokens: tokenize(block('second').replace(/total/g, 'sum'), 'b.ts') };
        const clones = findClones([a, b], 100, 10);
        expect(clones).toHaveLength(1);
        expect(clones[0].original.file).toBe('a.ts');
        expect(clones[0].copy).toMatchObject({ file: 'b.ts', startLine: 1 });
    });

    it('reports a copied table, but not the rows of one table as copies of each other', () => {
        const table = `const rows = [\n${Array.from({ length: 60 }, (_, i) => `  push('row ${i}', ${i}),`).join('\n')}\n];`;
        expect(findClones([{ file: 'a.ts', tokens: tokenize(table, 'a.ts') }, { file: 'b.ts', tokens: tokenize(table.replace('rows', 'cols'), 'b.ts') }], 100, 10)).toHaveLength(1);
        expect(findClones([{ file: 'a.ts', tokens: tokenize(table, 'a.ts') }], 100, 10)).toHaveLength(0);
    });
});

describe('Cognitive Complexity (whitepaper examples)', () => {
    it('sumOfPrimes is 7 and getWords is 1', () => {
        expect(
            tsComplexity(`function sumOfPrimes(max: number) {
                let total = 0;
                OUT: for (let i = 1; i <= max; ++i) {
                    for (let j = 2; j < i; ++j) {
                        if (i % j === 0) { continue OUT; }
                    }
                    total += i;
                }
                return total;
            }`)
        ).toEqual({ cognitive: 7, cyclomatic: 4, nesting: 3 });
        expect(tsComplexity(`function getWords(n: number) { switch (n) { case 1: return 'one'; case 2: return 'a couple'; default: return 'lots'; } }`).cognitive).toBe(1);
    });

    it('counts else-if chains, logical sequences and recursion; callbacks nest, named inner functions do not count', () => {
        expect(tsComplexity(`function f(a, b, c) { if (a && b || c) { return 1; } else if (b) { return 2; } else { return f(a, b, c); } }`).cognitive).toBe(1 + 2 + 1 + 1 + 1);
        expect(tsComplexity(`function f(xs) { xs.forEach(x => { if (x) { log(x); } }); }`).cognitive).toBe(2);
        expect(tsComplexity(`function f(xs) { const g = (x) => { if (x) { if (x > 1) { log(x); } } }; return g; }`).cognitive).toBe(0);
    });
});

describe('naming', () => {
    it('recognises styles and rewrites names', () => {
        expect(['userName', 'UserName', 'user_name', 'USER_NAME', 'user', 'URL', 'User_name'].map(shapeOf)).toEqual(['camelCase', 'PascalCase', 'snake_case', 'SCREAMING_SNAKE_CASE', 'lower', 'upper', 'mixed']);
        expect(restyle('parse_order_line', 'camelCase')).toBe('parseOrderLine');
        expect(restyle('parseHTTPRequest', 'snake_case')).toBe('parse_http_request');
        expect(dominant([...Array(9).fill({ name: 'do_it_now' }), { name: 'doItNow' }])).toBe('snake_case');
        expect(dominant([{ name: 'a' }, { name: 'b' }])).toBeUndefined();
    });
});

describe('coverage reports', () => {
    it('reads LCOV, Cobertura and JaCoCo', () => {
        expect(parseLcov('SF:src/a.ts\nDA:3,1\nDA:4,0\nend_of_record\n').get('src/a.ts')).toEqual(new Map([[3, 1], [4, 0]]));
        const cobertura = '<coverage><sources><source>/w/app</source></sources><packages><package><classes><class name="a" filename="src/a.py"><lines><line number="2" hits="5"/><line number="3" hits="0"/></lines></class></classes></package></packages></coverage>';
        expect(parseCobertura(cobertura).get('/w/app/src/a.py')).toEqual(new Map([[2, 5], [3, 0]]));
        const jacoco = '<report name="r"><package name="app/core"><sourcefile name="Job.java"><line nr="7" mi="0" ci="2" mb="0" cb="0"/><line nr="8" mi="3" ci="0" mb="0" cb="0"/></sourcefile></package></report>';
        expect(parseJacoco(jacoco).get('app/core/Job.java')).toEqual(new Map([[7, 2], [8, 0]]));
    });
});

describe('the fixture project', () => {
    let result: ExtractionResult;
    const rules = (rule: string) => result.findings.filter(f => f.rule === rule);

    it('reports each seeded quality problem', async () => {
        result = await extractProject(QUALITY, { ...quick, config: { ...LAYERS, coverage: { reports: ['reports/lcov.info'] } } });
        const [clone] = rules('duplicated-code');
        expect(clone).toMatchObject({ loc: { file: 'src/ui/cart.ts', line: 4 }, related: [{ file: 'src/core/prices.ts', line: 10 }] });
        expect(clone.fix).toMatch(/Import it from src\/core\/prices.ts/);
        const [similar] = rules('similar-function');
        expect(similar.subject).toBe('showAmount ~ formatAmount');
        expect(similar.fix).toMatch(/Reuse formatAmount/);
        expect(rules('cognitive-complexity').map(f => f.subject).sort()).toEqual(['applyDiscounts', 'classify']);
        expect(rules('deep-nesting').map(f => f.subject).sort()).toEqual(['applyDiscounts', 'classify']);
        expect(rules('naming-convention').map(f => f.subject)).toEqual(['function parse_order_line']);
        expect(rules('naming-convention')[0].fix).toMatch(/parseOrderLine/);
        expect(rules('unknown-dependency').map(f => [f.subject, f.severity])).toEqual(expect.arrayContaining([['left-pad-ultra', 'error'], ['requestz', 'error']]));
        expect(rules('unknown-dependency').some(f => f.subject === 'lodash')).toBe(false);
        expect(rules('untested-complex-function').map(f => f.subject)).toEqual(['applyDiscounts']);
    });

    it('measures the code base', () => {
        const m = result.quality.metrics;
        expect(m.duplication.clones).toBe(1);
        expect(m.duplication.similarFunctions).toBe(1);
        expect(m.duplication.duplicatedLines).toBeGreaterThanOrEqual(20);
        expect(m.complexity.overLimit).toBe(2);
        expect(m.hotspots[0].name).toMatch(/applyDiscounts|classify/);
        expect(m.coverage!.covered).toBeGreaterThan(0);
        expect(m.dependencies.unknown).toBe(2);
    });

    it('finds existing code similar to a snippet an agent is about to write', () => {
        const snippet = `function fmt(value: number, currency: string, locale: string) {
            const rounded = Math.round(value * 100) / 100;
            const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
            const parts = rounded.toFixed(2).split('.');
            return symbol + parts[0] + (locale === 'fr' ? ',' : '.') + parts[1];
        }`;
        const matches = similarToSnippet(result.facts.functions, f => readFileSync(join(QUALITY, f), 'utf8'), snippet, 'x.ts');
        expect(matches[0].fn.name).toMatch(/formatAmount|showAmount/);
    });

    it('writes SARIF with stable fingerprints, GitLab Code Quality and rdjson', () => {
        const s = sarif(result) as { runs: Array<{ results: Array<{ partialFingerprints: Record<string, string> }>; tool: { driver: { rules: Array<{ helpUri: string }> } } }> };
        const prints = s.runs[0].results.map(r => r.partialFingerprints['primaryLocationLineHash']);
        expect(new Set(prints).size).toBe(prints.length);
        expect(s.runs[0].tool.driver.rules.every(r => r.helpUri.startsWith('https://'))).toBe(true);
        const gitlab = codeQuality(result) as Array<{ fingerprint: string; severity: string; check_name: string }>;
        expect(gitlab.find(g => g.check_name === 'unknown-dependency')!.severity).toBe('critical');
        expect((rdjson(result) as { diagnostics: unknown[] }).diagnostics.length).toBe(result.findings.filter(f => f.loc).length);
    });

    it('proposes a config with the language standards', () => {
        const proposed = proposeConfig(result, {});
        expect(proposed.config.languages?.typescript?.naming?.function).toBe('camelCase');
        expect(proposed.config.languages?.python?.complexity?.cognitive).toBe(15);
        expect(proposed.config.layers?.map(l => l.name).sort()).toEqual(['core', 'ui']);
        expect(proposed.evidence.some(e => /Google TypeScript Style Guide/.test(e))).toBe(true);
    });

    it('compares two versions', async () => {
        const without = await extractProject(QUALITY, { ...quick, config: LAYERS, overrides: new Map([['src/ui/cart.ts', ''], ['src/ui/display.ts', '']]) });
        const comparison = compareResults(without, result, { before: 'before', after: 'after' });
        expect(comparison.introduced.map(f => f.rule)).toEqual(expect.arrayContaining(['duplicated-code', 'similar-function', 'naming-convention']));
        expect(comparisonMarkdown(comparison)).toMatch(/\| clones \(copied blocks\) \| 0 \| 1 \| \+1 ✗ \|/);
    });
});

describe('measured in the other languages', () => {
    it('computes complexity for the tree-sitter languages', async () => {
        const r = await extractProject(POLYGLOT, quick);
        const measured = r.facts.functions.filter(f => f.complexity && f.complexity.cyclomatic > 1);
        const languages = new Set(measured.map(f => r.facts.modules.find(m => m.file === f.loc.file)?.language));
        expect(languages.size).toBeGreaterThanOrEqual(12);
    });
});

describe('gating what is new', () => {
    const finding = (subject: string, value?: number): Finding => ({ rule: 'cognitive-complexity', category: 'complexity', severity: 'warning', subject, message: '', fix: '', source: 'analysis', loc: { file: 'a.ts', line: 1 }, ...(value !== undefined ? { measure: { name: 'cognitive complexity', value, limit: 15 } } : {}) });

    it('accepts what the baseline has, and holds a change responsible for raising a measure', () => {
        const baseline = createBaseline([finding('f', 20), finding('g', 18)]);
        const split = compareWithReference([finding('f', 20), finding('g', 25), finding('h', 16)], baselineReference(baseline));
        expect(split.existing.map(f => f.subject)).toEqual(['f']);
        expect(split.fresh.map(f => f.subject)).toEqual(['g', 'h']);
        expect(split.fresh[0].message).toMatch(/Raised from 18/);
        expect(compareWithReference([], baselineReference(baseline)).gone).toHaveLength(2);
    });

    it('recognises commits by coding agents', () => {
        expect(isAgentCommit('Jane <jane@x.org>', 'Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')).toBe(true);
        expect(isAgentCommit('Copilot <198982749+Copilot@users.noreply.github.com>', 'Add test')).toBe(true);
        expect(isAgentCommit('dependabot[bot] <x@github.com>', 'Bump')).toBe(false);
        expect(isAgentCommit('Jane <jane@x.org>', 'Refactor')).toBe(false);
    });
});

describe('mutation testing', () => {
    it('makes one mutant per line, never in strings, comments or arid lines', () => {
        expect(mutateLine('    if (a < b && ok) {', 'f.ts')).toEqual({ operator: 'change boundary', after: '    if (a <= b && ok) {' });
        expect(mutateLine('    return x === y;', 'f.ts')!.after).toBe('    return x !== y;');
        expect(mutateLine("    const s = 'a < b'; // a > b", 'f.ts')).toBeUndefined();
        expect(mutateLine('    console.log(a < b);', 'f.ts')).toBeUndefined();
        expect(mutateLine('    if x and y:', 'f.py')!.after).toBe('    if x or y:');
        const plan = planMutants(new Map([['f.ts', new Set([1, 2, 3])]]), () => 'if (a < b) {\n// c\nreturn true;', 10);
        expect(plan.map(p => p.line)).toEqual([1, 3]);
    });
});

describe('rules from instruction files', () => {
    it('keeps only what follows the config schema', () => {
        expect(validateFragment({ layers: [{ name: 'ui', paths: ['src/ui/**'], mayImport: ['core'] }] }).errors).toEqual([]);
        expect(validateFragment({ languages: { python: { naming: { function: 'snake_case' }, complexity: { cognitive: 10 } } } }).config.languages?.python?.complexity).toEqual({ cognitive: 10 });
        expect(validateFragment({ ignore: [{ rule: '*' }] }).errors[0]).toMatch(/not a field/);
        expect(validateFragment({ patterns: [{ subject: 'X', pattern: 'god' }] }).errors[0]).toMatch(/patterns must be one of/);
        expect(mergeConfigs([{ patterns: [{ subject: 'A', pattern: 'singleton' }] }, { patterns: [{ subject: 'B', pattern: 'facade' }] }]).patterns).toHaveLength(2);
    });
});

describe('a review of a change in a git repository', () => {
    it('reports only what the change adds, and holds agent-written lines to warnings', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'provenflow-review-'));
        try {
            cpSync(QUALITY, dir, { recursive: true });
            const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Jane', GIT_AUTHOR_EMAIL: 'jane@example.org', GIT_COMMITTER_NAME: 'Jane', GIT_COMMITTER_EMAIL: 'jane@example.org' } });
            git('init', '-q');
            git('add', '.');
            git('commit', '-qm', 'base');
            // The agent's change: one more copy of the price loop, in a new file.
            writeFileSync(join(dir, 'src/ui/receipt.ts'), `import type { Item } from '../core/prices';\n\nexport function receiptTotal(rows: Item[], rate: number): number {\n    let acc = 0;\n    for (const row of rows) {\n        const value = row.price * row.quantity;\n        const duty = value * rate;\n        if (row.category === 'food') {\n            acc += value;\n        } else if (row.category === 'books') {\n            acc += value + duty / 2;\n        } else if (row.category === 'toys') {\n            acc += value + duty * 2;\n        } else if (row.category === 'music') {\n            acc += value + duty * 3;\n        } else {\n            acc += value + duty;\n        }\n    }\n    return acc;\n}\n`);
            git('add', '.');
            git('commit', '-qm', 'Add receipts\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
            const run = await runReview(dir, { ...quick, config: LAYERS, base: 'HEAD~1', newOnly: true, failOn: 'error' });
            expect(run.relevant.map(f => f.rule)).toEqual(expect.arrayContaining(['duplicated-code', 'change-without-test']));
            expect(run.relevant.every(f => f.loc?.file === 'src/ui/receipt.ts')).toBe(true);
            expect(run.agents?.commits).toHaveLength(1);
            // A warning fails on agent-written lines (failOn is error for the others).
            expect(run.failing.map(f => f.rule)).toContain('duplicated-code');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
