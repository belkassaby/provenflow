/** `pflow c4`: the projects around a code base as a C4 model, and where code belongs. */
import { writeFileSync } from 'node:fs';
import { c4ViewToText, writeC4Dsl } from '@provenflow/language';
import { mapProjects, projectMapMarkdown, type ProjectMap } from '@provenflow/extract';
import type { Values } from './shared.js';

const list = (text: string | undefined) => text?.split(',').map(s => s.trim()).filter(Boolean);

export function c4Command(values: Values, dir = '.'): number {
    const map = mapProjects(dir, { scan: list(values.scan), owners: list(values.owner), depth: values.depth ? Number(values.depth) : undefined });
    const format = values.format ?? (values.json ? 'json' : formatOf(values.output));
    const text = render(map, format, values);
    if (text === undefined) {
        console.error(`Unknown format ${format}: dsl, json, plantuml, mermaid or markdown.`);
        return 2;
    }
    if (values.output) {
        writeFileSync(values.output, text);
        console.log(`Wrote ${values.output}: ${map.projects.length} projects, ${map.suggestions.length} suggestion(s).`);
    } else process.stdout.write(text);
    return 0;
}

function formatOf(file: string | undefined): string {
    const ext = file?.split('.').pop()?.toLowerCase();
    return ext === 'dsl' ? 'dsl' : ext === 'json' ? 'json' : ext === 'puml' ? 'plantuml' : ext === 'mmd' ? 'mermaid' : 'markdown';
}

function render(map: ProjectMap, format: string, values: Values): string | undefined {
    // --merge: the code base's own model (workspace.dsl) with the discovered projects added.
    const ws = (values.merge && map.existing?.merged) || map.workspace;
    const view = ws.views.find(v => v.key === values.view) ?? ws.views[0];
    switch (format) {
        case 'dsl':
            return writeC4Dsl(ws);
        case 'json':
            return `${JSON.stringify(values.merge ? { ...map, workspace: ws } : map, null, 2)}\n`;
        case 'plantuml':
        case 'mermaid':
            return view ? c4ViewToText(ws, view, format) : '';
        case 'markdown':
            return projectMapMarkdown(map);
        default:
            return undefined;
    }
}
