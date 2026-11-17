import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lockedPackages } from '../src/advisories/lockfiles.js';
import { vulnerableDependencies } from '../src/advisories/osv.js';

const scratch = mkdtempSync(join(tmpdir(), 'provenflow-advisories-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const LOCK = {
    name: 'shop',
    lockfileVersion: 3,
    packages: {
        '': { name: 'shop' },
        'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz' },
        'node_modules/@acme/billing': { version: '2.0.0', resolved: 'https://npm.acme.internal/@acme/billing/-/billing-2.0.0.tgz' },
        'node_modules/@shop/ui': { resolved: 'packages/ui', link: true },
        'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz' }
    }
};

function project(): string {
    const root = mkdtempSync(join(scratch, 'p-'));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(LOCK, null, 2));
    writeFileSync(join(root, 'requirements.txt'), '# pinned\nrequests==2.19.0\nflask>=2\nacme-tools==1.0\n');
    writeFileSync(join(root, 'Cargo.lock'), '[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "time"\nversion = "0.1.42"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n');
    return root;
}

/** A stand-in for osv.dev: lodash and requests are vulnerable. */
function osv(sent: unknown[]): typeof fetch {
    const vulns: Record<string, string[]> = { 'npm|lodash': ['GHSA-35jh-r3h4-6jhm'], 'PyPI|requests': ['GHSA-x84v-xcm2-53pg', 'PYSEC-2018-28'] };
    const advisories: Record<string, unknown> = {
        'GHSA-35jh-r3h4-6jhm': { id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', aliases: ['CVE-2021-23337'], database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] },
        'GHSA-x84v-xcm2-53pg': { id: 'GHSA-x84v-xcm2-53pg', summary: 'Insufficiently Protected Credentials in Requests', database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'requests', ecosystem: 'PyPI' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '2.20.0' }] }] }] },
        'PYSEC-2018-28': { id: 'PYSEC-2018-28', affected: [] }
    };
    return (async (url: string, init?: RequestInit) => {
        const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
        if (url.endsWith('/v1/querybatch')) {
            const { queries } = JSON.parse(String(init!.body)) as { queries: Array<{ package: { name: string; ecosystem: string } }> };
            sent.push(...queries);
            return json({ results: queries.map(q => ({ vulns: (vulns[`${q.package.ecosystem}|${q.package.name}`] ?? []).map(id => ({ id })) })) });
        }
        return json(advisories[decodeURIComponent(url.split('/').pop()!)]);
    }) as typeof fetch;
}

describe('known vulnerabilities of the dependencies (OSV)', () => {
    it('reads the exact versions of the lockfiles, without local, linked or other registries\' packages', () => {
        const packages = lockedPackages(project()).map(p => `${p.ecosystem} ${p.name} ${p.version} ${p.file}:${p.line}`);
        expect(packages).toEqual(
            expect.arrayContaining(['npm lodash 4.17.20 package-lock.json:8', 'npm left-pad 1.3.0 package-lock.json:20', 'PyPI requests 2.19.0 requirements.txt:2', 'crates.io time 0.1.42 Cargo.lock:6'])
        );
        expect(packages.join('\n')).not.toMatch(/billing|@shop\/ui|flask| app /);
    });

    it('reports each vulnerable version with its advisories and the versions that fix them, and never sends private names', async () => {
        const sent: Array<{ package: { name: string } }> = [];
        const r = await vulnerableDependencies(project(), { osv: true, private: ['acme-*'] }, { fetch: osv(sent) });
        expect(sent.map(q => q.package.name).sort()).toEqual(['left-pad', 'lodash', 'requests', 'time']);
        const lodash = r.findings.find(f => f.subject === 'lodash@4.17.20')!;
        expect(lodash).toMatchObject({ rule: 'vulnerable-dependency', category: 'security', severity: 'error', source: 'osv', loc: { file: 'package-lock.json', line: 8 } });
        expect(lodash.message).toContain('GHSA-35jh-r3h4-6jhm (CVE-2021-23337): Command Injection in lodash');
        expect(lodash.fix).toContain('4.17.21');
        expect(r.findings.find(f => f.subject === 'requests@2.19.0')).toMatchObject({ severity: 'warning' });
        expect(r.findings).toHaveLength(2);
        expect(r.notes[0]).toMatch(/4 locked package version\(s\) checked, 1 private one\(s\) not sent; 2 with known vulnerabilities/);
    });

    it('notes an unreachable database instead of failing', async () => {
        const down = (async () => new Response('', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch;
        const r = await vulnerableDependencies(project(), { osv: true }, { fetch: down });
        expect(r.findings).toEqual([]);
        expect(r.notes[0]).toMatch(/could not be asked \(503/);
    });
});
