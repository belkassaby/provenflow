/** The `styles { element "Tag" { ... } relationship "Tag" { ... } }` block of the Structurizr DSL. */
import { eachInBlock as eachIn, skipBlock as skip, type C4Statement, type StatementCursor as Cursor } from './dsl-lex.js';
import { parseRouting, type C4ElementStyle, type C4RelationshipStyle, type C4Workspace } from './model.js';

const NUMBERS = new Set(['strokeWidth', 'fontSize', 'opacity', 'width', 'height', 'thickness']);
const ELEMENT_PROPS = new Set(['background', 'color', 'stroke', 'shape', 'border', 'strokeWidth', 'fontSize', 'opacity', 'width', 'height']);
const RELATIONSHIP_PROPS = new Set(['color', 'dashed', 'style', 'thickness', 'fontSize', 'routing']);
/** DSL spellings → the model's property names. */
const SPELLINGS: Record<string, string> = { colour: 'color', strokewidth: 'strokeWidth', fontsize: 'fontSize' };

/** The element and relationship styles of a `styles` block. */
export function parseStyles(st: Cursor, warn: (line: number, message: string) => void): C4Workspace['styles'] {
    const styles: C4Workspace['styles'] = { elements: [], relationships: [] };
    eachIn(st, s => {
        const key = s.words[0]?.text.toLowerCase();
        const tag = s.words[1]?.text ?? '';
        if ((key === 'element' || key === 'relationship') && s.open) {
            const style: Record<string, unknown> = { tag };
            eachIn(st, p => styleProperty(st, p, style, key === 'element' ? ELEMENT_PROPS : RELATIONSHIP_PROPS));
            if (key === 'element') styles.elements.push(style as unknown as C4ElementStyle);
            else styles.relationships.push(style as unknown as C4RelationshipStyle);
        } else if (s.open) skip(st);
        else warn(s.line, `Unknown statement in styles: ${s.words[0]?.text ?? ''}.`);
    });
    return styles;
}

function styleProperty(st: Cursor, p: C4Statement, style: Record<string, unknown>, known: Set<string>): void {
    if (p.open) return skip(st);
    const raw = p.words[0]?.text ?? '';
    const name = SPELLINGS[raw.toLowerCase()] ?? raw;
    const value = p.words[1]?.text;
    if (!known.has(name) || value === undefined) return;
    if (name === 'dashed') style[name] = value.toLowerCase() === 'true';
    else if (name === 'routing') style[name] = parseRouting(value);
    else if (NUMBERS.has(name)) style[name] = Number(value);
    else style[name] = name === 'border' || name === 'style' ? value.toLowerCase() : value;
}
