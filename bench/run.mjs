#!/usr/bin/env node
/**
 * Measures the analysis against the review verdicts in bench/labels/: each labelled repository is
 * cloned at the revision its labels were checked against (into .provenflow/bench/), its dependencies
 * installed without running their scripts (the type checker needs them), and `pflow bench --labels`
 * reports how many findings people answered as false positives are still reported.
 *
 *   npm run build && node bench/run.mjs [--fail]   (--fail: exit 5 if any is still reported)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const labelsDir = join(root, 'bench', 'labels');
const work = join(root, '.provenflow', 'bench');
const cli = join(root, 'packages', 'server', 'out', 'cli.js');
const fail = process.argv.includes('--fail');

function run(command, args, cwd) {
    const r = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${r.status ?? r.signal})`);
}

/** The repository at the labels' revision, with its dependencies. */
function checkout(feedback) {
    const dir = join(work, feedback.repository.split('/').pop());
    if (!existsSync(dir)) {
        mkdirSync(work, { recursive: true });
        run('git', ['clone', '--quiet', '--filter=blob:none', `https://github.com/${feedback.repository}.git`, dir], root);
    }
    run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', feedback.commit], dir);
    if (existsSync(join(dir, 'package-lock.json')) && !existsSync(join(dir, 'node_modules'))) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], dir);
    return dir;
}

if (!existsSync(cli)) {
    console.error('Build first: npm run build');
    process.exit(2);
}
let code = 0;
for (const file of readdirSync(labelsDir).filter(f => f.endsWith('.json'))) {
    const path = join(labelsDir, file);
    const feedback = JSON.parse(readFileSync(path, 'utf8'));
    const dir = checkout(feedback);
    const r = spawnSync(process.execPath, [cli, 'bench', dir, '--labels', path, '--no-analyzers', '--no-confirm', '-q', ...(fail ? ['--fail-on-labels'] : [])], { stdio: 'inherit' });
    code = Math.max(code, r.status ?? 1);
}
process.exit(code);
