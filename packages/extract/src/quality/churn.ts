/**
 * Hotspots: complex code that changes often. How often a file changed comes from git (commits that
 * touched it in the last months); complex code nobody touches costs little, complex code changed every
 * week is where bugs and slow reviews come from, so it is what to simplify first.
 */
import { spawnSync } from 'node:child_process';

/** How many months of history count, by default. */
export const DEFAULT_CHURN_MONTHS = 12;
const MAX_LOG_BYTES = 256 * 1024 * 1024;

export interface Churn {
    months: number;
    /** Commits in the period. */
    commits: number;
    /** Commits that touched each file (paths relative to the analysed folder). */
    changes: Map<string, number>;
}

/** The commits of the last `months` per file, or nothing when the folder is not in a git repository. */
export function readChurn(root: string, months = DEFAULT_CHURN_MONTHS): Churn | undefined {
    const r = spawnSync('git', ['log', `--since=${months}.months`, '--no-merges', '--name-only', '--relative', '--format=%x1e'], { cwd: root, encoding: 'utf8', maxBuffer: MAX_LOG_BYTES });
    if (r.status !== 0 || r.error) return undefined;
    const commits = r.stdout.split('\x1e').slice(1);
    const changes = new Map<string, number>();
    for (const commit of commits) {
        for (const file of new Set(commit.split('\n').filter(Boolean))) changes.set(file, (changes.get(file) ?? 0) + 1);
    }
    return { months, commits: commits.length, changes };
}
