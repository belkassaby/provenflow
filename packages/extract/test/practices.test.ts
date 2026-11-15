import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOGUE, catalogueMarkdown, extractProject, practiceOf, quickFixes, selectedPractices, type ExtractionResult, type Finding } from '../src/index.js';
import { deleteLinesEdit, rethrowEdit, uniqueEdit } from '../src/quality/practices.js';

const PRACTICES = fileURLToPath(new URL('./fixtures/practices', import.meta.url));
const read = (file: string) => readFileSync(join(PRACTICES, file), 'utf8');
const byRule = (result: ExtractionResult, rule: string, file?: string) => result.findings.filter(f => f.rule === rule && (!file || f.loc?.file === file));

describe('patterns and practices catalogue', () => {
    it('gives every entry the parts of the pattern form, and owns each rule once', () => {
        const rules = CATALOGUE.flatMap(p => p.rules);
        expect(new Set(rules).size).toBe(rules.length);
        expect(new Set(CATALOGUE.map(p => p.id)).size).toBe(CATALOGUE.length);
        for (const p of CATALOGUE) {
            for (const part of [p.name, p.summary, p.problem, p.solution, p.use, p.avoid, p.checks, p.example.before, p.example.after]) expect(part.trim().length, `${p.id}`).toBeGreaterThan(0);
            expect(p.rules.length, p.id).toBeGreaterThan(0);
            expect(p.sources.length, p.id).toBeGreaterThan(0);
            for (const id of p.related) expect(CATALOGUE.some(x => x.id === id), `${p.id} → ${id}`).toBe(true);
        }
        expect(new Set(CATALOGUE.map(p => p.kind))).toEqual(new Set(['pattern', 'principle', 'anti-pattern']));
    });

    it('maps findings to entries by rule, by category and rule, and by pattern model', () => {
        expect(practiceOf({ rule: 'duplicated-code', category: 'duplication' })).toBe('dry');
        expect(practiceOf({ rule: 'unreachable-state', category: 'pattern' })).toBe('state');
        expect(practiceOf({ rule: 'unreachable-state', category: 'state-machine' })).toBeUndefined();
        expect(practiceOf({ rule: 'property-violated', category: 'pattern', model: 'pattern-singleton-Store' })).toBe('singleton');
        expect(practiceOf({ rule: 'sql-injection', category: 'security' })).toBeUndefined();
    });

    it('selects the default entries, a given list, or the default less skipped ones', () => {
        const defaults = selectedPractices({}).selected;
        expect(defaults.has('dry')).toBe(true);
        expect(defaults.has('magic-number')).toBe(false);
        expect([...selectedPractices({ checks: { select: ['dry', 'magic-number', 'nope'] } }).selected]).toEqual(['dry', 'magic-number']);
        expect(selectedPractices({ checks: { select: ['nope'] } }).unknown).toEqual(['nope']);
        expect(selectedPractices({ checks: { skip: ['dry'] } }).selected.has('dry')).toBe(false);
    });

    it('renders as Markdown with every entry and its example', () => {
        const md = catalogueMarkdown();
        for (const p of CATALOGUE) expect(md).toContain(`### ${p.name}`);
        expect(md).toContain('| [Magic Number](#magic-number) | anti-pattern | `magic-number` | off |');
    });
});

describe('practice checks on the code', () => {
    let all: ExtractionResult;
    let defaults: ExtractionResult;
    let dir: string;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'pflow-practices-'));
        cpSync(PRACTICES, dir, { recursive: true });
        all = await extractProject(dir, { config: { checks: { select: CATALOGUE.map(p => p.id) } } });
        defaults = await extractProject(dir, { config: {} });
    }, 120_000);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('finds empty handlers, but not one holding a comment', () => {
        const ts = byRule(all, 'empty-catch', 'src/orders.ts');
        expect(ts.map(f => f.loc!.line)).toEqual([23]);
        expect(ts[0].practice).toBe('dead-programs-tell-no-lies');
        expect(ts[0].subject).toBe('loadSettings');
        expect(ts[0].severity).toBe('warning');
        expect(byRule(all, 'empty-catch', 'py/jobs.py').map(f => f.loc!.line)).toEqual([7]);
    });

    it('finds commented-out code, with the lines it spans', () => {
        const found = byRule(all, 'commented-out-code').map(f => [f.loc!.file, f.loc!.line, f.endLine]);
        expect(found).toEqual(expect.arrayContaining([['src/orders.ts', 36, 37], ['py/jobs.py', 13, 14]]));
        // A prose comment is not code.
        expect(found).toHaveLength(2);
    });

    it('finds a chain reaching through three objects', () => {
        const [wreck] = byRule(all, 'train-wreck');
        expect(wreck.subject).toBe('shippingZone');
        expect(wreck.message).toContain('order.customer.address.country.zone()');
        expect(wreck.practice).toBe('law-of-demeter');
    });

    it('finds boolean flag parameters, not setters', () => {
        expect(byRule(all, 'flag-argument').map(f => f.subject).sort()).toEqual(['render', 'run']);
    });

    it('finds unnamed numbers, not those given a name', () => {
        const [magic] = byRule(all, 'magic-number');
        expect(magic.subject).toBe('sessionExpired');
        expect(magic.message).toContain('86400');
        expect(magic.message).not.toContain('1800000');
    });

    it('leaves out the entries the selection does not hold', () => {
        expect(byRule(defaults, 'magic-number')).toHaveLength(0);
        expect(byRule(defaults, 'train-wreck')).toHaveLength(1);
    });

    it('proposes deleting commented-out code and rethrowing from an empty handler', () => {
        const findings = all.findings.filter(f => f.rule === 'commented-out-code' || f.rule === 'empty-catch');
        const proposals = quickFixes(findings, all.facts, all.models, file => readFileSync(join(dir, file), 'utf8'));
        const ts = proposals.find(p => p.finding.rule === 'empty-catch' && p.finding.loc?.file === 'src/orders.ts');
        expect(ts?.edits[0].replace).toContain('catch (error) { throw error; }');
        const py = proposals.find(p => p.finding.rule === 'empty-catch' && p.finding.loc?.file === 'py/jobs.py');
        expect(py?.edits[0].replace).toMatch(/except ValueError:\n\s+raise/);
        const removal = proposals.find(p => p.finding.rule === 'commented-out-code' && p.finding.loc?.file === 'src/orders.ts');
        const after = read('src/orders.ts').replace(removal!.edits[0].search, removal!.edits[0].replace);
        expect(after).not.toContain('// const tax');
        expect(after).toContain('export function total(items: number[]): number {\n    return items.reduce');
    });
});

describe('practice edits', () => {
    const finding = (line: number, endLine?: number): Finding => ({ rule: 'x', category: 'practice', severity: 'info', subject: 'f', message: '', fix: '', loc: { file: 'a.ts', line }, endLine, source: 'analysis' });

    it('grows an edit by whole lines until its search text is unique', () => {
        const text = 'a\nx\nb\nx\nc\n';
        const second = text.indexOf('x', 3);
        const edit = uniqueEdit(text, second, second + 1, 'y')!;
        expect(text.replace(edit.search, edit.replace)).toBe('a\nx\nb\ny\nc\n');
    });

    it('deletes lines, and rethrows in the language of the file', () => {
        const text = 'one\n// two();\n// three();\nfour\n';
        const del = deleteLinesEdit(finding(2, 3), text)!;
        expect(text.replace(del.search, del.replace)).toBe('one\nfour\n');
        const java = 'try { run(); } catch (IOException e) {}\n';
        const fix = rethrowEdit({ ...finding(1), loc: { file: 'A.java', line: 1 } }, java)!;
        expect(java.replace(fix.search, fix.replace)).toBe('try { run(); } catch (IOException e) { throw e; }\n');
        const cs = 'try { Run(); } catch (IOException) {}\n';
        const csFix = rethrowEdit({ ...finding(1), loc: { file: 'A.cs', line: 1 } }, cs)!;
        expect(cs.replace(csFix.search, csFix.replace)).toContain('catch (IOException) { throw; }');
    });
});
