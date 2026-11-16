import { combine, editsByFile } from './code-edits';
import type { CodeFinding } from './code-import';

const BEFORE = 'function total(items) {\n    // const tax = 0.2;\n    try { run(); } catch {}\n    return sum(items);\n}\n';

function finding(rule: string, line: number, patch?: { search: string; replace: string }): CodeFinding {
    return {
        rule,
        category: 'practice',
        severity: 'info',
        subject: 'total',
        message: '',
        fix: '',
        loc: { file: 'src/total.ts', line },
        source: 'analysis',
        practice: rule,
        suggestedPatch: patch ? { diff: '', verified: true, note: '', files: [{ file: 'src/total.ts', before: BEFORE, after: BEFORE.replace(patch.search, patch.replace) }], edits: [{ file: 'src/total.ts', ...patch }] } : undefined
    };
}

describe('edits by file', () => {
    const removal = finding('commented-out-code', 2, { search: '    // const tax = 0.2;\n', replace: '' });
    const rethrow = finding('empty-catch', 3, { search: 'catch {}', replace: 'catch (error) { throw error; }' });
    const pending = finding('magic-number', 4);

    it('groups the changes and the findings without one by file', () => {
        const [file] = editsByFile([removal, rethrow, pending]);
        expect(file.file).toBe('src/total.ts');
        expect(file.before).toBe(BEFORE);
        expect(file.changes.map(c => c.finding.rule)).toEqual(['commented-out-code', 'empty-catch']);
        expect(file.pending.map(f => f.rule)).toEqual(['magic-number']);
    });

    it('combines the changes of a file into one version', () => {
        const [file] = editsByFile([removal, rethrow]);
        const { after, applied, conflicts } = combine(file.before, file.changes);
        expect(after).toBe('function total(items) {\n    try { run(); } catch (error) { throw error; }\n    return sum(items);\n}\n');
        expect(applied).toHaveLength(2);
        expect(conflicts).toHaveLength(0);
    });

    it('leaves out a change whose text an earlier one changed', () => {
        const other = finding('dry', 3, { search: '    try { run(); } catch {}\n', replace: '    safely(run);\n' });
        const [file] = editsByFile([rethrow, other]);
        const { after, conflicts } = combine(file.before, file.changes);
        expect(after).toContain('throw error');
        expect(conflicts.map(c => c.finding.rule)).toEqual(['dry']);
    });
});
