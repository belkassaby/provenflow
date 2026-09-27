/** Runs the external analysers that apply to the project and are installed. */
import { bmc, kani } from './bmc.js';
import { codeql } from './codeql.js';
import { infer } from './infer.js';
import { importSarif } from './sarif.js';
import { semgrep } from './semgrep.js';
import { emptyOutput, type AnalyzerContext, type AnalyzerOutput } from './types.js';

export type { AnalyzerContext, AnalyzerOutput, ToolFix, ToolRun } from './types.js';
export { confirmUnreachableInC, parseCbmcJson, parseEsbmc, parseKani } from './bmc.js';
export { sarifToFindings } from './sarif.js';
export { BUNDLED_RULES } from './semgrep.js';

/** `onFinished` is told each time an analyser ends, with the ones still running. */
export async function runAnalyzers(ctx: AnalyzerContext, onFinished?: (name: string, running: string[], output: AnalyzerOutput) => void): Promise<AnalyzerOutput> {
    const all = emptyOutput();
    const running = new Set(['Semgrep', 'Infer', 'ESBMC/CBMC', 'Kani', 'CodeQL', 'SARIF import']);
    const track = (name: string, work: Promise<AnalyzerOutput>) =>
        work.then(output => {
            running.delete(name);
            onFinished?.(name, [...running], output);
            return output;
        });
    const results = await Promise.all([track('Semgrep', semgrep(ctx)), track('Infer', infer(ctx)), track('ESBMC/CBMC', bmc(ctx)), track('Kani', kani(ctx)), track('CodeQL', codeql(ctx)), track('SARIF import', importSarif(ctx))]);
    for (const r of results) {
        all.findings.push(...r.findings);
        all.proofs.push(...r.proofs);
        all.fixes.push(...r.fixes);
        all.notes.push(...r.notes);
        all.ran.push(...r.ran);
    }
    return all;
}
