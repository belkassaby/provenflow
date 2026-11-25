/**
 * Architecture drift: where the code base's own C4 model (`workspace.dsl`, written by hand) and the
 * model discovered from its code disagree. Parts and dependencies the code has and the model does not
 * show are warnings; relationships of the model that no import backs are notes, since a model also
 * shows calls an import does not (HTTP, queues, databases).
 */
import { c4Drift, type C4Element, type C4Relationship, type C4Workspace } from '@provenflow/language';
import type { Finding } from '../models.js';

export interface WrittenModel {
    /** The model file, relative to the code base. */
    file: string;
    text: string;
    workspace: C4Workspace;
}

const KIND: Partial<Record<C4Element['type'], string>> = { softwareSystem: 'software system', container: 'container', component: 'component' };

export function driftFindings(written: WrittenModel, discovered: C4Workspace): Finding[] {
    const drift = c4Drift(written.workspace, discovered);
    const lineOf = (pattern: RegExp) => {
        const at = written.text.search(pattern);
        return at < 0 ? 1 : written.text.slice(0, at).split('\n').length;
    };
    const declared = (e: C4Element | undefined) => (e ? lineOf(new RegExp(`(^|\\s)${escape(e.id)}\\s*=`, 'm')) : 1);
    const related = (s: string, d: string) => lineOf(new RegExp(`(^|\\s)${escape(s)}\\s*->\\s*${escape(d)}(\\s|$)`, 'm'));
    return [
        ...drift.elements.map(({ element, within }) => missingPart(written.file, element, within, declared(within))),
        ...drift.relationships.map(({ source, destination }) => missingDependency(written.file, source, destination, declared(source))),
        ...drift.unbacked.map(r => unbacked(written, r, related(r.source, r.destination)))
    ];
}

function escape(id: string): string {
    return id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function missingPart(file: string, element: C4Element, within: C4Element | undefined, line: number): Finding {
    const kind = KIND[element.type] ?? element.type;
    const where = within ? ` inside ${within.name}` : '';
    return {
        rule: 'c4-undocumented-part',
        category: 'architecture',
        severity: 'warning',
        subject: element.name,
        message: `The code has the ${kind} ${element.name}${where}${element.description ? ` (${element.description})` : ''}, which ${file} does not show.`,
        fix: `Add it to ${file}${where ? `, in ${within!.name}` : ''} (\`pflow c4 --merge\` adds what the code has, tagged Discovered), or exclude its folder if it is not part of the architecture.`,
        loc: { file, line },
        source: 'analysis'
    };
}

function missingDependency(file: string, source: C4Element, destination: C4Element, line: number): Finding {
    return {
        rule: 'c4-undocumented-dependency',
        category: 'architecture',
        severity: 'warning',
        subject: `${source.name} -> ${destination.name}`,
        message: `In the code, ${source.name} depends on ${destination.name} (imports or a declared dependency), but ${file} shows no relationship between them.`,
        fix: `Add \`${source.id} -> ${destination.id} "Uses"\` to ${file}, or remove the dependency if the architecture forbids it.`,
        loc: { file, line },
        source: 'analysis'
    };
}

function unbacked(written: WrittenModel, r: C4Relationship, line: number): Finding {
    const name = (id: string) => written.workspace.elements.find(e => e.id === id)?.name ?? id;
    return {
        rule: 'c4-unbacked-relationship',
        category: 'architecture',
        severity: 'info',
        subject: `${name(r.source)} -> ${name(r.destination)}`,
        message: `${written.file} says ${name(r.source)} uses ${name(r.destination)}${r.description ? ` ("${r.description}")` : ''}, and both are in the code, but no import or declared dependency backs it.`,
        fix: `If the call goes over the network or a queue, this is expected. Otherwise the model is out of date: remove the relationship from ${written.file}.`,
        loc: { file: written.file, line },
        source: 'analysis'
    };
}
