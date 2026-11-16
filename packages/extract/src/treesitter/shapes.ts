/** Code shape of the tree-sitter languages: class, interface, function, module and instantiation facts. */
import type { ClassFact, FieldFact, FunctionFact, InstantiationFact, InterfaceFact, MethodFact, ModuleFact } from '../ir.js';
import type { ClassRec, FileRec } from './records.js';
import { complexityOf } from './complexity.js';
import { ancestorOf, descendants, escape, header, IMPLICIT_THIS, importSpec, lastLine, locOf, nameOf, walk } from './syntax.js';


export function classFact(recs: FileRec[], r: FileRec, cls: ClassRec): ClassFact {
    const p = r.profile;
    const selfTok = p.self.source.replace(/^\^/, '');
    const fieldNames = [...cls.fields.keys()];
    const methodNames = cls.methods.map(m => m.name);
    const methods: MethodFact[] = cls.methods.map(m => {
        const body = m.body?.text ?? '';
        const fieldRef = (f: string) => `(?:${selfTok}|${m.receiver ? `${m.receiver}\\.` : '(?!)'}|(?<![\\w.]))${escape(f)}\\b`;
        const calls = new Set<string>();
        for (const x of body.matchAll(new RegExp(`(?:${selfTok})(\\w+)\\s*\\(`, 'g'))) calls.add(x[1]);
        if (IMPLICIT_THIS.has(p.id)) for (const name of methodNames) if (new RegExp(`(?<![\\w.])${escape(name)}\\s*\\(`).test(body)) calls.add(name);
        if (m.receiver) for (const x of body.matchAll(new RegExp(`\\b${m.receiver}\\.(\\w+)\\s*\\(`, 'g'))) calls.add(x[1]);
        const returnTexts = [...body.matchAll(/\breturn\b([^;\n]*)/g)].map(x => x[1]).concat(p.id === 'rust' || p.id === 'kotlin' || p.id === 'scala' || p.id === 'ruby' || p.id === 'r' ? [lastLine(body)] : []);
        const creations = new Set<string>();
        for (const t of returnTexts) for (const x of t.matchAll(new RegExp(p.creation.source, 'g'))) creations.add((x[1] ?? x[2])!);
        const statements = body.replace(/^\s*\{|\}\s*$/g, '').split(/;|\n/).map(s => s.trim()).filter(s => s && !/^(\/\/|#|--)/.test(s));
        const single = statements.length === 1 ? statements[0] : '';
        const delegate = new RegExp(`^(?:return\\s+)?(?:await\\s+)?(?:${selfTok})?(\\w+)\\s*(?:\\.|->|\\$)\\s*\\w+\\s*\\(`).exec(single)?.[1];
        return {
            name: m.name,
            visibility: m.visibility,
            static: m.static,
            abstract: m.abstract,
            loc: locOf(r, m.node),
            lines: m.node.endPosition.row - m.node.startPosition.row + 1,
            params: m.params.length,
            returnsThis: /\breturn\s+(this|self|\$this)\b/.test(body) || (p.id === 'rust' && /->\s*Self\b/.test(header(m.node)) && /\bself\s*\}?\s*$/.test(body.trim())) || (p.id === 'kotlin' && /=\s*(this|apply\s*\{)/.test(header(m.node) + body)) || (p.id === 'ruby' && /\bself\s*$/.test(body.trim().replace(/\bend$/, '').trim())),
            returnsNew: [...creations].filter(Boolean),
            returnsFunction: new RegExp(`\\breturn\\s+(${p.lambda.source})`).test(body) || /\breturn\s+(fun|function|func|lambda)\b/.test(body),
            calls: [...calls].filter(c => methodNames.includes(c)),
            iteratesAndCalls: fieldNames.filter(f => new RegExp(`\\bfor\\b[^\\n{]*\\b(in|:|of)\\s*(?:${selfTok})?${escape(f)}\\b|${fieldRef(f)}\\s*(?:\\.|->)\\s*(forEach|each|for_each|iter\\(\\)\\.for_each|map\\s*\\{)`).test(body)),
            addsParamTo: fieldNames.filter(f => m.params.some(par => new RegExp(`${fieldRef(f)}\\s*(?:\\.|->)\\s*(add|push|push_back|emplace_back|append|insert|put|offer|Add|addObserver)\\s*\\(\\s*&?${escape(par)}\\b|${fieldRef(f)}\\s*<<\\s*${escape(par)}\\b|${fieldRef(f)}\\s*=\\s*append\\(\\s*\\S*${escape(f)}\\s*,\\s*${escape(par)}\\b|${fieldRef(f)}\\s*\\+=\\s*${escape(par)}\\b`).test(body))),
            removesFrom: fieldNames.filter(f => new RegExp(`${fieldRef(f)}\\s*(?:\\.|->)\\s*(remove\\w*|erase|delete|discard|clear|retain|Remove\\w*)\\b|${fieldRef(f)}\\s*-=|${fieldRef(f)}\\s*=\\s*\\S*${escape(f)}\\s*(?:\\.|->)\\s*(filter|filterNot|reject|select)\\b`).test(body)),
            delegatesTo: delegate && fieldNames.includes(delegate) ? delegate : undefined,
            notImplemented: p.notImplemented.test(body) && statements.length <= 2,
            assigns: fieldNames.filter(f => new RegExp(`${fieldRef(f)}\\s*=[^=]`).test(body)),
            validates: /\bif\b[^\n]*(\n\s*)?[{:]?\s*(throw|raise|panic!?|stop\(|return\s+Err|fatalError)|\b(require|check|precondition|assert)\s*\(/.test(body)
        };
    });
    const ctor = cls.methods.find(m => m.ctor);
    const fields: FieldFact[] = [...cls.fields.values()].map(f => ({ name: f.name, visibility: f.visibility, readonly: f.readonly, static: f.static, type: f.type }));
    let singleton = cls.singleton;
    if (p.id === 'rust' && p.singleton?.test(r.text) && new RegExp(`(OnceLock|OnceCell|Lazy)<\\s*(Mutex<\\s*)?${cls.name}\\b|lazy_static![\\s\\S]*:\\s*(Mutex<\\s*)?${cls.name}\\b`).test(r.text)) singleton = true;
    if (p.id === 'go' && new RegExp(`sync\\.Once[\\s\\S]*\\*?${cls.name}\\b|var\\s+\\w+\\s+\\*${cls.name}\\b[\\s\\S]*sync\\.Once`).test(r.text)) singleton = true;
    return {
        id: cls.id,
        name: cls.name,
        language: p.id,
        loc: locOf(r, cls.node),
        lines: cls.node.endPosition.row - cls.node.startPosition.row + 1,
        abstract: cls.abstract,
        extends: cls.extends,
        implements: cls.implements,
        decorators: cls.decorators,
        providedInRoot: false,
        privateConstructor: !!ctor && ctor.visibility === 'private',
        fields,
        methods,
        declaredSingleton: singleton || undefined
    };
}

export function interfaceFacts(r: FileRec): InterfaceFact[] {
    const out: InterfaceFact[] = [];
    const p = r.profile;
    const nodes = [...descendants(r.tree.rootNode, ...p.interfaces)];
    if (p.id === 'kotlin') nodes.push(...descendants(r.tree.rootNode, 'class_declaration').filter(n => /^\s*(\w+\s+)*(fun\s+)?interface\b/.test(n.text)));
    if (p.id === 'go') nodes.push(...descendants(r.tree.rootNode, 'type_spec').filter(n => n.childForFieldName('type')?.type === 'interface_type'));
    for (const n of nodes) {
        const name = nameOf(n);
        if (!name) continue;
        const methods = [...new Set(walk(n).filter(x => x.id !== n.id && /method|function|signature|func|method_elem|method_spec/.test(x.type) && !/call|parameters|type$/.test(x.type)).map(x => nameOf(x)).filter((x): x is string => !!x))];
        out.push({ name, loc: locOf(r, n), language: p.id, methods, callable: /^\s*(\w+\s+)*fun\s+interface\b/.test(n.text) || (methods.length === 1 && /@FunctionalInterface/.test(header(n))) });
    }
    return out;
}


export function functionFacts(r: FileRec): FunctionFact[] {
    const p = r.profile;
    const selfTok = p.self.source.replace(/^\^/, '');
    const globals = [...r.globals.keys()];
    const all = [...r.classes.flatMap(c => c.methods.map(m => ({ m, cls: c as ClassRec | undefined }))), ...r.functions.map(m => ({ m, cls: undefined as ClassRec | undefined }))];
    return all
        .filter(({ m }) => m.name !== 'anonymous')
        .map(({ m, cls }) => {
            const body = m.body?.text ?? '';
            const mutators = p.mutators.map(escape).join('|') || '(?!)';
            const mutates = m.params.filter(par => new RegExp(`\\b${escape(par)}\\s*(?:\\.|->|\\$)\\s*\\w+\\s*=[^=]|\\b${escape(par)}\\s*\\[[^\\]]*\\]\\s*=[^=]|\\b${escape(par)}\\s*(?:\\.|->)\\s*(${mutators})\\s*\\(|\\b${escape(par)}\\s*<<|\\(\\*${escape(par)}\\)\\s*(?:\\.|->)?\\s*\\w*\\s*=[^=]`).test(body));
            const outer = globals.filter(g => new RegExp(`(?<![\\w.$>])${escape(g)}\\s*(=[^=]|\\+\\+|--|[+\\-*/]=)`).test(body)).concat(p.id === 'r' ? [...body.matchAll(/(\w+)\s*<<-/g)].map(x => x[1]) : []).concat(p.id === 'ruby' ? [...body.matchAll(/\$(\w+)\s*=[^=]/g)].map(x => x[1]) : []);
            const effects = [...new Set([...body.matchAll(new RegExp(p.effects.source, 'g'))].map(x => x[0].replace(/\s*\($/, '')))];
            const exported = p.visibilityByName ? p.visibilityByName(m.name) === 'public' : m.visibility === 'public';
            return {
                id: `${r.file}#${cls ? `${cls.name}.` : ''}${m.name}`,
                name: m.name,
                loc: locOf(r, m.node),
                lines: m.node.endPosition.row - m.node.startPosition.row + 1,
                exported,
                free: !cls,
                params: m.params.length,
                higherOrder: p.lambda.test(body) || /(Function<|Callable|->\s*\w|func\s*\(|fn\s*\(|Fn\w*\(|\(\s*\w*\s*\)\s*->)/.test(m.node.childForFieldName('parameters')?.text ?? ''),
                mutatesParams: [...new Set(mutates)],
                writesOuter: [...new Set(outer)],
                effects,
                usesThis: new RegExp(selfTok).test(body) || (!!m.receiver && new RegExp(`\\b${m.receiver}\\.`).test(body)),
                complexity: complexityOf(m.node, m.name)
            };
        });
}


export function moduleFact(recs: FileRec[], r: FileRec): ModuleFact {
    const p = r.profile;
    const files = recs.map(x => x.file);
    const imports: ModuleFact['imports'] = [];
    for (const n of descendants(r.tree.rootNode, ...p.imports)) {
        const spec = importSpec(p, n);
        if (!spec) continue;
        let resolved: string | undefined;
        if (p.id === 'rust' && n.type === 'mod_item') {
            const dir = r.file.split('/').slice(0, -1).join('/');
            resolved = files.find(f => f === `${dir}/${spec}.rs` || f === `${dir}/${spec}/mod.rs`);
        } else {
            resolved = p.resolve(spec, r.file, files);
        }
        if (resolved === r.file) resolved = undefined;
        imports.push({ specifier: spec, resolved, loc: locOf(r, n), typeOnly: false });
    }
    const mutableGlobals: ModuleFact['mutableGlobals'] = [];
    for (const [name, f] of r.globals) if (!f.readonly && !(p.id === 'rust' && !/\bmut\b/.test(r.text.split('\n')[f.loc.line - 1] ?? ''))) mutableGlobals.push({ name, loc: f.loc });
    for (const c of r.classes) for (const f of c.fields.values()) if (f.static && !f.readonly && !c.singleton) mutableGlobals.push({ name: `${c.name}.${f.name}`, loc: f.loc });
    if (p.id === 'ruby') for (const m of r.text.matchAll(/^\s*\$(\w+)\s*=[^=]/gm)) mutableGlobals.push({ name: `$${m[1]}`, loc: { file: r.file, line: r.text.slice(0, m.index).split('\n').length } });
    let mutations = 0;
    for (const n of descendants(r.tree.rootNode, ...p.assignments)) {
        const lhs = (n.childForFieldName('left') ?? n.childForFieldName('lhs') ?? n.childForFieldName('target') ?? n.namedChildren[0])?.text ?? '';
        if (/[.[\]$]|->/.test(lhs) && !p.self.test(lhs)) mutations++;
    }
    return {
        file: r.file,
        language: p.id,
        lines: r.text.split('\n').length,
        imports,
        mutableGlobals,
        mutations,
        reassignments: 0,
        immutableDeclarations: (r.text.match(/\b(final|const|val|let|readonly)\b/g) ?? []).length,
        isTest: r.test
    };
}

export function instantiationFacts(recs: FileRec[], classesByName: Map<string, ClassRec[]>, r: FileRec): InstantiationFact[] {
    const out: InstantiationFact[] = [];
    const p = r.profile;
    const known = classesByName;
    for (const m of r.text.matchAll(new RegExp(p.creation.source, 'g'))) {
        const name = m[1] ?? m[2];
        if (!name || !(known.get(name) ?? []).some(c => recs.find(x => x.file === c.file)?.profile.id === p.id)) continue;
        const node = r.tree.rootNode.descendantForIndex(m.index!);
        const fn = node && ancestorOf(node, p.functions);
        const cls = node && ancestorOf(node, p.classes);
        const owner = fn ? recs.flatMap(x => x.classes).find(c => c.methods.some(mm => mm.node.id === fn.id)) : undefined;
        out.push({
            className: name,
            language: p.id,
            loc: { file: r.file, line: r.text.slice(0, m.index).split('\n').length },
            inClass: owner?.name ?? (cls ? nameOf(cls) : undefined),
            inMember: fn ? nameOf(fn) ?? undefined : undefined,
            inTest: r.test
        });
    }
    return out;
}
