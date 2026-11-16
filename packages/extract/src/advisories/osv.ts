/**
 * Known vulnerabilities of the dependencies, from the OSV database (osv.dev): the exact versions of the
 * lockfiles are asked about in batches, and each vulnerability's advisory gives its severity and the
 * versions that fix it. Only package names and versions are sent, never code, and never the project's
 * own packages (see lockfiles.ts) or those the config lists as private. Answers are cached for a day.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdvisoriesConfig } from '../config.js';
import type { Finding, Severity } from '../models.js';
import { matchesAny } from '../scan.js';
import { lockedPackages, type LockedPackage } from './lockfiles.js';

export const OSV_URL = 'https://api.osv.dev';
const BATCH = 1000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const SHOWN_IDS = 3;

/** The parts of an OSV advisory used here. */
export interface OsvVulnerability {
    id: string;
    summary?: string;
    aliases?: string[];
    database_specific?: { severity?: string };
    affected?: Array<{ package?: { name?: string; ecosystem?: string }; ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>;
}

export interface AdvisoryOptions {
    /** Defaults to the global fetch (tests pass their own). */
    fetch?: typeof fetch;
    /** Where answers are cached (none when omitted). */
    cacheDir?: string;
    /** Folders and files left out (the config's `exclude`). */
    exclude?: string[];
}

export interface AdvisoryResult {
    findings: Finding[];
    notes: string[];
}

export async function vulnerableDependencies(root: string, config: AdvisoriesConfig, options: AdvisoryOptions = {}): Promise<AdvisoryResult> {
    const all = lockedPackages(root, options.exclude);
    const sent = all.filter(p => !matchesAny(p.name, config.private ?? []));
    if (sent.length === 0) return { findings: [], notes: all.length ? [] : ['OSV: no lockfile with exact versions found (package-lock.json, poetry.lock, uv.lock, requirements.txt, Cargo.lock, go.mod, composer.lock, pom.xml).'] };
    const client = new OsvClient(config.url ?? OSV_URL, options.fetch ?? fetch, options.cacheDir);
    try {
        const ids = await client.query(sent);
        const advisories = await client.advisories([...new Set(ids.flat())]);
        const findings = sent.flatMap((p, i) => (ids[i].length ? [findingOf(p, ids[i].map(id => advisories.get(id) ?? { id }))] : []));
        const kept = all.length - sent.length;
        return { findings, notes: [`OSV: ${sent.length} locked package version(s) checked${kept ? `, ${kept} private one(s) not sent` : ''}; ${findings.length} with known vulnerabilities.`] };
    } catch (error) {
        return { findings: [], notes: [`OSV: the vulnerability database could not be asked (${(error as Error).message}).`] };
    }
}

/** Asks osv.dev, through a cache of a day. */
class OsvClient {
    constructor(
        private readonly url: string,
        private readonly fetcher: typeof fetch,
        private readonly cacheDir: string | undefined
    ) {}

    /** The ids of the vulnerabilities of each package, in order. */
    async query(packages: LockedPackage[]): Promise<string[][]> {
        const out: string[][] = [];
        for (let i = 0; i < packages.length; i += BATCH) {
            const queries = packages.slice(i, i + BATCH).map(p => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version }));
            const answer = await this.cached(`batch-${hash(JSON.stringify(queries))}`, () => this.post('/v1/querybatch', { queries }));
            const results = (answer as { results?: Array<{ vulns?: Array<{ id: string }> }> }).results ?? [];
            out.push(...queries.map((_, j) => (results[j]?.vulns ?? []).map(v => v.id)));
        }
        return out;
    }

    async advisories(ids: string[]): Promise<Map<string, OsvVulnerability>> {
        const found = new Map<string, OsvVulnerability>();
        for (const id of ids) found.set(id, (await this.cached(`vuln-${hash(id)}`, () => this.get(`/v1/vulns/${encodeURIComponent(id)}`))) as OsvVulnerability);
        return found;
    }

    private async post(path: string, body: unknown): Promise<unknown> {
        return this.answer(await this.fetcher(`${this.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    }

    private async get(path: string): Promise<unknown> {
        return this.answer(await this.fetcher(`${this.url}${path}`));
    }

    private async answer(response: Response): Promise<unknown> {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
    }

    private async cached(key: string, ask: () => Promise<unknown>): Promise<unknown> {
        const file = this.cacheDir ? join(this.cacheDir, `${key}.json`) : undefined;
        if (file && existsSync(file) && Date.now() - statSync(file).mtimeMs < CACHE_MS) return JSON.parse(readFileSync(file, 'utf8'));
        const value = await ask();
        if (file) {
            mkdirSync(this.cacheDir!, { recursive: true });
            writeFileSync(file, JSON.stringify(value));
        }
        return value;
    }
}

function hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

const SEVERITY: Record<string, Severity> = { CRITICAL: 'error', HIGH: 'error', MODERATE: 'warning', MEDIUM: 'warning', LOW: 'info' };
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function severityOf(v: OsvVulnerability): Severity {
    return SEVERITY[(v.database_specific?.severity ?? '').toUpperCase()] ?? 'warning';
}

/** The versions that fix the vulnerabilities of a package, from their advisories. */
function fixedVersions(p: LockedPackage, vulns: OsvVulnerability[]): string[] {
    const fixed = vulns.flatMap(v =>
        (v.affected ?? []).filter(a => a.package?.name === p.name).flatMap(a => (a.ranges ?? []).flatMap(r => (r.events ?? []).flatMap(e => (e.fixed ? [e.fixed] : []))))
    );
    return [...new Set(fixed)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function label(v: OsvVulnerability): string {
    const cve = v.aliases?.find(a => a.startsWith('CVE-'));
    return `${v.id}${cve && cve !== v.id ? ` (${cve})` : ''}${v.summary ? `: ${v.summary}` : ''}`;
}

function findingOf(p: LockedPackage, vulns: OsvVulnerability[]): Finding {
    const severity = vulns.map(severityOf).sort((a, b) => RANK[a] - RANK[b])[0];
    const fixed = fixedVersions(p, vulns);
    const listed = vulns.slice(0, SHOWN_IDS).map(label).join('; ');
    const more = vulns.length > SHOWN_IDS ? `; and ${vulns.length - SHOWN_IDS} more` : '';
    return {
        rule: 'vulnerable-dependency',
        category: 'security',
        severity,
        subject: `${p.name}@${p.version}`,
        message: `${p.file} installs ${p.name} ${p.version}, which has ${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'} (OSV): ${listed}${more}.`,
        fix: fixed.length
            ? `Upgrade ${p.name} to a version with the fixes (${fixed.join(', ')}), or to the latest, and update the lockfile. See https://osv.dev/vulnerability/${vulns[0].id}.`
            : `No fixed version is published: check https://osv.dev/vulnerability/${vulns[0].id} for a workaround, or replace ${p.name}.`,
        loc: { file: p.file, line: p.line },
        source: 'osv'
    };
}
