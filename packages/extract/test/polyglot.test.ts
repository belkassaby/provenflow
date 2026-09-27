import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractProject, type ExtractionResult } from '../src/index.js';

const POLYGLOT = fileURLToPath(new URL('./fixtures/polyglot', import.meta.url));

let cached: ExtractionResult | undefined;
async function polyglot(): Promise<ExtractionResult> {
    cached ??= await extractProject(POLYGLOT, { analyzers: false, config: {} });
    return cached;
}

/** The same job lifecycle in every language: which file, and how its values are spelled. */
const LANGUAGES: Array<[string, string, [string, string, string, string, string]]> = [
    ['Java', 'java/src/main/java/app/Job.java', ['IDLE', 'RUNNING', 'DONE', 'FAILED', 'RETRYING']],
    ['Kotlin', 'kotlin/Job.kt', ['IDLE', 'RUNNING', 'DONE', 'FAILED', 'RETRYING']],
    ['Groovy', 'groovy/Job.groovy', ['IDLE', 'RUNNING', 'DONE', 'FAILED', 'RETRYING']],
    ['Scala', 'scala/Job.scala', ['Idle', 'Running', 'Done', 'Failed', 'Retrying']],
    ['C', 'c/job.c', ['IDLE', 'RUNNING', 'DONE', 'FAILED', 'RETRYING']],
    ['C++', 'cpp/job.cpp', ['Idle', 'Running', 'Done', 'Failed', 'Retrying']],
    ['C#', 'csharp/Job.cs', ['Idle', 'Running', 'Done', 'Failed', 'Retrying']],
    ['Go', 'go/job.go', ['Idle', 'Running', 'Done', 'Failed', 'Retrying']],
    ['Rust', 'rust/src/lib.rs', ['Idle', 'Running', 'Done', 'Failed', 'Retrying']],
    ['Swift', 'swift/Job.swift', ['idle', 'running', 'done', 'failed', 'retrying']],
    ['Ruby', 'ruby/job.rb', ['queued', 'running', 'done', 'failed', 'retrying']],
    ['PHP', 'php/Job.php', ['Idle', 'Running', 'Done', 'Failed', 'Retrying']],
    ['R', 'r/job.R', ['queued', 'running', 'done', 'failed', 'retrying']]
];

describe('state machines in every language', () => {
    for (const [language, file, [idle, running, done, failed, retrying]] of LANGUAGES) {
        it(`${language}: guarded transitions, initial state and the value never set`, async () => {
            const r = await polyglot();
            const m = r.models.find(x => x.kind === 'state-machine' && x.loc?.file === file)!;
            expect(m, `no machine for ${file}`).toBeDefined();
            const id = (value: string) => Object.entries(m.values).find(([, v]) => v === value)?.[0] ?? value;
            const edges = m.model.transitions.map(t => `${m.values[t.source] ?? t.source}->${m.values[t.target] ?? t.target}`);
            // start(): only from the initial state; finish(): only while running; fail(): from anywhere.
            expect(edges).toEqual(expect.arrayContaining([`${idle}->${running}`, `${running}->${done}`, `${idle}->${failed}`, `${done}->${failed}`]));
            expect(edges).not.toContain(`${done}->${running}`);
            expect(edges).not.toContain(`${idle}->${done}`);
            expect(m.model.states.find(s => s.name === id(idle))?.initial).toBe(true);
            const unreachable = r.findings.find(f => f.rule === 'unreachable-state' && f.model === m.id);
            expect(unreachable?.message, `${language}: ${retrying} should be reported`).toContain(`'${retrying}'`);
        });
    }

    it('reports switches that forget states (C, C++, C#, Go, Groovy, Java, R, Ruby)', async () => {
        const r = await polyglot();
        const files = r.findings.filter(f => f.rule === 'unhandled-state').map(f => f.loc!.file.split('/')[0]);
        expect(files.sort()).toEqual(['c', 'cpp', 'csharp', 'go', 'groovy', 'java', 'r', 'ruby']);
    });

    it('tells a Ruby/R value compared but never set from one never mentioned', async () => {
        const r = await polyglot();
        const ruby = r.findings.find(f => f.rule === 'unreachable-state' && f.loc?.file === 'ruby/job.rb')!;
        expect(ruby.message).toContain("compared with 'retrying'");
    });
});

describe('resources in other languages', () => {
    it('finds releases skipped by exceptions (Java, R) and by early returns (C, Go)', async () => {
        const r = await polyglot();
        const leaks = r.findings.filter(f => f.rule === 'release-not-guaranteed').map(f => f.loc!.file);
        expect(leaks.sort()).toEqual(['c/job.c', 'go/job.go', 'java/src/main/java/app/Job.java', 'r/job.R']);
    });

    it('models a C# timer held in a field without dispose', async () => {
        const r = await polyglot();
        const leak = r.findings.find(f => f.rule === 'resource-leak' && f.loc?.file === 'csharp/Job.cs');
        expect(leak?.counterexample?.map(s => s.state)).toEqual(expect.arrayContaining(['held', 'leaked']));
    });
});

describe('patterns and structure in other languages', () => {
    it('recognises language-level and classic singletons', async () => {
        const r = await polyglot();
        const singletons = r.patterns.filter(p => p.pattern === 'singleton').map(p => p.loc.file);
        expect(singletons.sort()).toEqual(['java/src/main/java/app/Registry.java', 'kotlin/Job.kt']);
    });

    it('records classes, functions and modules for every language', async () => {
        const r = await polyglot();
        const languages = new Set(r.facts.classes.map(c => c.language));
        for (const l of ['java', 'kotlin', 'groovy', 'scala', 'cpp', 'c_sharp', 'go', 'rust', 'swift', 'ruby', 'php', 'r']) expect(languages, l).toContain(l);
        expect(r.facts.functions.some(f => f.name === 'job_process' && f.free)).toBe(true);
        expect(r.facts.modules.find(m => m.file === 'c/job.c')?.imports.find(i => i.specifier === 'job.h')?.resolved).toBe('c/job.h');
        expect(r.facts.modules.find(m => m.file === 'c/job.c')?.mutableGlobals.map(g => g.name)).toContain('state');
    });
});
