/**
 * Whether a version satisfies a dependency range: npm ranges (`^1.2`, `~1.2.3`, `>=1 <2`, `1.x`,
 * `a || b`), Python specifiers (`>=1.2,<2`, `~=1.2`, `==1.2.*`) and Poetry's (`^1.2`). Undefined
 * when the range is not a version range (a path, a git URL, a workspace link) or cannot be read.
 */

type Version = [number, number, number];

export function parseVersion(text: string | undefined): Version | undefined {
    const m = /^\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/i.exec(text ?? '');
    if (!m) return undefined;
    const n = (s: string | undefined) => (s === undefined || /[x*]/i.test(s) ? 0 : Number(s));
    return [Number(m[1]), n(m[2]), n(m[3])];
}

function compare(a: Version, b: Version): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** How many parts a partial version gives ("1" → 1, "1.2" → 2, "1.2.3" → 3; `x` and `*` do not count). */
function precision(text: string): number {
    return text.replace(/^v/, '').split('.').filter(p => /^\d+/.test(p)).length;
}

/** The upper bound (exclusive) of `^v`, `~v`, or a partial version `1.2` / `1.x`. */
function next(v: Version, part: 0 | 1 | 2): Version {
    return part === 0 ? [v[0] + 1, 0, 0] : part === 1 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1];
}

function caretPart(v: Version): 0 | 1 | 2 {
    return v[0] > 0 ? 0 : v[1] > 0 ? 1 : 2;
}

/** One comparator → [lower bound inclusive, upper bound exclusive]. */
function bounds(comparator: string): [Version | undefined, Version | undefined] | undefined {
    const m = /^(\^|~=|~|>=|<=|>|<|==|=|!=)?\s*(.+)$/.exec(comparator.trim());
    if (!m) return undefined;
    const [, op = '', rest] = m;
    const v = parseVersion(rest);
    if (!v) return undefined;
    const p = precision(rest);
    switch (op) {
        case '^':
            return [v, next(v, caretPart(v))];
        case '~':
            return [v, next(v, p >= 2 ? 1 : 0)];
        case '~=':
            return [v, next(v, Math.max(0, p - 2) as 0 | 1)];
        case '>=':
            return [v, undefined];
        case '>':
            return [next(v, 2), undefined];
        case '<=':
            return [undefined, next(v, 2)];
        case '<':
            return [undefined, v];
        case '!=':
            return [undefined, undefined];
        default:
            return p >= 3 && !rest.includes('*') ? [v, next(v, 2)] : [v, next(v, Math.max(0, p - 1) as 0 | 1)];
    }
}

/** True, false, or undefined when the range is not a version range. */
export function satisfies(version: string | undefined, range: string | undefined): boolean | undefined {
    const v = parseVersion(version);
    const r = (range ?? '').trim();
    if (!v || !r || /^(\*|latest|x)$/i.test(r)) return v && r ? true : undefined;
    if (/^(file:|link:|workspace:|git|https?:|github:|\.|\/)/.test(r)) return undefined;
    let known = false;
    for (const alternative of r.split('||')) {
        const comparators = alternative.replace(/,/g, ' ').replace(/([<>=~^!]+)\s+/g, '$1').trim().split(/\s+/).filter(Boolean);
        const all = comparators.map(bounds);
        if (all.some(b => !b)) continue;
        known = true;
        if (all.every(b => (!b![0] || compare(v, b![0]) >= 0) && (!b![1] || compare(v, b![1]) < 0))) return true;
    }
    return known ? false : undefined;
}

/** The lowest version a range accepts (to compare ranges of the same library). */
export function minimum(range: string | undefined): string | undefined {
    const first = (range ?? '').split('||')[0].replace(/,/g, ' ').trim().split(/\s+/)[0] ?? '';
    const b = bounds(first);
    return b?.[0]?.join('.');
}
