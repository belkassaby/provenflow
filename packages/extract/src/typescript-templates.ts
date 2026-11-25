/** Angular templates: event handlers and bindings become methods of the component, so the checker sees them. */
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import type { Location } from './ir.js';
import { TEMPLATE_PREFIX } from './typescript-util.js';

export interface TemplateHandler {
    loc: Location;
    event: string;
    text: string;
}

/**
 * Angular templates set and test state too (`(click)="tab.set('model')"`,
 * `@if (tab() === 'model')`). Each binding becomes a method of the component
 * class, written on the line of the class's closing brace so that no other
 * line moves; its facts are reported at the template's location.
 */
export function synthesizeTemplates(root: string, files: string[], overrides?: Map<string, string>): { texts: Map<string, string>; handlers: Map<string, TemplateHandler> } {
    const texts = new Map<string, string>();
    const handlers = new Map<string, TemplateHandler>();
    for (const file of files) {
        const path = resolve(root, file);
        const text = overrides?.get(file) ?? ts.sys.readFile(path);
        if (!text || !text.includes('@Component')) continue;
        const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
        const inserts: Array<{ at: number; code: string }> = [];
        for (const cls of sf.statements.filter(ts.isClassDeclaration)) {
            const component = (ts.getDecorators(cls) ?? []).find(d => /^Component\b/.test(d.expression.getText(sf)));
            const options = component && ts.isCallExpression(component.expression) ? component.expression.arguments[0] : undefined;
            if (!cls.name || !options || !ts.isObjectLiteralExpression(options)) continue;
            let template: { text: string; file: string; line: number } | undefined;
            for (const p of options.properties) {
                if (!ts.isPropertyAssignment(p)) continue;
                const key = p.name.getText(sf);
                if (key === 'template' && (ts.isNoSubstitutionTemplateLiteral(p.initializer) || ts.isStringLiteral(p.initializer))) {
                    template = { text: p.initializer.text, file, line: sf.getLineAndCharacterOfPosition(p.initializer.getStart(sf)).line + 1 };
                } else if (key === 'templateUrl' && ts.isStringLiteral(p.initializer)) {
                    const html = resolve(path, '..', p.initializer.text);
                    const content = overrides?.get(relative(root, html)) ?? ts.sys.readFile(html);
                    if (content !== undefined) template = { text: content, file: relative(root, html).split('\\').join('/'), line: 1 };
                }
            }
            if (!template) continue;
            const members = new Set<string>();
            for (const m of cls.members) {
                if (m.name) members.add(m.name.getText(sf));
                if (ts.isConstructorDeclaration(m)) m.parameters.forEach(p => members.add(p.name.getText(sf)));
            }
            const methods: string[] = [];
            for (const binding of templateBindings(template.text)) {
                const code = implicitThis(binding.code, members);
                if (!code) continue;
                const name = `${TEMPLATE_PREFIX}${handlers.size}`;
                handlers.set(`${path}#${name}`, {
                    loc: { file: template.file, line: template.line + binding.line },
                    event: `${cls.name.text}.template ${binding.kind}`,
                    text: binding.source.trim()
                });
                methods.push(`${name}($event: ${binding.eventType ?? 'any'}) { const $any = (v: any): any => v; ${code}; }`);
            }
            if (methods.length > 0) inserts.push({ at: cls.end - 1, code: ` ${methods.join(' ')} ` });
        }
        if (inserts.length === 0) continue;
        let out = text;
        for (const i of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, i.at) + i.code + out.slice(i.at);
        texts.set(path, out);
    }
    return { texts, handlers };
}

interface Binding {
    kind: string;
    code: string;
    source: string;
    /** Line offset in the template. */
    line: number;
    /** The type of `$event` (a two-way binding emits a value of the bound field's type). */
    eventType?: string;
}

/** Event handlers, property bindings, control-flow conditions and interpolations of an Angular template. */
function templateBindings(template: string): Binding[] {
    const result: Binding[] = [];
    const lineAt = (index: number) => template.slice(0, index).split('\n').length - 1;
    const add = (kind: string, code: string, index: number, source: string) => {
        const cleaned = code.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        result.push({ kind, code: cleaned, source, line: lineAt(index) });
    };
    // [(mode)]="maskMode": the child component's mode output writes the field.
    for (const m of template.matchAll(/\[\(([\w.-]+)\)\]\s*=\s*"\s*([A-Za-z_$][\w$]*)\s*"/g)) {
        add(`[(${m[1]})]`, `${m[2]} = $event`, m.index!, m[0]);
        result[result.length - 1].eventType = `this[${JSON.stringify(m[2])}]`;
    }
    for (const m of template.matchAll(/\(([\w.:-]+)\)\s*=\s*"([^"]*)"/g)) add(`(${m[1]})`, m[2], m.index!, m[0]);
    for (const m of template.matchAll(/\[([\w.-]+)\]\s*=\s*"([^"]*)"/g)) add(`[${m[1]}]`, `void (${stripPipes(m[2])})`, m.index!, m[0]);
    for (const m of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) add('{{ }}', `void (${stripPipes(m[1])})`, m.index!, m[0]);
    // *ngIf="mode === 'a'; else other" (the structural directive before the @if syntax).
    for (const m of template.matchAll(/\*ngIf\s*=\s*"([^"]*)"/g)) add('*ngIf', `void (${stripPipes(m[1].split(';')[0])})`, m.index!, m[0]);
    for (const m of template.matchAll(/@(if|else if|switch|case)\s*\(/g)) {
        const start = m.index! + m[0].length;
        let depth = 1;
        let i = start;
        while (i < template.length && depth > 0) {
            if (template[i] === '(') depth++;
            else if (template[i] === ')') depth--;
            i++;
        }
        const condition = template.slice(start, i - 1).replace(/;\s*as\s+\w+\s*$/, '');
        add(`@${m[1]}`, `void (${stripPipes(condition)})`, m.index!, template.slice(m.index!, i));
    }
    return result;
}

function stripPipes(expression: string): string {
    return expression.replace(/\s\|\s*[a-zA-Z]\w*(:[^|]*)?/g, '');
}

/** Template expressions use the component's members without `this.`. */
function implicitThis(code: string, members: Set<string>): string | undefined {
    const sf = ts.createSourceFile('binding.ts', code, ts.ScriptTarget.Latest, true);
    if ((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics?.length) return undefined;
    const edits: number[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && members.has(n.text)) {
            const p = n.parent;
            const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isShorthandPropertyAssignment(p);
            if (!isName) edits.push(n.getStart(sf));
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    let out = code;
    for (const at of edits.sort((a, b) => b - a)) out = `${out.slice(0, at)}this.${out.slice(at)}`;
    return out.replace(/\n/g, ' ');
}
