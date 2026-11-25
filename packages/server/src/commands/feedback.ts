/** `pflow feedback <owner/repo>`: the verdicts people gave in replies to ProvenFlow's review comments, as a file. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FEEDBACK_FILE, harvestFeedback, labelRows, labelsMarkdown, mergeFeedback, type ReviewFeedback } from '@provenflow/extract';
import type { Values } from './shared.js';

/** GITHUB_TOKEN or GH_TOKEN, else the GitHub CLI's token. */
function githubToken(): string | undefined {
    const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
    if (token) return token;
    const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
    return gh.status === 0 ? gh.stdout.trim() || undefined : undefined;
}

export async function feedbackCommand(values: Values, args: string[]): Promise<number> {
    const repository = args[0];
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        console.error('pflow feedback <owner/repo> [-o provenflow-feedback.json] [--max N]: give the repository whose pull requests to read.');
        return 2;
    }
    const token = githubToken();
    if (!token) {
        console.error('pflow feedback needs a GitHub token: set GITHUB_TOKEN, or log in with `gh auth login`.');
        return 2;
    }
    const output = values.output ?? FEEDBACK_FILE;
    const previous = existsSync(output) ? (JSON.parse(readFileSync(output, 'utf8')) as ReviewFeedback) : undefined;
    const harvested = await harvestFeedback(repository, token, { limit: values.max ? Number(values.max) : undefined, apiUrl: process.env['GITHUB_API_URL'] });
    const feedback = mergeFeedback(previous, harvested);
    writeFileSync(output, `${JSON.stringify(feedback, null, 2)}\n`);
    const unclear = feedback.labels.filter(l => l.verdict === 'unclear').length;
    console.log(labelsMarkdown(repository, labelRows(feedback.labels)));
    console.log(`${feedback.labels.length} answered finding(s) in ${output}${previous ? ` (${feedback.labels.length - previous.labels.length} new)` : ''}.${unclear ? ` ${unclear} reply(ies) could not be classified: set their "verdict" by hand.` : ''}`);
    return 0;
}
