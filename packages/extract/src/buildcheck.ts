/**
 * Build, type check and tests of a proposed change: they run on a temporary copy of the project with
 * the change applied, after running once on the project as it is (a check that already fails is
 * reported, not held against the change). A change is verified only if the analysis re-run removes
 * the finding without adding one AND these checks pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvenflowConfig } from './config.js';
import { findTool, run, tail } from './tools/process.js';
import { materialize } from './tools/workspace.js';

export interface CheckCommand {
    name: string;
    /** Shell command; `{files}` is replaced by the changed files. */
    command: string;
}

export interface CheckResult {
    name: string;
    command: string;
    ok: boolean;
    output: string;
    ms: number;
}

/** The build/type-check and test commands of a project (from the config, or detected). */
export function detectChecks(root: string, files: string[], config: ProvenflowConfig, env: NodeJS.ProcessEnv = process.env): { build: CheckCommand[]; test: CheckCommand[] } {
    const v = config.verification ?? {};
    const pkg = readJson(join(root, 'package.json')) as { scripts?: Record<string, string> } | undefined;
    const has = (ext: RegExp) => files.some(f => ext.test(f));
    const build: CheckCommand[] = [];
    if (v.build !== undefined) {
        if (v.build.trim()) build.push({ name: 'build', command: v.build });
    } else {
        if (has(/\.(ts|tsx|mts|cts)$/)) {
            if (pkg?.scripts?.['typecheck']) build.push({ name: 'type check', command: 'npm run typecheck --silent' });
            else if (existsSync(join(root, 'tsconfig.json'))) build.push({ name: 'type check', command: 'npx --no-install tsc --noEmit -p tsconfig.json' });
        }
        if (has(/\.py$/)) build.push({ name: 'Python compile', command: 'python3 -m py_compile {files.py}' });
        if (has(/\.go$/) && existsSync(join(root, 'go.mod')) && findTool('go', env)) build.push({ name: 'go build', command: 'go build ./...' });
        if (has(/\.rs$/) && existsSync(join(root, 'Cargo.toml')) && findTool('cargo', env)) build.push({ name: 'cargo check', command: 'cargo check --quiet' });
        if (has(/\.(java|kt)$/) && existsSync(join(root, 'pom.xml')) && findTool('mvn', env)) build.push({ name: 'mvn compile', command: 'mvn -q -o compile' });
        if (has(/\.(java|kt|groovy)$/) && existsSync(join(root, 'gradlew'))) build.push({ name: 'gradle compile', command: './gradlew -q compileJava' });
        if (has(/\.cs$/) && findTool('dotnet', env) && files.some(f => /\.(csproj|sln)$/.test(f) || existsSync(join(root, f.replace(/[^/]+$/, ''))))) {
            // only when a project file exists at the root
            if (files.some(f => /\.csproj$/.test(f))) build.push({ name: 'dotnet build', command: 'dotnet build -nologo -v q' });
        }
        if (has(/\.c$/)) build.push({ name: 'C syntax', command: 'clang -fsyntax-only {files.c}' });
        if (has(/\.(cc|cpp|cxx)$/)) build.push({ name: 'C++ syntax', command: 'clang++ -std=c++17 -fsyntax-only {files.cpp}' });
    }
    const test: CheckCommand[] = [];
    if (v.test && v.test !== 'auto') test.push({ name: 'tests', command: v.test });
    else if (v.test === 'auto') {
        if (pkg?.scripts?.['test'] && !/no test specified/.test(pkg.scripts['test'])) test.push({ name: 'npm test', command: 'npm test --silent' });
        if (has(/\.py$/) && findTool('pytest', env) && files.some(f => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f))) test.push({ name: 'pytest', command: 'pytest -q' });
        if (has(/\.go$/) && existsSync(join(root, 'go.mod')) && findTool('go', env)) test.push({ name: 'go test', command: 'go test ./...' });
        if (has(/\.rs$/) && existsSync(join(root, 'Cargo.toml')) && findTool('cargo', env)) test.push({ name: 'cargo test', command: 'cargo test --quiet' });
        if (existsSync(join(root, 'pom.xml')) && findTool('mvn', env)) test.push({ name: 'mvn test', command: 'mvn -q -o test' });
    }
    return { build, test };
}

/** Runs the checks in a folder; `{files}`, `{files.py}`, `{files.c}`, `{files.cpp}` become the changed files of that kind. */
export async function runChecks(dir: string, checks: CheckCommand[], changed: string[], timeoutSec = 300): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const c of checks) {
        const pick = (re: RegExp) => changed.filter(f => re.test(f)).map(quote).join(' ');
        const command = c.command
            .replace('{files.py}', pick(/\.py$/))
            .replace('{files.c}', pick(/\.c$/))
            .replace('{files.cpp}', pick(/\.(cc|cpp|cxx)$/))
            .replace('{files}', changed.map(quote).join(' '));
        if (/\{files[^}]*\}/.test(c.command) && command.trim().split(/\s+/).length <= c.command.replace(/\{files[^}]*\}/, '').trim().split(/\s+/).length) continue; // nothing of that kind changed
        const r = await run('sh', ['-c', command], { cwd: dir, timeoutMs: timeoutSec * 1000, env: { CI: '1', FORCE_COLOR: '0' } });
        results.push({ name: c.name, command, ok: r.code === 0 && !r.timedOut, output: tail(`${r.stdout}\n${r.stderr}`, 25), ms: r.ms });
    }
    return results;
}

/**
 * Checks for proposed changes: the baseline runs once (on the project as it is), then each change
 * runs on a temporary copy. Checks failing on the baseline (for the same files) are ignored for the changes.
 */
export class ChangeChecker {
    private readonly baselines = new Map<string, Promise<CheckResult[]>>();

    constructor(
        private readonly root: string,
        private readonly checks: CheckCommand[],
        private readonly timeoutSec = 300
    ) {}

    get enabled(): boolean {
        return this.checks.length > 0;
    }

    async check(overrides: Map<string, string>): Promise<{ ok: boolean; results: CheckResult[]; ignored: string[] }> {
        if (!this.enabled) return { ok: true, results: [], ignored: [] };
        const changed = [...overrides.keys()].sort();
        // Per-file checks (py_compile, clang) depend on the files; project-wide ones do not.
        const key = this.checks.some(c => c.command.includes('{files')) ? changed.join('\n') : '';
        if (!this.baselines.has(key)) this.baselines.set(key, runChecks(this.root, this.checks, changed.filter(f => existsSync(join(this.root, f))), this.timeoutSec).catch(() => []));
        const baseline = await this.baselines.get(key)!;
        const broken = new Set(baseline.filter(r => !r.ok).map(r => r.name));
        const ws = materialize(this.root, overrides);
        try {
            const results = await runChecks(ws.dir, this.checks.filter(c => !broken.has(c.name)), changed, this.timeoutSec);
            return { ok: results.every(r => r.ok), results, ignored: [...broken] };
        } finally {
            ws.dispose();
        }
    }
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

function quote(file: string): string {
    return `'${file.replace(/'/g, "'\\''")}'`;
}
