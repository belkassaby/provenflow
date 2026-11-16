/**
 * `pflow fix-pr` and `pflow review --fix-pr`: every verified fix of a run as one pull request. On a
 * pull request, the fixes are proposed to its branch (on top of its head, not of the merge commit the
 * checkout made); otherwise to the branch checked out.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { combineVerifiedFixes, commitFiles, fixPullRequestBody, fromFork, openFixPullRequest, pushCommit, readerAt, type Finding } from '@provenflow/extract';
import type { Values } from './shared.js';

/** Where the fixes go: the branch and commit they are made on, and the pull request they are for. */
interface FixTarget {
    base: string;
    parent: string;
    about: string;
    branch: string;
}

function targetOf(root: string, env: NodeJS.ProcessEnv): FixTarget {
    const event = readEvent(env);
    const pr = event?.pull_request;
    if (pr?.head?.ref && pr.head.sha) return { base: pr.head.ref, parent: pr.head.sha, about: `pull request #${pr.number}`, branch: `provenflow/fixes-pr-${pr.number}` };
    const current = env['GITHUB_REF_NAME'] ?? git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return { base: current, parent: 'HEAD', about: current, branch: `provenflow/fixes-${current.replace(/[^\w.-]/g, '-')}` };
}

function readEvent(env: NodeJS.ProcessEnv): { pull_request?: { number: number; head?: { ref?: string; sha?: string } } } | undefined {
    const path = env['GITHUB_EVENT_PATH'];
    if (!path || !existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

function git(root: string, args: string[]): string {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
}

/** Commits the verified fixes of `findings` on a branch, pushes it and opens (or updates) its pull request. */
export async function proposeFixes(dir: string, findings: Finding[], values: Values, env: NodeJS.ProcessEnv = process.env): Promise<number> {
    const root = resolve(dir);
    const target = targetOf(root, env);
    const combined = combineVerifiedFixes(findings, readerAt(root, target.parent));
    combined.skipped.forEach(s => console.error(`not in the fixes: ${s.finding.rule} ${s.finding.subject}: ${s.reason}`));
    if (!combined.applied.length) {
        console.log('No verified fix to propose (run with --fix, and --llm for LLM fixes).');
        return 0;
    }
    const body = fixPullRequestBody(combined, target.about);
    const title = `ProvenFlow: ${combined.applied.length} verified fix${combined.applied.length > 1 ? 'es' : ''} for ${target.about}`;
    const commit = commitFiles(root, combined.files, `${title}\n\n${body}`, target.parent, env);
    const branch = values.branch ?? target.branch;
    if (values['dry-run']) {
        console.log(`${title}: commit ${commit.slice(0, 12)} (${[...combined.files.keys()].join(', ')}), not pushed (--dry-run).\n\n${body}`);
        return 0;
    }
    if (fromFork(env)) {
        console.error('fix-pr: a pull request from a fork cannot receive pushes from this run; the fixes are in the review as suggestions.');
        return 0;
    }
    pushCommit(root, commit, branch);
    const [token, repository] = [env['GITHUB_TOKEN'], env['GITHUB_REPOSITORY']];
    if (!token || !repository) {
        console.log(`Pushed ${combined.applied.length} fix(es) to ${branch}: open a pull request from it into ${target.base} (GITHUB_TOKEN and GITHUB_REPOSITORY open it for you).`);
        return 0;
    }
    const url = await openFixPullRequest({ token, apiUrl: env['GITHUB_API_URL'] }, { repository, branch, base: target.base, title, body });
    console.log(`Fixes: ${url}`);
    return 0;
}
