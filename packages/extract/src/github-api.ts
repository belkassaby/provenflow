/** The GitHub REST API as the reviews use it, and the marker that identifies ProvenFlow's comments. */

export interface GithubTarget {
    token: string;
    repository: string;
    pull: number;
    commit: string;
    apiUrl?: string;
}

/** Hidden in each comment, so a later run knows which findings it already reported. */
export const marker = (key: string) => `<!-- provenflow:${key.replace(/--/g, '- -')} -->`;
export const MARKER = /<!-- provenflow:(.+?) -->/;

/** The finding key (rule|subject|file), or `summary`/`fixed`, of a ProvenFlow comment; undefined for other comments. */
export function commentKey(body: string): string | undefined {
    return MARKER.exec(body)?.[1].replace(/- -/g, '--');
}

/** Hidden next to the marker: the ProvenFlow version that made the finding, so answers can be weighed per version. */
export const versionMarker = (version: string) => `<!-- provenflow-version:${version} -->`;
const VERSION_MARKER = /<!-- provenflow-version:([\w.+-]+) -->/;

/** The version that wrote a ProvenFlow comment; undefined for comments of versions before 0.2.1. */
export function commentVersion(body: string): string | undefined {
    return VERSION_MARKER.exec(body)?.[1];
}

export interface GithubApi {
    call(method: string, path: string, body?: unknown): Promise<Response>;
    /** Every page of a list (up to 2,000 items). */
    all<T>(path: string): Promise<T[]>;
}

export function githubApi(target: GithubTarget, fetchImpl: typeof fetch): GithubApi {
    const base = target.apiUrl ?? 'https://api.github.com';
    const headers = { authorization: `Bearer ${target.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' };
    const call = (method: string, path: string, body?: unknown) => fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return {
        call,
        async all<T>(path: string): Promise<T[]> {
            const out: T[] = [];
            for (let page = 1; page <= 20; page++) {
                const res = await call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
                if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} reading ${path}: ${(await res.text()).slice(0, 200)}`);
                const items = (await res.json()) as T[];
                out.push(...items);
                if (items.length < 100) break;
            }
            return out;
        }
    };
}
