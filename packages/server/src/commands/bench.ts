/**
 * `pflow bench`: how often the counterexamples of one or more code bases are real, replaying every
 * one on the code; with `--labels`, how many findings people answered as false positives are still
 * reported.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { extractProject, labelRows, labelsMarkdown, precisionMarkdown, precisionOf, type LabelRow, type PrecisionProject, type ReviewFeedback } from '@provenflow/extract';
import { analysisOptions } from './code.js';
import { clearProgress, type Values } from './shared.js';

/** The labels of a code base: the file whose repository has the directory's name, or the only file for the only directory. */
function labelsFor(dir: string, files: ReviewFeedback[], dirs: number): ReviewFeedback | undefined {
    const name = basename(resolve(dir));
    return files.find(f => f.repository.split('/').pop() === name) ?? (dirs === 1 && files.length === 1 ? files[0] : undefined);
}

export async function benchCommand(values: Values, dirs: string[]): Promise<number> {
    if (!dirs.length) {
        console.error('pflow bench <dir> [more dirs...] [--labels feedback.json]...: give the code bases to measure.');
        return 2;
    }
    const { nuxmv: _nuxmv, ...options } = await analysisOptions(values);
    const feedback = (values.labels ?? []).map(file => JSON.parse(readFileSync(file, 'utf8')) as ReviewFeedback);
    const projects: PrecisionProject[] = [];
    const answered: { name: string; revision: string; rows: LabelRow[] }[] = [];
    for (const dir of dirs) {
        const result = await extractProject(dir, { ...options, confirm: !values['no-confirm'], replayLimit: Number.POSITIVE_INFINITY, quickFixes: 0, llmFixes: 0 });
        clearProgress();
        projects.push({ name: basename(resolve(dir)), files: result.files, rows: precisionOf(result.findings) });
        const labels = labelsFor(dir, feedback, dirs.length);
        if (labels) answered.push({ name: labels.repository, revision: labels.commit ? labels.commit.slice(0, 7) : 'the analysed revision', rows: labelRows(labels.labels, result.findings) });
    }
    const text = values.json ? `${JSON.stringify(answered.length ? { projects, answered } : projects, null, 2)}\n` : [precisionMarkdown(projects), ...answered.map(a => labelsMarkdown(a.name, a.rows, { revision: a.revision }))].join('\n');
    if (values.output) writeFileSync(values.output, text);
    else process.stdout.write(text);
    const still = answered.flatMap(a => a.rows).reduce((n, r) => n + r.stillReported, 0);
    return values['fail-on-labels'] && still > 0 ? 5 : 0;
}
