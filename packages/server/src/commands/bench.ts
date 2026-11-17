/** `pflow bench`: how often the counterexamples of one or more code bases are real, replaying every one on the code. */
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { extractProject, precisionMarkdown, precisionOf, type PrecisionProject } from '@provenflow/extract';
import { analysisOptions } from './code.js';
import { clearProgress, type Values } from './shared.js';

export async function benchCommand(values: Values, dirs: string[]): Promise<number> {
    if (!dirs.length) {
        console.error('pflow bench <dir> [more dirs...]: give the code bases to measure.');
        return 2;
    }
    const { nuxmv: _nuxmv, ...options } = await analysisOptions(values);
    const projects: PrecisionProject[] = [];
    for (const dir of dirs) {
        const result = await extractProject(dir, { ...options, confirm: true, replayLimit: Number.POSITIVE_INFINITY, quickFixes: 0, llmFixes: 0 });
        clearProgress();
        projects.push({ name: basename(resolve(dir)), files: result.files, rows: precisionOf(result.findings) });
    }
    const text = values.json ? `${JSON.stringify(projects, null, 2)}\n` : precisionMarkdown(projects);
    if (values.output) writeFileSync(values.output, text);
    else process.stdout.write(text);
    return 0;
}
