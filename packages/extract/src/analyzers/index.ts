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

export async function runAnalyzers(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const all = emptyOutput();
    const results = await Promise.all([semgrep(ctx), infer(ctx), bmc(ctx), kani(ctx), codeql(ctx), importSarif(ctx)]);
    for (const r of results) {
        all.findings.push(...r.findings);
        all.proofs.push(...r.proofs);
        all.fixes.push(...r.fixes);
        all.notes.push(...r.notes);
        all.ran.push(...r.ran);
    }
    return all;
}
