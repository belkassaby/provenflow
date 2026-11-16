import type { CodeFinding } from './code-import';

/** One proposed change to one file: its edits there, and the finding it fixes. */
export interface FileChange {
    finding: CodeFinding;
    edits: Array<{ search: string; replace: string }>;
    /** The change came as the whole file (no edits): it replaces the file and combines with nothing else. */
    whole: boolean;
}

/** A file of the report with the changes proposed for it, and its findings that have none yet. */
export interface FileEdits {
    file: string;
    /** The file as analysed ('' when no change is proposed for it yet). */
    before: string;
    changes: FileChange[];
    pending: CodeFinding[];
}

/** The findings grouped by file: the proposed changes of each file, and the findings still without one. */
export function editsByFile(findings: CodeFinding[]): FileEdits[] {
    const files = new Map<string, FileEdits>();
    const entry = (file: string) => {
        if (!files.has(file)) files.set(file, { file, before: '', changes: [], pending: [] });
        return files.get(file)!;
    };
    for (const f of findings) {
        const patch = f.suggestedPatch;
        if (!patch?.files?.length) {
            if (f.loc) entry(f.loc.file).pending.push(f);
            continue;
        }
        for (const pf of patch.files) {
            const e = entry(pf.file);
            e.before ||= pf.before;
            const edits = (patch.edits ?? []).filter(x => x.file === pf.file).map(({ search, replace }) => ({ search, replace }));
            e.changes.push({ finding: f, edits: edits.length ? edits : [{ search: pf.before, replace: pf.after }], whole: edits.length === 0 });
        }
    }
    return [...files.values()].sort((a, b) => b.changes.length - a.changes.length || b.pending.length - a.pending.length || a.file.localeCompare(b.file));
}

/** `text` with the edits made in order, or undefined when one no longer matches. */
export function applyEdits(text: string, edits: FileChange['edits']): string | undefined {
    let out = text;
    for (const e of edits) {
        if (e.search === '') {
            if (out !== '') return undefined;
            out = e.replace;
            continue;
        }
        const at = out.indexOf(e.search);
        if (at < 0) return undefined;
        out = out.slice(0, at) + e.replace + out.slice(at + e.search.length);
    }
    return out;
}

/**
 * The file with the changes made one after the other. A change whose text an earlier one already
 * changed does not match any more: it is left out (a conflict) and the others still combine.
 */
export function combine(before: string, changes: FileChange[]): { after: string; applied: FileChange[]; conflicts: FileChange[] } {
    let after = before;
    const applied: FileChange[] = [];
    const conflicts: FileChange[] = [];
    for (const c of [...changes.filter(x => !x.whole), ...changes.filter(x => x.whole)]) {
        const next = applyEdits(after, c.edits);
        if (next === undefined) conflicts.push(c);
        else {
            after = next;
            applied.push(c);
        }
    }
    return { after, applied, conflicts };
}
