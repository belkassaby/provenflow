import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseC4Dsl, viewContents } from '@provenflow/language';
import { mapProjects, projectMapMarkdown } from '../src/index.js';
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
