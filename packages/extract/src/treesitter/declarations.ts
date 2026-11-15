/** Declarations of a set of files: enums, classes (fields, methods, bases), free functions and module variables. */
import type { Node } from 'web-tree-sitter';
import type { FieldFact } from '../ir.js';
import type { ClassRec, Field, FileRec, Method } from './records.js';
import { ancestorOf, argumentsOf, cppAccess, descendants, enumName, findChild, header, isTopLevel, lastIdent, lastNamed, locOf, modifiersText, nameOf, nearestOf, paramsOf, typeText, valueOf, walk } from './syntax.js';

export class Declarations {
    /** Enums declared in each language: name, members, file. */
    readonly enumDecls = new Map<string, Array<{ name: string; members: string[]; file: string }>>();

    constructor(private readonly recs: FileRec[]) {}


    declareEnum(r: FileRec, name: string, members: string[]): void {
        const list = this.enumDecls.get(r.profile.id) ?? [];
        const existing = list.find(e => e.name === name && e.file === r.file);
        if (existing) existing.members = [...new Set([...existing.members, ...members])];
        else list.push({ name, members, file: r.file });
        this.enumDecls.set(r.profile.id, list);
    }


    collectEnums(r: FileRec): void {
        const p = r.profile;
        for (const spec of p.enums) {
            for (const n of descendants(r.tree.rootNode, spec.node)) {
                if (spec.when && !spec.when.test(n.text)) continue;
                const name = enumName(n);
                if (!name) continue;
                const members = descendants(n, spec.member).flatMap(m => {
                    const names = m.childrenForFieldName('name').filter((x): x is Node => !!x);
                    return names.length > 1 ? names.map(x => x.text) : [nameOf(m) ?? ''];
                });
                const clean = [...new Set(members.filter(Boolean))];
                if (clean.length >= 2) this.declareEnum(r, name, clean);
            }
        }
        if (p.id === 'go') {
            // const ( Idle State = iota; Running ) and const ( A State = "a"; B State = "b" )
            for (const decl of descendants(r.tree.rootNode, 'const_declaration')) {
                let current: string | undefined;
                for (const spec of decl.namedChildren.filter(c => c?.type === 'const_spec') as Node[]) {
                    const type = spec.childForFieldName('type')?.text;
                    if (type) current = type;
                    else if (spec.childForFieldName('value')) current = undefined;
                    const name = spec.childForFieldName('name')?.text;
                    if (current && name && /^\w+$/.test(current)) this.declareEnum(r, current, [name]);
                }
            }
        }
        if (p.id === 'scala') {
            // sealed trait State; case object Idle extends State
            for (const obj of descendants(r.tree.rootNode, 'object_definition')) {
                if (!/^\s*case\s+object\b/.test(obj.text) && !/\bcase\s*$/.test(r.text.slice(Math.max(0, obj.startIndex - 6), obj.startIndex))) continue;
                const base = /\bextends\s+([A-Z]\w*)/.exec(obj.text)?.[1];
                const name = nameOf(obj);
                if (base && name) this.declareEnum(r, base, [name]);
            }
        }
    }


    collectDeclarations(r: FileRec): void {
        this.collectClasses(r);
        if (r.profile.id === 'r') this.collectRClasses(r);
        for (const cls of r.classes) this.collectFields(r, cls);
        // Methods and free functions.
        for (const fn of descendants(r.tree.rootNode, ...r.profile.functions)) {
            const method = this.methodOf(r, fn);
            if (!method) continue;
            const owner = this.ownerOf(r, fn, method);
            if (owner) owner.methods.push(method);
            else r.functions.push(method);
        }
        if (r.profile.id === 'r') this.collectRFunctions(r);
        this.collectGlobals(r);
        if (r.profile.id === 'ruby') this.collectRubyFields(r);
    }

    /** Classes, structs, objects. */
    collectClasses(r: FileRec): void {
        const p = r.profile;
        for (const n of descendants(r.tree.rootNode, ...p.classes)) {
            if (!isClassLike(p.id, n)) continue;
            const name = nameOf(n);
            if (!name) continue;
            const caseObject = /\bcase\s*$/.test(r.text.slice(Math.max(0, n.startIndex - 6), n.startIndex)) || /^\s*case\b/.test(n.text);
            if (n.type === 'object_definition' && caseObject) continue; // an enumeration value, not a class
            const cls: ClassRec = { id: `${r.file}#${name}`, name, node: n, file: r.file, fields: new Map(), methods: [], implements: [], decorators: [], singleton: false, abstract: /^\s*(\w+\s+)*(abstract|sealed)\b/.test(header(n)) };
            this.bases(r, n, cls);
            cls.singleton = n.type === 'object_declaration' || n.type === 'object_definition' || (!!p.singleton && p.id !== 'rust' && p.singleton.test(p.id === 'swift' || p.id === 'ruby' ? n.text : header(n)));
            cls.decorators = [...header(n).matchAll(/@(\w+)/g)].map(m => m[1]);
            r.classes.push(cls);
        }
    }

    /** The fields of a class: declared in its body, and Kotlin/Scala primary constructor properties. */
    collectFields(r: FileRec, cls: ClassRec): void {
        for (const f of this.bodyFields(r, cls)) cls.fields.set(f.name, f);
        // class Job(private var state: State = State.IDLE)
        for (const n of walk(cls.node).filter(n => n.type === 'class_parameter' && /\b(var|val)\b/.test(n.text))) {
            const name = nameOf(n);
            if (name) cls.fields.set(name, { name, type: typeText(n.childForFieldName('type') ?? n.namedChildren.find(c => c?.type === 'user_type') ?? undefined), init: lastNamed(n), loc: locOf(r, n), visibility: /private/.test(n.text) ? 'private' : 'public', static: false, readonly: /\bval\b/.test(n.text) });
        }
    }

    /** Fields declared in a class's own body (not in nested classes or methods); C++ access sections set their visibility. */
    bodyFields(r: FileRec, cls: ClassRec): Field[] {
        const p = r.profile;
        const classNodes = new Set(p.classes);
        let access: FieldFact['visibility'] = p.id === 'cpp' && cls.node.type === 'class_specifier' ? 'private' : 'public';
        const out: Field[] = [];
        for (const n of walk(cls.node.childForFieldName('body') ?? cls.node)) {
            if (n.type === 'access_specifier') access = accessOf(n.text);
            const own = p.fields.includes(n.type) && nearestOf(n.parent, classNodes)?.id === cls.node.id && !ancestorOf(n, p.functions);
            if (own) out.push(...this.fieldsOf(r, n, p.id === 'cpp' ? access : undefined));
        }
        return out;
    }

    /** Module-level variables (not extern declarations or function prototypes in C/C++). */
    collectGlobals(r: FileRec): void {
        const p = r.profile;
        for (const n of descendants(r.tree.rootNode, ...p.globals)) {
            if (!isTopLevel(n, p)) continue;
            if ((p.id === 'c' || p.id === 'cpp') && (/\bextern\b/.test(n.text) || descendants(n, 'function_declarator').length > 0)) continue;
            for (const f of this.fieldsOf(r, n)) r.globals.set(f.name, f);
        }
    }

    /** Ruby: instance variables are the fields. */
    collectRubyFields(r: FileRec): void {
        for (const cls of r.classes) {
            for (const iv of descendants(cls.node, 'instance_variable')) {
                const name = iv.text.replace(/^@/, '');
                if (!cls.fields.has(name)) cls.fields.set(name, { name, loc: locOf(r, iv), visibility: 'private', static: false, readonly: false });
            }
        }
    }

    /** R6Class("Job", public = list(state = "queued", start = function() ...)) and setRefClass(). */
    collectRClasses(r: FileRec): void {
        for (const call of descendants(r.tree.rootNode, 'call')) {
            const fn = call.childForFieldName('function')?.text;
            if (!fn || !/^(R6::)?R6Class$|^setRefClass$/.test(fn)) continue;
            const args = argumentsOf(call);
            const nameArg = args.find(a => !a.name && a.value?.type === 'string');
            const name = nameArg?.value?.text.replace(/^["']|["']$/g, '') ?? (call.parent?.type === 'binary_operator' ? call.parent.childForFieldName('lhs')?.text : undefined);
            if (!name) continue;
            const cls: ClassRec = { id: `${r.file}#${name}`, name, node: call, file: r.file, fields: new Map(), methods: [], implements: [], decorators: [], singleton: false, abstract: false };
            const inherit = args.find(a => a.name === 'inherit' || a.name === 'contains');
            if (inherit?.value) cls.extends = inherit.value.text.replace(/^["']|["']$/g, '');
            for (const section of args.filter(a => ['public', 'private', 'active', 'fields', 'methods'].includes(a.name ?? ''))) {
                if (!section.value) continue;
                for (const member of argumentsOf(section.value)) {
                    if (!member.name || !member.value) continue;
                    const visibility = section.name === 'private' ? 'private' : 'public';
                    if (member.value.type === 'function_definition') {
                        cls.methods.push({ name: member.name, node: member.value, body: member.value.childForFieldName('body') ?? undefined, params: paramsOf(member.value), visibility, static: false, abstract: false, ctor: member.name === 'initialize' });
                    } else {
                        cls.fields.set(member.name, { name: member.name, init: member.value, loc: locOf(r, member.value), visibility, static: false, readonly: false });
                    }
                }
            }
            r.classes.push(cls);
        }
    }

    /** Top-level `f <- function(...)` in R. */
    collectRFunctions(r: FileRec): void {
        r.functions = r.functions.filter(f => !r.classes.some(c => c.methods.some(m => m.node.id === f.node.id)));
        for (const f of r.functions) {
            if (f.name === 'anonymous' && f.node.parent?.type === 'binary_operator') f.name = f.node.parent.childForFieldName('lhs')?.text ?? f.name;
        }
    }

    fieldsOf(r: FileRec, n: Node, access?: FieldFact['visibility']): Field[] {
        const p = r.profile;
        const mods = modifiersText(n);
        const visibility: FieldFact['visibility'] = access ?? (/\bprivate\b|\bfileprivate\b/.test(mods) ? 'private' : /\bprotected\b/.test(mods) ? 'protected' : /\bpublic\b|\bpub\b/.test(mods) ? 'public' : p.defaultVisibility);
        const isStatic = /\bstatic\b|\bconst\b/.test(mods) && p.id !== 'rust';
        const readonly = /\b(final|readonly|const|val|let)\b/.test(mods + ' ' + n.text.split(/[=:{]/)[0]) && !/\bmut\b|\bvar\b/.test(n.text.split('=')[0]);
        const type = typeText(n.childForFieldName('type') ?? findChild(n, ['type_annotation', 'user_type', 'named_type', 'type_identifier']) ?? n.childForFieldName('declarator')?.childForFieldName('type') ?? undefined);
        const out: Field[] = [];
        const named = n.childrenForFieldName('name').filter((x): x is Node => !!x && x.type === 'pattern');
        const declarators = [...n.childrenForFieldName('declarator'), ...named, ...n.namedChildren.filter(c => c && /^(variable_declarator|variable_declaration|property_element|init_declarator)$/.test(c.type))].filter((x): x is Node => !!x);
        const expanded = declarators.flatMap(d => {
            const inner = d.namedChildren.filter((c): c is Node => !!c && c.type === 'variable_declarator');
            return inner.length > 0 ? inner : [d];
        });
        const unique = [...new Map(expanded.map(d => [d.id, d])).values()];
        if (unique.length === 0) {
            const name = nameOf(n);
            if (name) out.push({ name, type, init: valueOf(n), loc: locOf(r, n), visibility, static: isStatic, readonly });
        }
        for (const d of unique) {
            const name = nameOf(d) ?? lastIdent(d.text);
            if (!name) continue;
            const init = valueOf(d) ?? (unique.length === 1 ? valueOf(n) : undefined) ?? (d.namedChildren.find(c => c?.type === 'equals_value_clause') ? lastNamed(d.namedChildren.find(c => c?.type === 'equals_value_clause')!) : undefined);
            const t = type ?? typeText(d.childForFieldName('type') ?? findChild(d, ['user_type', 'type_identifier']) ?? undefined);
            out.push({ name, type: t, init, loc: locOf(r, d), visibility, static: isStatic, readonly });
        }
        return out.filter((f, i) => out.findIndex(g => g.name === f.name) === i);
    }

    methodOf(r: FileRec, fn: Node): Method | undefined {
        const p = r.profile;
        let name = nameOf(fn) ?? 'anonymous';
        if (p.id === 'r') {
            const parent = fn.parent;
            name = parent?.type === 'binary_operator' ? parent.childForFieldName('lhs')?.text ?? 'anonymous' : parent?.type === 'argument' ? parent.childForFieldName('name')?.text ?? 'anonymous' : 'anonymous';
        }
        if (fn.type === 'constructor_declaration' || fn.type === 'secondary_constructor' || fn.type === 'init_declaration') name = 'constructor';
        if (fn.type === 'deinit_declaration') name = 'deinit';
        if (fn.type === 'destructor_declaration') name = `~${name}`;
        const mods = modifiersText(fn) + ' ' + header(fn);
        let visibility: FieldFact['visibility'] = /\bprivate\b|\bfileprivate\b/.test(mods) ? 'private' : /\bprotected\b/.test(mods) ? 'protected' : /\bpublic\b|\bpub\b|\binternal\b/.test(mods) ? 'public' : p.defaultVisibility;
        if (p.visibilityByName) visibility = p.visibilityByName(name);
        if (p.id === 'cpp') visibility = cppAccess(fn);
        if (p.id === 'ruby' && /^_/.test(name)) visibility = 'private';
        if (p.id === 'c' && /\bstatic\b/.test(header(fn))) visibility = 'private';
        const params = paramsOf(fn);
        const receiver = p.id === 'go' ? fn.childForFieldName('receiver')?.namedChildren.find(c => c?.type === 'parameter_declaration')?.childForFieldName('name')?.text : undefined;
        const isStatic = /\bstatic\b/.test(mods) || (p.id === 'rust' && !descendants(fn.childForFieldName('parameters') ?? fn, 'self_parameter').length) || fn.type === 'singleton_method';
        return {
            name,
            node: fn,
            body: fn.childForFieldName('body') ?? lastNamed(fn),
            params,
            visibility,
            static: isStatic,
            abstract: /\babstract\b/.test(mods) || !fn.childForFieldName('body'),
            ctor: name === 'constructor' || p.constructors.includes(name),
            receiver
        };
    }

    ownerOf(r: FileRec, fn: Node, method: Method): ClassRec | undefined {
        const p = r.profile;
        if (p.id === 'go') {
            const recv = fn.childForFieldName('receiver')?.text.match(/\*?\s*([A-Z_a-z]\w*)\s*\)\s*$/)?.[1];
            return recv ? r.classes.find(c => c.name === recv) ?? this.recs.flatMap(x => x.classes).find(c => c.name === recv) : undefined;
        }
        if (p.impls) {
            const impl = ancestorOf(fn, p.impls);
            if (impl) {
                const type = typeText(impl.childForFieldName('type') ?? undefined);
                const cls = r.classes.find(c => c.name === type) ?? this.recs.flatMap(x => x.classes).find(c => c.name === type);
                const trait = typeText(impl.childForFieldName('trait') ?? undefined);
                if (cls && trait && !cls.implements.includes(trait)) cls.implements.push(trait);
                return cls;
            }
        }
        const container = ancestorOf(fn, p.classes);
        if (container) {
            const cls = r.classes.find(c => c.node.startIndex === container.startIndex && c.node.endIndex === container.endIndex);
            if (cls) return cls;
        }
        if ((p.id === 'cpp' || p.id === 'c') && /::/.test(fn.childForFieldName('declarator')?.text ?? '')) {
            const owner = /(\w+)::~?\w+\s*\(/.exec(fn.childForFieldName('declarator')!.text)?.[1];
            if (owner) return this.recs.flatMap(x => x.classes).find(c => c.name === owner);
        }
        void method;
        return undefined;
    }

    bases(r: FileRec, n: Node, cls: ClassRec): void {
        const p = r.profile;
        const names = (x: Node | null | undefined) => (x ? [...x.text.matchAll(/(?<![\w.])([A-Z]\w*)/g)].map(m => m[1]) : []);
        if (p.id === 'java' || p.id === 'groovy') {
            cls.extends = names(n.childForFieldName('superclass'))[0];
            cls.implements = names(n.childForFieldName('interfaces'));
            return;
        }
        if (p.id === 'php') {
            cls.extends = names(findChild(n, ['base_clause']))[0];
            cls.implements = names(findChild(n, ['class_interface_clause']));
            return;
        }
        const clause = n.childForFieldName('superclass') ?? n.childForFieldName('bases') ?? n.childForFieldName('extend') ?? findChild(n, ['base_class_clause', 'base_list', 'superclass', 'extends_clause', 'inheritance_specifier']);
        let all = names(clause);
        if (p.id === 'kotlin') {
            const specs = n.namedChildren.filter(c => c?.type === 'delegation_specifier') as Node[];
            const withCtor = specs.find(s => descendants(s, 'constructor_invocation').length > 0);
            cls.extends = withCtor ? names(withCtor)[0] : undefined;
            cls.implements = specs.filter(s => s !== withCtor).flatMap(names);
            return;
        }
        if (p.id === 'swift') all = (n.namedChildren.filter(c => c?.type === 'inheritance_specifier') as Node[]).flatMap(names);
        if (p.id === 'scala') all = names(clause).concat((/\bwith\s+([A-Z]\w*)/g.exec(n.text) ?? []).slice(1));
        if (p.id === 'c_sharp') {
            cls.extends = all.find(b => !/^I[A-Z]/.test(b));
            cls.implements = all.filter(b => /^I[A-Z]/.test(b));
            return;
        }
        cls.extends = all[0];
        cls.implements = all.slice(1);
    }

}

/** A class-like node that really declares a class (not a Go non-struct type, nor a Kotlin/Swift interface or protocol). */
function isClassLike(language: string, n: Node): boolean {
    if (language === 'go') return n.childForFieldName('type')?.type === 'struct_type';
    if (language === 'kotlin' || language === 'swift') return !(/^\s*(\w+\s+)*(enum|interface|protocol)\s+(class\s+)?\w/.test(n.text) && /^\s*(\w+\s+)*(interface|protocol)\b/.test(n.text));
    return true;
}

function accessOf(text: string): FieldFact['visibility'] {
    return /private/.test(text) ? 'private' : /protected/.test(text) ? 'protected' : 'public';
}
