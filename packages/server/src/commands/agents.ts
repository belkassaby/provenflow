/**
 * `pflow hook <event>`: ProvenFlow in a coding agent's loop (Claude Code hooks). The hook reads the
 * event (JSON) on stdin and answers with exit code 2 and the findings on stderr, which Claude Code
 * passes back to the model, so the agent fixes them before going on:
 *
 * - `post-edit` (PostToolUse on Edit|Write|MultiEdit): the findings on the uncommitted lines of the
 *   file just edited — duplicated code, complexity, naming, dependencies, layers, state machines;
 * - `stop` (Stop): before the agent says it is done, the errors and warnings of all uncommitted
 *   changes; it may stop only when there are none (or once it was already told: stop_hook_active).
 *
 * Analysers and replays are left out for speed; the state of the last run is kept in
 * .provenflow/state so that each hook re-analyses only what changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { formatFindings, runReview, type PreviousRun, type ReviewRun } from '@provenflow/extract';

interface HookEvent {
    cwd?: string;
    stop_hook_active?: boolean;
    tool_input?: { file_path?: string; path?: string };
}

async function readEvent(): Promise<HookEvent> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as HookEvent;
    } catch {
        return {};
    }
}

/** The project root: the nearest folder with provenflow.config.json, or a .git, from `start` up. */
function projectRoot(start: string): string {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, 'provenflow.config.json')) || existsSync(join(dir, '.git'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start);
        dir = parent;
    }
}

async function review(root: string, scope: 'lines' | 'files'): Promise<ReviewRun> {
    const statePath = join(root, '.provenflow', 'state', 'hook.json');
    const previous = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as PreviousRun) : undefined;
    const run = await runReview(root, { base: 'HEAD', scope, analyzers: false, confirm: false, quickFixes: 0, llmFixes: 0, previous, failOn: 'warning' });
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(run.result.previous));
    return run;
}

export async function hookCommand(event: string): Promise<number> {
    const input = await readEvent();
    const root = projectRoot(input.cwd ?? process.cwd());
    if (event === 'post-edit') {
        const edited = input.tool_input?.file_path ?? input.tool_input?.path;
        const run = await review(root, 'lines');
        const file = edited ? relative(root, resolve(root, edited)) : undefined;
        const mine = run.failing.filter(f => !file || f.loc?.file === file);
        if (mine.length === 0) return 0;
        console.error(`ProvenFlow found ${mine.length} problem(s) in the code just written${file ? ` (${file})` : ''}; fix them before going on:\n\n${formatFindings({ ...run.result, findings: mine })}`);
        return 2;
    }
    if (event === 'stop') {
        if (input.stop_hook_active) return 0; // already sent back once: do not loop
        const run = await review(root, 'lines');
        if (run.failing.length === 0) return 0;
        console.error(`ProvenFlow: the uncommitted changes still have ${run.failing.length} error(s) or warning(s). Fix them (or explain why not) before finishing:\n\n${formatFindings({ ...run.result, findings: run.failing })}`);
        return 2;
    }
    console.error(`Unknown hook event '${event}': use post-edit or stop.`);
    return 1;
}
