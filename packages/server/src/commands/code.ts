/** `pflow extract`, `review`, `post-review`, `baseline`, `compare`, `mutate` and `init`: checking a code base. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    annotations,
    baselinePath,
    baselineReference,
    baseOverrides,
    changedLines,
    checkPayload,
    compareResults,
    compareWithReference,
    comparisonMarkdown,
    CONFIG_FILE,
    createBaseline,
    extractProject,
    findingKey,
    formatFindings,
    fromFork,
    githubTargetFromEnv,
    loadConfig,
    logged,
    mergeConfigs,
    projectReader,
    proposeConfig,
    providerFromSpec,
    publishCheckRun,
    publishReview,
    readBaseline,
    readInstructions,
    reviewComments,
    reviewSummary,
    rulesFromInstructions,
    runMutation,
    runReview,
    summary,
    writeBaseline,
    writeOutputs,
    type Baseline,
    type ExtractOptions,
    type PreviousRun,
    type ReviewPayload,
    type ReviewRun
} from '@provenflow/extract';
import { checksOf, clearProgress, failOnLevel, githubBase, nuxmvChecker, terminalProgress, type Values } from './shared.js';

/** Options of the analysis shared by the code commands. */
async function analysisOptions(values: Values, defaults: { analyzers: boolean } = { analyzers: true }): Promise<ExtractOptions & { nuxmv: boolean }> {
    const { checker, available } = await nuxmvChecker(values);
    return {
        configFile: values.config,
        checks: checksOf(values),
        checker,
        nuxmv: available,
        llm: values.llm ? logged(providerFromSpec(values.llm), line => console.error(line)) : undefined,
        llmFixes: Number(values['llm-fixes']),
        quickFixes: values.fix ? 50 : 0,
        analyzers: values['no-analyzers'] ? false : values.analyzers || defaults.analyzers,
        confirm: !values['no-confirm'],
        coverage: values.coverage,
        onProgress: values.quiet ? undefined : terminalProgress()
    };
}

export async function extractCommand(dir: string, values: Values): Promise<number> {
    const { nuxmv, ...options } = await analysisOptions(values);
    const result = await extractProject(dir, options);
    clearProgress();
    const written = writeOutputs(result, values.output ?? join(dir, '.provenflow', 'extract'));
    if (!values.quiet) console.log(formatFindings(result, 'warning'));
    result.notes.forEach(n => console.error(`note: ${n}`));
    // Only findings beyond the baseline fail.
    const baseline = values['no-baseline'] ? undefined : readBaseline(baselinePath(resolve(dir), result.config, values.baseline));
    const split = baseline ? compareWithReference(result.findings, baselineReference(baseline)) : undefined;
    const counted = split?.fresh ?? result.findings;
    const counts = summary(result);
    console.log(
        `${result.files} files, ${result.models.length} models, ${result.verdicts.length} properties (${nuxmv ? 'nuXmv' : 'explicit-state; set NUXMV_PATH for nuXmv'}): ` +
            `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} note(s). Report: ${written.report}`
    );
    if (split) console.log(`Baseline: ${split.existing.length} finding(s) accepted, ${split.fresh.length} new${split.gone.length ? `, ${split.gone.length} entr${split.gone.length === 1 ? 'y' : 'ies'} no longer occurring (pflow baseline --update tightens it)` : ''}.`);
    const failOn = failOnLevel(values);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const failing = failOn === 'none' ? [] : counted.filter(f => rank[f.severity] <= rank[failOn]);
    if (split && failing.length && !values.quiet) console.log(`New findings:\n${formatFindings({ ...result, findings: failing })}`);
    return failing.length > 0 ? 5 : 0;
}

export async function reviewCommand(dir: string, values: Values): Promise<number> {
    const { nuxmv: _nuxmv, ...options } = await analysisOptions(values);
    const run = await runReview(dir, {
        ...options,
        previous: readState(values.state),
        base: values.base ?? githubBase(),
        scope: values.files ? 'files' : 'lines',
        newOnly: values['new-only'],
        baseline: values['no-baseline'] ? false : values.baseline,
        mutate: values.mutate ? Number(values.mutate) : 0,
        mutationTest: values.test,
        failOn: failOnLevel(values)
    });
    clearProgress();
    if (values.state) writeState(values.state, run.result.previous);
    const comments = run.changed ? reviewComments(run.relevant, run.changed, projectReader(resolve(dir))) : [];
    const body = reviewSummary(run.result, run.relevant, comments.length, run.base, run.extras);
    console.log(body);
    if (run.result.incremental) console.log(`\n(Incremental: ${run.result.incremental.changed.length} file(s) changed since the last run of this pull request.)`);
    if (!values.quiet) console.log(formatFindings({ ...run.result, findings: run.relevant }, 'warning'));
    run.notes.forEach(n => console.error(`note: ${n}`));
    // In GitHub Actions, the findings also show on the Files tab of the pull request.
    if (process.env['GITHUB_ACTIONS'] === 'true') annotations(run.relevant.slice(0, 50)).forEach(line => console.log(line));
    if (values.github || values['github-out']) {
        const posted = await postToGithub(run, body, comments, values);
        if (posted !== 0) return posted;
    }
    return run.failing.length > 0 ? 5 : 0;
}

/** --state <dir>: the last run of this pull request (e.g. from the Actions cache), so a push re-analyses only what changed. */
function readState(dir: string | undefined): PreviousRun | undefined {
    const path = dir ? join(dir, 'previous.json') : undefined;
    return path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PreviousRun) : undefined;
}

function writeState(dir: string, previous: PreviousRun): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'previous.json'), JSON.stringify(previous));
}

async function postToGithub(run: ReviewRun, body: string, comments: ReviewPayload['comments'], values: Values): Promise<number> {
    const target = githubTargetFromEnv();
    if (!target) {
        console.error('--github: not in a GitHub Actions pull_request run (GITHUB_REPOSITORY and GITHUB_EVENT_PATH are needed).');
        return 1;
    }
    const payload: ReviewPayload = { repository: target.repository, pull: target.pull, commit: target.commit, summary: body, comments, keys: run.relevant.map(findingKey) };
    const out = values['github-out'] ?? (fromFork() ? 'provenflow-review.json' : undefined);
    if (out) {
        // A fork's token cannot post: a trusted workflow posts this file (pflow post-review).
        writeFileSync(out, JSON.stringify(payload));
        console.log(`Review written to ${out}, to be posted by pflow post-review.`);
        return 0;
    }
    try {
        const posted = await publishReview(target, payload);
        console.log(`Review: ${posted.posted} new comment(s), ${posted.alreadyReported} already reported, ${posted.fixed} no longer reported${posted.summaryUrl ? `. Summary: ${posted.summaryUrl}` : ''}.`);
        if (values['check-run']) {
            const url = await publishCheckRun(target, run.relevant, run.failing.length ? 'failure' : 'success', body);
            console.log(`Check run: ${url ?? 'posted'}.`);
        }
    } catch (error) {
        console.error(`warning: ${(error as Error).message}`);
    }
    return 0;
}

export async function postReviewCommand(file: string): Promise<number> {
    // Posts a review file written for a pull request from a fork, after checking it against the pull request.
    const payload = JSON.parse(readFileSync(file, 'utf8')) as ReviewPayload;
    const token = process.env['GITHUB_TOKEN'];
    const repository = process.env['GITHUB_REPOSITORY'];
    if (!token || !repository) {
        console.error('post-review: GITHUB_TOKEN and GITHUB_REPOSITORY are needed.');
        return 1;
    }
    const target = { token, repository, pull: payload.pull, commit: payload.commit, apiUrl: process.env['GITHUB_API_URL'] };
    await checkPayload(target, payload);
    const posted = await publishReview(target, payload);
    console.log(`Review: ${posted.posted} new comment(s), ${posted.alreadyReported} already reported, ${posted.fixed} no longer reported${posted.summaryUrl ? `. Summary: ${posted.summaryUrl}` : ''}.`);
    return 0;
}

/**
 * pflow baseline: accept the findings the code has today, so that only new ones fail. With --update
 * the baseline only shrinks: entries no longer found are removed (and measures lowered), none is added.
 */
export async function baselineCommand(dir: string, values: Values): Promise<number> {
    const { nuxmv: _nuxmv, ...options } = await analysisOptions(values);
    const result = await extractProject(dir, { ...options, quickFixes: 0, llmFixes: 0, confirm: false });
    clearProgress();
    const path = values.output ?? baselinePath(resolve(dir), result.config, values.baseline);
    const current = createBaseline(result.findings);
    const old = values.update ? readBaseline(path) : undefined;
    const next: Baseline = old ? tightened(old, current) : current;
    writeBaseline(path, next);
    const total = (b: Baseline) => b.entries.reduce((n, e) => n + e.count, 0);
    console.log(old ? `Baseline ${path}: ${total(old)} → ${total(next)} accepted finding(s).` : `Baseline ${path}: ${total(next)} accepted finding(s) in ${next.entries.length} entr${next.entries.length === 1 ? 'y' : 'ies'}. Commit it; only findings beyond it fail.`);
    return 0;
}

/** The old baseline, keeping only what still occurs (counts and measures can only go down). */
function tightened(old: Baseline, current: Baseline): Baseline {
    const now = new Map(current.entries.map(e => [`${e.rule}|${e.subject}|${e.file}`, e]));
    const entries = old.entries.flatMap(e => {
        const c = now.get(`${e.rule}|${e.subject}|${e.file}`);
        if (!c) return [];
        return [{ ...e, count: Math.min(e.count, c.count), ...(e.measure !== undefined && c.measure !== undefined ? { measure: Math.min(e.measure, c.measure) } : {}) }];
    });
    return { ...old, entries };
}

/** pflow compare: the quality of two versions of a code base side by side. */
export async function compareCommand(dir: string, values: Values): Promise<number> {
    if (!values.base && !values.before) throw new Error('pflow compare: give --base <git ref> or --before <folder>.');
    const { nuxmv: _nuxmv, ...options } = await analysisOptions(values, { analyzers: false });
    const common = { ...options, quickFixes: 0, llmFixes: 0, llm: undefined, confirm: false };
    const after = await extractProject(dir, common);
    // The same config (rules, limits, layers) for both versions, so that only the code differs.
    const same = { ...common, config: after.config, configFile: undefined };
    const before = values.before ? await extractProject(values.before, same) : await extractProject(dir, { ...same, overrides: baseOverrides(resolve(dir), values.base!) });
    clearProgress();
    const comparison = compareResults(before, after, { before: values.before ? 'before' : values.base!, after: 'after' });
    const text = comparisonMarkdown(comparison);
    if (values.output) writeFileSync(values.output, values.json ? JSON.stringify(comparison, null, 2) : text);
    console.log(values.json && !values.output ? JSON.stringify(comparison, null, 2) : text);
    return 0;
}

/** pflow mutate: do the tests notice when a changed line is altered? */
export async function mutateCommand(dir: string, values: Values): Promise<number> {
    const root = resolve(dir);
    const config = loadConfig(root, values.config);
    const changed = changedLines(root, values.base ?? githubBase() ?? 'HEAD');
    if (changed.size === 0) {
        console.log('No changed lines (compare with an older revision: --base <ref>).');
        return 0;
    }
    const files = [...changed.keys()];
    const run = await runMutation(root, files, changed, config, {
        max: values.max ? Number(values.max) : undefined,
        test: values.test,
        onMutant: (m, i, n) => !values.quiet && console.error(`mutant ${i + 1}/${n}: ${m.file}:${m.line} ${m.operator}`)
    });
    run.notes.forEach(n => console.error(`note: ${n}`));
    for (const m of run.mutants) console.log(`${m.killed ? 'killed  ' : 'SURVIVED'} ${m.file}:${m.line} ${m.operator}: ${m.after.trim()}`);
    if (run.mutants.length) console.log(`\n${run.mutants.filter(m => m.killed).length} of ${run.mutants.length} mutants caught by the tests (${run.score}%), with ${run.tests.join(', ')}.`);
    const failOn = failOnLevel(values);
    return failOn !== 'none' && failOn !== 'error' && run.findings.length ? 5 : 0;
}

/**
 * pflow init: a provenflow.config.json proposed from the code (language standards, layers, patterns,
 * coverage reports), and with --instructions --llm, the checkable rules of AGENTS.md / CLAUDE.md...
 */
export async function initCommand(dir: string, values: Values): Promise<number> {
    const root = resolve(dir);
    const path = values.output ?? join(root, CONFIG_FILE);
    const existing = loadConfig(root, values.config);
    const { nuxmv: _nuxmv, ...options } = await analysisOptions(values, { analyzers: false });
    const result = await extractProject(root, { ...options, config: existing, quickFixes: 0, llmFixes: 0, llm: undefined, confirm: false, analyzers: false });
    clearProgress();
    const proposed = proposeConfig(result, existing);
    let config = proposed.config;
    if (values.instructions) {
        const files = readInstructions(root, values.base);
        if (!values.llm) console.error(`note: ${files.length} instruction file(s) found (${files.map(f => f.file).join(', ') || 'none'}); give --llm <provider:model> to turn their checkable rules into config.`);
        else if (files.length) {
            const rules = await rulesFromInstructions(files, providerFromSpec(values.llm));
            config = { ...config, ...mergeConfigs([config, rules.config]) };
            for (const k of rules.kept) proposed.evidence.push(`from ${k.file ?? 'instructions'}: "${k.statement}" → ${JSON.stringify(k.config)}`);
            for (const r of rules.rejected) console.error(`not kept: "${r.statement}": ${r.reason}`);
        }
    }
    console.log('Proposed from the code:');
    for (const e of proposed.evidence) console.log(`- ${e}`);
    const text = `${JSON.stringify(config, null, 2)}\n`;
    if (existsSync(path) && !values.force && !values.output) {
        console.log(`\n${CONFIG_FILE} exists: not overwritten (use --force, or -o another file). Proposed config:\n${text}`);
        return 0;
    }
    writeFileSync(path, text);
    console.log(`\nWrote ${path}. Review it, then run pflow baseline to accept today's findings.`);
    return 0;
}
