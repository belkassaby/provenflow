/**
 * Adds a discovered model to one written by hand: an element of `extra` whose name matches one of
 * `base` (case, npm scope and punctuation aside) is that element; the others are added, tagged
 * "Discovered", inside the element their parent matched; relationships are added where `base` has
 * none between the same two elements; views and styles of `extra` that `base` does not have come
 * along. What the hand-written model says wins: nothing of it is changed or removed.
 */
import { identifierFor, type C4Element, type C4Workspace } from './model.js';

export const DISCOVERED_TAG = 'Discovered';

/** `@jds/jit-extensions` → `jitextensions`. */
export function matchName(name: string): string {
    return name
        .toLowerCase()
        .replace(/^@[^/]+\//, '')
        .replace(/[^a-z0-9]/g, '');
}

export function mergeC4Workspaces(base: C4Workspace, extra: C4Workspace): C4Workspace {
    const taken = new Set([...base.elements.map(e => e.id), ...base.relationships.map(r => r.id)]);
    const { mapped, added } = mergedElements(base, extra, taken);
    return {
        ...base,
        elements: [...base.elements, ...added],
        relationships: [...base.relationships, ...mergedRelationships(base, extra, mapped, taken)],
        views: [...base.views, ...extra.views.filter(v => !base.views.some(b => b.key === v.key) && (!v.scope || mapped.has(v.scope))).map(v => ({ ...v, scope: v.scope && mapped.get(v.scope), positions: undefined }))],
        styles: mergedStyles(base.styles, extra.styles)
    };
}

/** Each element of `extra` as the element of `base` with its name, or added (tagged Discovered). */
function mergedElements(base: C4Workspace, extra: C4Workspace, taken: Set<string>): { mapped: Map<string, string>; added: C4Element[] } {
    const byName = new Map<string, C4Element>();
    for (const e of base.elements.filter(x => !x.environment)) if (!byName.has(matchName(e.name))) byName.set(matchName(e.name), e);
    const parents = new Set(base.elements.map(e => e.parent).filter(Boolean));
    const mapped = new Map<string, string>();
    const added: C4Element[] = [];
    for (const e of extra.elements) {
        const parent = e.parent ? mapped.get(e.parent) : undefined;
        const match = matching(byName.get(matchName(e.name)), e, parent);
        if (match) mapped.set(e.id, match.id);
        else if (keeps(e, parent, parents, added)) {
            const id = taken.has(e.id) ? identifierFor(e.id, taken) : e.id;
            taken.add(id);
            mapped.set(e.id, id);
            added.push({ ...e, id, parent, tags: [...new Set([...e.tags, DISCOVERED_TAG])] });
        }
    }
    return { mapped, added };
}

/** The written element with the same name, when it is at the same place (or is the discovered one's parent). */
function matching(match: C4Element | undefined, e: C4Element, parent: string | undefined): C4Element | undefined {
    if (!match || (e.parent && !parent)) return undefined;
    return !e.parent || match.parent === parent || match.id === parent ? match : undefined;
}

/**
 * Whether a discovered element is added: its parent is in the model, and the hand-written model
 * does not already break that parent down (then its own parts stand).
 */
function keeps(e: C4Element, parent: string | undefined, parents: Set<string | undefined>, added: C4Element[]): boolean {
    if (e.parent && !parent) return false;
    return !(parent && parents.has(parent) && !added.some(a => a.id === parent));
}

function mergedStyles(base: C4Workspace['styles'], extra: C4Workspace['styles']): C4Workspace['styles'] {
    const newOnly = <T extends { tag: string }>(mine: T[], theirs: T[]) => [...mine, ...theirs.filter(s => !mine.some(b => b.tag === s.tag))];
    const discovered = base.elements.some(s => s.tag === DISCOVERED_TAG) ? [] : [{ tag: DISCOVERED_TAG, border: 'dashed' as const }];
    return { elements: [...newOnly(base.elements, extra.elements), ...discovered], relationships: newOnly(base.relationships, extra.relationships) };
}

function mergedRelationships(base: C4Workspace, extra: C4Workspace, mapped: Map<string, string>, taken: Set<string>): C4Workspace['relationships'] {
    const exists = new Set(base.relationships.map(r => `${r.source}>${r.destination}`));
    const out: C4Workspace['relationships'] = [];
    for (const r of extra.relationships) {
        const source = mapped.get(r.source);
        const destination = mapped.get(r.destination);
        if (!source || !destination || source === destination || exists.has(`${source}>${destination}`)) continue;
        exists.add(`${source}>${destination}`);
        const id = taken.has(r.id) ? identifierFor(r.id, taken) : r.id;
        taken.add(id);
        out.push({ ...r, id, source, destination, tags: [...new Set([...r.tags, DISCOVERED_TAG])] });
    }
    return out;
}
