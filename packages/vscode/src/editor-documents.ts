/**
 * What an editor tab opens: a model extracted from a folder (checked at once when a property of it
 * is false, so its counterexamples show), the C4 architecture of a folder, or a .pflow or C4 file.
 * No `vscode` import here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { OUTPUT_FOLDER } from './cli';
import type { EditorDocument } from './editor-panels';
import type { Report } from './report';

/** The kind of editor document a file is, or undefined when the editor does not open it. */
export function editorKindOf(path: string): 'diagram' | 'c4' | undefined {
    const name = path.toLowerCase();
    if (name.endsWith('.pflow') || name.endsWith('.nxd')) return 'diagram';
    if (name.endsWith('.dsl') || name.endsWith('.c4.json')) return 'c4';
    return undefined;
}

/** A model of the folder's last analysis; undefined when its file is not there. */
export function modelDocument(root: string, id: string, report?: Report): EditorDocument | undefined {
    const path = join(root, OUTPUT_FOLDER, 'models', `${id}.pflow`);
    if (!existsSync(path)) return undefined;
    const check = !!report?.verdicts.some(v => v.model === id && v.verdict === 'false');
    return { key: `model:${path}`, title: `${id}.pflow`, message: { provenflow: 'open-file', file: { name: `${id}.pflow`, path, text: readFileSync(path, 'utf8'), kind: 'diagram', check } } };
}

/** The C4 architecture of a folder: its projects, mapped by the editor. */
export function c4Document(root: string): EditorDocument {
    return { key: `c4:${root}`, title: `C4 · ${basename(root)}`, message: { provenflow: 'map-c4', path: root } };
}

/** A .pflow diagram or a C4 workspace file; undefined when the editor does not open it. */
export function fileDocument(path: string, text: string): EditorDocument | undefined {
    const kind = editorKindOf(path);
    if (!kind) return undefined;
    return { key: `file:${path}`, title: basename(path), path, message: { provenflow: 'open-file', file: { name: basename(path), path, text, kind } } };
}

/** A tab that runs one of the editor's commands when it opens (a new diagram, an example, the code base report). */
export function commandDocument(key: string, title: string, command: string): EditorDocument {
    return { key, title, message: { provenflow: 'command', command } };
}

/**
 * Where a file the editor saves goes: over the file the tab shows, when it saves that file (Save of
 * a .pflow opened from the workspace); otherwise wherever the user says, starting next to that file
 * or in the folder.
 */
export function savePlan(document: EditorDocument, name: string, folder: string): { write: string } | { ask: string } {
    if (document.path && basename(document.path) === name) return { write: document.path };
    return { ask: join(document.path ? dirname(document.path) : folder, name) };
}

/** An editor with nothing opened: a new diagram, or File → Import code base. */
export const EMPTY_EDITOR: EditorDocument = { key: 'editor', title: 'ProvenFlow' };
