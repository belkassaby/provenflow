import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseC4Dsl, viewContents } from '@provenflow/language';
import { extractProject, mapProjects, modelDrift, projectMapMarkdown } from '../src/index.js';
import { remoteOwner } from '../src/c4/discover.js';
import { pep508 } from '../src/c4/manifests.js';
import { minimum, satisfies } from '../src/c4/semver.js';
import { pythonImports, tsImports } from '../src/c4/sources.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'c4');

describe('versions and names', () => {
    it('checks npm, Python and Poetry ranges', () => {
        expect(satisfies('0.13.0', '^0.10.0')).toBe(false);
        expect(satisfies('0.10.4', '^0.10.0')).toBe(true);
        expect(satisfies('1.4.2', '~1.4.0')).toBe(true);
        expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
        expect(satisfies('1.5.0', '>=1.2,<2')).toBe(true);
        expect(satisfies('1.3.9', '~=1.2')).toBe(true);
        expect(satisfies('2.1.0', '~=1.2')).toBe(false);
        expect(satisfies('1.2.7', '==1.2.*')).toBe(true);
        expect(satisfies('3.0.0', '^2 || ^3')).toBe(true);
        expect(satisfies('1.0.0', 'file:../lib')).toBeUndefined();
        expect(satisfies('1.0.0', 'workspace:*')).toBeUndefined();
        expect(minimum('^1.26.0')).toBe('1.26.0');
    });

    it('reads owners from remotes, URLs and npm shorthands', () => {
        expect(remoteOwner('git@github.com:TheOrg/repo.git')).toBe('github.com/theorg');
        expect(remoteOwner('git+https://github.com/TheOrg/repo.git')).toBe('github.com/theorg');
        expect(remoteOwner('github:acme/render')).toBe('github.com/acme');
        expect(remoteOwner('acme/render')).toBe('github.com/acme');
    });

    it('reads imports and requirement specifiers', () => {
        const ts = tsImports("import { A, type B, C as D } from '@s/lib/sub';\nimport X, * as Y from 'pkg';\nexport * from './local';\nconst z = await import('lazy');\n");
        expect(ts.map(i => [i.spec, i.names, i.line, i.relative])).toEqual([
            ['@s/lib/sub', ['A', 'B', 'C'], 1, false],
            ['pkg', ['*'], 2, false],
            ['./local', ['*'], 3, true],
            ['lazy', ['*'], 4, false]
        ]);
        const py = pythonImports('from acme_core.io import (read,\n    write as w)\nimport numpy as np, os\nfrom . import sibling\n');
        expect(py.map(i => [i.spec, i.names])).toEqual([
            ['acme_core.io', ['read', 'write']],
            ['.', ['sibling']],
            ['numpy', ['*']],
            ['os', ['*']]
        ]);
        expect(pep508('requests[socks]>=2.0; python_version<"3.9"', 'runtime')).toEqual({ name: 'requests', range: '>=2.0', kind: 'runtime' });
    });
});

describe('the projects around a code base', () => {
    const map = mapProjects(join(FIXTURE, 'app'));
    const name = (id: string) => map.projects.find(p => p.id === id)?.name;
    const kinds = (kind: string) => map.suggestions.filter(s => s.kind === kind);

    it('finds the projects with the same owner, and leaves out the others', () => {
        expect(map.projects.map(p => p.name).sort()).toEqual(['@acme/app', '@acme/render', '@acme/tool', '@acme/viz', 'acme-core', 'acme-worker']);
        expect(map.projects.find(p => p.focus)?.name).toBe('@acme/app');
        // @acme/tool has no repository: its npm scope makes it the organisation's.
        expect(map.projects.find(p => p.name === '@acme/tool')?.owned).toBe(true);
    });

    it('links the dependencies to the local projects and checks the ranges', () => {
        const links = map.links.map(l => `${name(l.from)} > ${name(l.to)} ${l.satisfied}`).sort();
        expect(links).toEqual(['@acme/app > @acme/viz false', '@acme/tool > @acme/viz true', '@acme/viz > @acme/render true', 'acme-worker > acme-core false']);
        expect(kinds('outdated-dependency').map(s => s.title)).toEqual(['@acme/app depends on @acme/viz ^1.0.0, the local version is 2.0.0', 'acme-worker depends on acme-core >=1.0, the local version is 0.9.0']);
    });

    it('suggests where code belongs', () => {
        const dup = kinds('duplicate-across-projects')[0];
        expect(dup).toMatchObject({ title: 'formatSize is in both @acme/app and @acme/viz (100% alike)', practice: 'dry' });
        // @acme/app depends on @acme/viz: the copy to remove is the app's.
        expect(name(dup.target!)).toBe('@acme/viz');
        expect(name(dup.project)).toBe('@acme/app');
        const moves = kinds('move-to-dependency').map(s => `${name(s.project)}:${s.files[0].file} -> ${name(s.target!)}`);
        expect(moves).toContain('@acme/app:src/ui/panel.ts -> @acme/viz');
        expect(moves).toContain('@acme/viz:src/canvas.ts -> @acme/render');
        expect(kinds('move-to-consumer').map(s => `${s.files[0].file} -> ${name(s.target!)}`)).toEqual(['src/app-only.ts -> @acme/app']);
        // The app bundles @acme/viz: lodash ^4 and ^3 have no version in common.
        expect(kinds('version-drift').map(s => s.title)).toEqual(['lodash is used at different versions']);
    });

    it('says which projects it found and left out, and why', () => {
        expect(map.notes.find(n => n.startsWith('Not shown'))).toContain('thing');
    });

    it('maps again what changed: a project added inside the code base is one of its parts', () => {
        const dir = mkdtempSync(join(tmpdir(), 'pflow-c4-'));
        try {
            cpSync(FIXTURE, dir, { recursive: true });
            const app = join(dir, 'app');
            expect(mapProjects(app).projects.find(p => p.focus)?.modules).toEqual([]);
            // A package added to the repository without a workspace entry, and test data that is not a part.
            mkdirSync(join(app, 'plugins', 'charts'), { recursive: true });
            writeFileSync(join(app, 'plugins', 'charts', 'package.json'), JSON.stringify({ name: '@acme/charts', version: '0.1.0', dependencies: { '@acme/render': '^0.3.0' } }));
            mkdirSync(join(app, 'test', 'fixtures', 'sample'), { recursive: true });
            writeFileSync(join(app, 'test', 'fixtures', 'sample', 'package.json'), JSON.stringify({ name: 'sample' }));
            // Next to it: a new local project with no owner of its own, and a git worktree of the app.
            mkdirSync(join(dir, 'notes'));
            writeFileSync(join(dir, 'notes', 'package.json'), JSON.stringify({ name: 'notes', version: '0.0.1' }));
            cpSync(app, join(dir, 'app-wt'), { recursive: true });
            mkdirSync(join(app, '.git', 'worktrees', 'app-wt'), { recursive: true });
            writeFileSync(join(dir, 'app-wt', '.git'), `gitdir: ${join(app, '.git', 'worktrees', 'app-wt')}\n`);
            const again = mapProjects(app);
            expect(again.projects.filter(p => p.name === '@acme/app')).toHaveLength(1);
            expect(again.projects.find(p => p.name === 'notes')?.owned).toBe(true);
            const focus = again.projects.find(p => p.focus)!;
            expect(focus.modules.map(m => `${m.name} ${m.dir} ${m.kind}`)).toEqual(['@acme/charts plugins/charts library']);
            // The app keeps its own code next to the package added in it.
            expect(again.workspace.elements.filter(e => e.type === 'container' && e.parent === focus.id).map(e => e.name)).toEqual(['@acme/app', '@acme/charts']);
            const renderId = again.projects.find(p => p.name === '@acme/render')!.id;
            expect(again.links.find(l => l.from === focus.id && l.to === renderId)).toMatchObject({ fromModule: '@acme/charts' });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('describes them as a C4 model', () => {
        const ws = map.workspace;
        expect(ws.views.map(v => v.key)).toEqual(['projects', 'context', 'containers', 'components-acme-app']);
        const context = viewContents(ws, ws.views[1]);
        // lodash: a library several of the projects use.
        expect(context.nodes.map(n => n.name).sort()).toEqual(['@acme/app', '@acme/viz', 'lodash']);
        const components = viewContents(ws, ws.views[3]);
        expect(components.nodes.filter(n => n.kind === 'element').map(n => n.name).sort()).toEqual(['(root)', '@acme/viz', 'ui', 'util']);
        expect(components.edges.find(e => e.target === 'viz')?.technology).toBe('Canvas, appOnly');
        // The DSL written for it reads back without errors.
        const markdown = projectMapMarkdown(map);
        const dsl = markdown.slice(markdown.indexOf('```dsl') + 6, markdown.lastIndexOf('```'));
        expect(parseC4Dsl(dsl).diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });
});

describe("the code base's own C4 model against its code", () => {
    const MODEL = `workspace "Shop" {
    model {
        user = person "Customer"
        shop = softwareSystem "Shop" {
            web = container "Web" "The storefront" "Angular"
            api = container "API" "Orders" "Node"
        }
        user -> web "Buys"
        web -> api "Calls"
        api -> web "Pushes updates"
    }
}
`;

    function shop(): string {
        const root = mkdtempSync(join(tmpdir(), 'provenflow-c4-drift-'));
        const write = (file: string, text: string) => {
            mkdirSync(join(root, file, '..'), { recursive: true });
            writeFileSync(join(root, file), text);
        };
        write('package.json', JSON.stringify({ name: 'shop', private: true, workspaces: ['packages/*'] }));
        write('packages/web/package.json', JSON.stringify({ name: '@shop/web', dependencies: { '@shop/api': '*' } }));
        write('packages/api/package.json', JSON.stringify({ name: '@shop/api' }));
        write('packages/jobs/package.json', JSON.stringify({ name: '@shop/jobs', dependencies: { '@shop/api': '*' } }));
        write('packages/web/src/page.ts', "import { order } from '@shop/api';\nexport const page = () => order();\n");
        write('packages/api/src/index.ts', 'export function order(): number {\n    return 1;\n}\n');
        write('packages/jobs/src/run.ts', "import { order } from '@shop/api';\nexport const run = () => order();\n");
        write('docs/c4/workspace.dsl', MODEL);
        return root;
    }

    it('links the packages of one repository, and finds what the model leaves out or the code does not back', () => {
        const root = shop();
        try {
            const ws = mapProjects(root, { scan: [root] }).workspace;
            const name = (id: string) => ws.elements.find(e => e.id === id)?.name;
            expect(ws.relationships.filter(r => r.tags.includes('Module dependency')).map(r => `${name(r.source)} -> ${name(r.destination)}`).sort()).toEqual(['@shop/jobs -> @shop/api', '@shop/web -> @shop/api']);
            const drift = modelDrift(root);
            expect(drift.file).toBe('docs/c4/workspace.dsl');
            // Web -> API is backed by the import; the jobs package is missing; API -> Web has no import (it may be a push over the network).
            expect(drift.findings.map(f => [f.rule, f.severity, f.subject, f.loc?.line])).toEqual([
                ['c4-undocumented-part', 'warning', '@shop/jobs', 4],
                ['c4-unbacked-relationship', 'info', 'API -> Web', 10]
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('reports it with the other findings, unless the config turns it off', async () => {
        const root = shop();
        try {
            const quick = { analyzers: false, confirm: false } as const;
            expect((await extractProject(root, { ...quick, config: {} })).findings.filter(f => f.rule.startsWith('c4-')).length).toBe(2);
            expect((await extractProject(root, { ...quick, config: { c4: false } })).findings.some(f => f.rule.startsWith('c4-'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
