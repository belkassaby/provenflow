"""Python front end of `pflow extract`: reads Python files with the `ast` module and prints facts as JSON.

Usage: python3 python_facts.py <root> < request
(request: {"files": [...], "overrides": {file: text}} or one path relative to root per line)
The facts follow packages/extract/src/ir.ts.
"""
import ast
import json
import os
import re
import sys

STATEISH = re.compile(r"(state|status|phase|stage|mode|step)$", re.I)
ENUM_BASES = {"Enum", "StrEnum", "IntEnum", "Flag", "IntFlag"}
MUTATORS = {"append", "extend", "insert", "pop", "remove", "clear", "sort", "reverse", "add", "discard", "update", "setdefault", "popitem"}
HIGHER_ORDER = {"map", "filter", "sorted", "reduce", "min", "max", "any", "all"}
EFFECT = re.compile(r"^(print|open|input|time\.|random\.|requests\.|os\.|subprocess\.|shutil\.|logging\.|urllib\.|socket\.|datetime\.now|sys\.(stdout|stderr|exit))")
DISPOSE = {"close", "__exit__", "__aexit__", "__del__", "stop", "shutdown", "dispose", "cleanup", "teardown", "disconnect"}


def is_test(path):
    return bool(re.search(r"(^|/)(test|tests)/", path) or re.search(r"(^|/)test_[^/]*\.py$", path) or path.endswith("_test.py") or path.endswith("conftest.py"))


def loc(file, node):
    return {"file": file, "line": getattr(node, "lineno", 1)}


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def is_function(node):
    return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))


LOOPS = (ast.For, ast.AsyncFor, ast.While)
MATCH = getattr(ast, "Match", ())
MATCH_CASE = getattr(ast, "match_case", ())


class Complexity:
    """Cognitive Complexity (SonarSource whitepaper v1.7), cyclomatic complexity and nesting depth of a function."""

    def __init__(self, fn):
        self.fn = fn
        self.cognitive, self.cyclomatic, self.nesting = 0, 1, 0

    def measure(self):
        for s in self.fn.body:
            self.visit(s, 0, 0)
        return {"cognitive": self.cognitive, "cyclomatic": self.cyclomatic, "nesting": self.nesting}

    def structural(self, nesting, depth):
        self.cognitive += 1 + nesting
        self.nesting = max(self.nesting, depth + 1)

    def children(self, node, nesting, depth):
        for c in ast.iter_child_nodes(node):
            self.visit(c, nesting, depth)

    def visit(self, node, nesting, depth):
        if isinstance(node, ast.If):
            return self.visit_if(node, nesting, depth, False)
        if isinstance(node, (ast.IfExp, ast.ExceptHandler) + LOOPS) or (MATCH and isinstance(node, MATCH)):
            return self.visit_structure(node, nesting, depth)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return  # measured on its own
        if isinstance(node, ast.Lambda):
            return self.children(node, nesting + 1, depth)
        self.increments(node)
        self.children(node, nesting, depth)

    def visit_if(self, node, nesting, depth, elif_):
        self.cyclomatic += 1
        if elif_:
            self.cognitive += 1
            self.nesting = max(self.nesting, depth + 1)
        else:
            self.structural(nesting, depth)
        self.visit(node.test, nesting + 1, depth + 1)
        for s in node.body:
            self.visit(s, nesting + 1, depth + 1)
        if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
            return self.visit_if(node.orelse[0], nesting, depth, True)
        if node.orelse:
            self.cognitive += 1
            for s in node.orelse:
                self.visit(s, nesting + 1, depth + 1)

    def visit_structure(self, node, nesting, depth):
        """Loops, conditional expressions, except clauses and match statements: +1 plus the nesting level."""
        if not (MATCH and isinstance(node, MATCH)):
            self.cyclomatic += 1
        self.structural(nesting, depth)
        self.children(node, nesting + 1, depth + 1)
        if isinstance(node, LOOPS) and node.orelse:
            self.cognitive += 1

    def increments(self, node):
        """Increments that do not nest: case clauses, boolean operator sequences, comprehension conditions, recursion."""
        if MATCH_CASE and isinstance(node, MATCH_CASE):
            self.cyclomatic += 1
        if isinstance(node, ast.BoolOp):
            # ast groups a sequence of like operators (a and b and c) into one BoolOp.
            self.cognitive += 1
            self.cyclomatic += len(node.values) - 1
        if isinstance(node, ast.comprehension):
            self.cyclomatic += len(node.ifs)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == self.fn.name:
            self.cognitive += 1


def complexity_of(fn):
    return Complexity(fn).measure()


class Parents(ast.NodeVisitor):
    def __init__(self, tree):
        self.parent = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                self.parent[child] = node


def contains(node, kinds, stop_at_functions=True):
    for child in ast.walk(node):
        if child is not node and stop_at_functions and is_function(child):
            continue
        if isinstance(child, kinds):
            return True
    return False


def contains_await(node):
    def visit(n):
        if n is not node and is_function(n):
            return False
        if isinstance(n, (ast.Await, ast.AsyncFor, ast.AsyncWith)):
            return True
        return any(visit(c) for c in ast.iter_child_nodes(n))
    return visit(node)


class Project:
    def __init__(self, root, files, overrides=None):
        self.overrides = overrides or {}
        self.root = root
        self.files = files
        self.trees = {}
        self.enums = {}  # enum class name -> [members]
        self.literal_aliases = {}  # alias name -> [values]
        self.facts = {k: [] for k in ["files", "modules", "stateVariables", "writes", "reads", "switches", "resources", "classes", "interfaces", "instantiations", "functions", "declaredMachines", "notes"]}
        self.state_vars = {}  # (class, attr) -> var dict
        self.attr_owner = {}  # attr -> set of classes with a state var of that name
        self.module_files = set(files)

    # ------------------------------------------------------------ pass 1
    def parse(self):
        for f in self.files:
            try:
                if f in self.overrides:
                    text = self.overrides[f]
                else:
                    with open(os.path.join(self.root, f), encoding="utf-8") as h:
                        text = h.read()
                self.trees[f] = (ast.parse(text, filename=f), text)
                self.facts["files"].append(f)
            except (SyntaxError, UnicodeDecodeError, ValueError) as e:
                self.facts["notes"].append(f"{f}: cannot parse: {e}")
        for f, (tree, _) in self.trees.items():
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef) and any(dotted(b) and dotted(b).split(".")[-1] in ENUM_BASES for b in node.bases):
                    members = []
                    for stmt in node.body:
                        if isinstance(stmt, ast.Assign):
                            members += [t.id for t in stmt.targets if isinstance(t, ast.Name) and not t.id.startswith("_")]
                        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
                            members.append(stmt.target.id)
                    if len(members) >= 2:
                        self.enums[node.name] = members
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                    values = self.literal_annotation(node.value)
                    if values:
                        self.literal_aliases[node.targets[0].id] = values
                if isinstance(node, ast.TypeAlias) if hasattr(ast, "TypeAlias") else False:
                    values = self.literal_annotation(node.value)
                    if values:
                        self.literal_aliases[node.name.id] = values

    def literal_annotation(self, ann):
        """Literal['a', 'b'], Optional[Literal[...]], an enum class or an alias of those."""
        if ann is None:
            return None
        if isinstance(ann, ast.Subscript):
            name = dotted(ann.value) or ""
            if name.split(".")[-1] == "Literal":
                elts = ann.slice.elts if isinstance(ann.slice, ast.Tuple) else [ann.slice]
                values = [e.value for e in elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                return values if len(values) >= 2 else None
            if name.split(".")[-1] == "Optional":
                return self.literal_annotation(ann.slice)
        if isinstance(ann, ast.BinOp) and isinstance(ann.op, ast.BitOr):
            return self.literal_annotation(ann.left) or self.literal_annotation(ann.right)
        name = dotted(ann)
        if name:
            short = name.split(".")[-1]
            if short in self.enums:
                return self.enums[short]
            if short in self.literal_aliases:
                return self.literal_aliases[short]
        return None

    def value_of(self, node):
        """Known values of an expression: enum members, string literals, conditional of those."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return [node.value]
        if isinstance(node, ast.Attribute) and isinstance(node.value, (ast.Name, ast.Attribute)):
            enum = (dotted(node.value) or "").split(".")[-1]
            if enum in self.enums and node.attr in self.enums[enum]:
                return [node.attr]
        if isinstance(node, ast.IfExp):
            a, b = self.value_of(node.body), self.value_of(node.orelse)
            if a is not None and b is not None:
                return a + [v for v in b if v not in a]
        return None

    def find_state_vars(self):
        """Attributes written with enum members or literals, or annotated with Literal/enum types."""
        for f, (tree, _) in self.trees.items():
            if is_test(f):
                continue
            for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name not in self.enums]:
                annotated, written = self.class_attributes(cls)
                for attr in set(annotated) | set(written):
                    domain = annotated[attr] + (False,) if attr in annotated else self.written_domain(attr, written[attr])
                    if domain:
                        self.add_state_var(f, cls, attr, *domain)

    def class_attributes(self, cls):
        """Attributes of a class annotated with a finite type, and the values written to self.<attr>."""
        annotated = {}
        for stmt in cls.body:
            values = self.literal_annotation(stmt.annotation) if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) else None
            if values:
                annotated[stmt.target.id] = (values, stmt)
        written = {}
        for node, attr in self.self_assignments(cls):
            values = self.literal_annotation(node.annotation) if isinstance(node, ast.AnnAssign) else None
            if values:
                annotated.setdefault(attr, (values, node))
            v = self.value_of(node.value) if node.value is not None else None
            if v is not None:
                written.setdefault(attr, []).append((v, node))
        return annotated, written

    @staticmethod
    def self_assignments(cls):
        """Each assignment to self.<attr> in a class, with the attribute."""
        for node in ast.walk(cls):
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                for t in (node.targets if isinstance(node, ast.Assign) else [node.target]):
                    if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self":
                        yield node, t.attr

    def written_domain(self, attr, writes):
        """The values of an attribute known only from its writes: its enum, or the literals written to a state-like name."""
        enum_domain = None
        for _, n in writes:
            if isinstance(n.value, ast.Attribute):
                enum_domain = self.enums.get((dotted(n.value.value) or "").split(".")[-1])
        if enum_domain:
            return enum_domain, writes[0][1], False
        if STATEISH.search(attr):
            return sorted({x for v, _ in writes for x in v}), writes[0][1], True
        return None

    def add_state_var(self, f, cls, attr, values, decl, inferred):
        self.state_vars[(f, cls.name, attr)] = {
            "id": f"{f}#{cls.name}.{attr}",
            "name": f"{cls.name}.{attr}",
            "language": "python",
            "values": list(values),
            "inferred": inferred,
            "initial": [],
            "loc": loc(f, decl),
            "owner": cls.name,
        }
        self.attr_owner.setdefault(attr, set()).add((f, cls.name, attr))

    # ------------------------------------------------------------ pass 2
    def run(self):
        self.parse()
        self.find_state_vars()
        for f, (tree, text) in self.trees.items():
            FileVisitor(self, f, tree, text).run()
        for var in self.state_vars.values():
            if var["inferred"]:
                extra = {t for w in self.facts["writes"] if w["variable"] == var["id"] for t in (w["targets"] or [])}
                var["values"] = sorted(set(var["values"]) | extra | set(var["initial"]))
            if any(w["variable"] == var["id"] for w in self.facts["writes"]):
                self.facts["stateVariables"].append(var)
        known = {v["id"] for v in self.facts["stateVariables"]}
        self.facts["writes"] = [w for w in self.facts["writes"] if w["variable"] in known]
        self.facts["reads"] = [r for r in self.facts["reads"] if r["variable"] in known]
        return self.facts


class FileVisitor:
    def __init__(self, project, file, tree, text):
        self.p = project
        self.file = file
        self.tree = tree
        self.lines = text.splitlines()
        self.parents = Parents(tree).parent
        self.test = is_test(file)

    def text(self, node):
        line = getattr(node, "lineno", 1) - 1
        return self.lines[line].strip() if 0 <= line < len(self.lines) else ""

    def enclosing_function(self, node):
        n = self.parents.get(node)
        while n is not None and not is_function(n):
            n = self.parents.get(n)
        return n

    def enclosing_class(self, node):
        n = self.parents.get(node)
        while n is not None and not isinstance(n, ast.ClassDef):
            n = self.parents.get(n)
        return n

    def event(self, node):
        fn = self.enclosing_function(node)
        callback = False
        while isinstance(fn, ast.Lambda):
            callback = True
            fn = self.enclosing_function(fn)
        if fn is None:
            return "module"
        cls = self.enclosing_class(fn)
        outer = self.enclosing_function(fn)
        if outer is not None and not isinstance(outer, ast.Lambda):
            callback = True
            name = outer.name
            cls = self.enclosing_class(outer)
        else:
            name = fn.name
        base = f"{cls.name}.{name}" if cls is not None else name
        return f"{base} (callback)" if callback else base

    # -------------------------------------------------------- state variables
    def state_var_of(self, node):
        """The state variable an attribute expression refers to."""
        if not isinstance(node, ast.Attribute):
            return None
        if isinstance(node.value, ast.Name) and node.value.id == "self":
            cls = self.enclosing_class(node)
            if cls is not None:
                for key in self.p.attr_owner.get(node.attr, ()):
                    if key[1] == cls.name:
                        return self.p.state_vars[key]
                # Inherited attribute of a base class.
                for base in cls.bases:
                    for key in self.p.attr_owner.get(node.attr, ()):
                        if key[1] == (dotted(base) or "").split(".")[-1]:
                            return self.p.state_vars[key]
            return None
        owners = self.p.attr_owner.get(node.attr, set())
        if len(owners) == 1:
            return self.p.state_vars[next(iter(owners))]
        return None

    def comparison(self, node):
        """(var, values, negated) for `x == V`, `x != V`, `x is V`, `x in (A, B)`."""
        if not isinstance(node, ast.Compare) or len(node.ops) != 1:
            return None
        left, op, right = node.left, node.ops[0], node.comparators[0]
        for a, b in ((left, right), (right, left)):
            var = self.state_var_of(a)
            if var is None:
                continue
            if isinstance(op, (ast.In, ast.NotIn)) and a is left and isinstance(b, (ast.Tuple, ast.List, ast.Set)):
                values = []
                for e in b.elts:
                    v = self.p.value_of(e)
                    if v is None:
                        return None
                    values += v
                return var, set(values), isinstance(op, ast.NotIn)
            v = self.p.value_of(b)
            if v is None:
                continue
            if isinstance(op, (ast.Eq, ast.Is)):
                return var, set(v), False
            if isinstance(op, (ast.NotEq, ast.IsNot)):
                return var, set(v), True
        return None

    def constraint(self, expr, var, positive):
        if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, ast.Not):
            return self.constraint(expr.operand, var, not positive)
        if isinstance(expr, ast.BoolOp):
            parts = [self.constraint(v, var, positive) for v in expr.values]
            conjunction = isinstance(expr.op, ast.And) == positive
            result = parts[0]
            for p in parts[1:]:
                result = intersect(result, p) if conjunction else union(result, p)
            return result
        leaf = self.comparison(expr)
        if leaf is None or leaf[0] is not var:
            return None
        _, values, negated = leaf
        holds = (not negated) if positive else negated
        return set(values) if holds else set(var["values"]) - set(values)

    def case_constraint(self, case, match, var):
        if self.state_var_of(match.subject) is not var:
            return None
        def values_of(pattern):
            if isinstance(pattern, ast.MatchValue):
                return self.p.value_of(pattern.value) or []
            if isinstance(pattern, ast.MatchOr):
                return [v for p in pattern.patterns for v in values_of(p)]
            return None
        vs = values_of(case.pattern)
        if vs is None:  # wildcard / capture: the values not listed before
            listed = {v for c in match.cases[: match.cases.index(case)] for v in (values_of(c.pattern) or [])}
            return set(var["values"]) - listed
        return set(vs)

    def definite_write(self, stmt, var):
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            if any(self.state_var_of(t) is var for t in targets) and stmt.value is not None:
                return self.p.value_of(stmt.value)
        return None

    def writes_in(self, node, var):
        out = []
        for n in ast.walk(node):
            if isinstance(n, (ast.Assign, ast.AnnAssign)):
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                if any(self.state_var_of(t) is var for t in targets):
                    out += (self.p.value_of(n.value) if n.value is not None else None) or var["values"]
        return out

    def sources_of(self, node, var):
        boundary = self.enclosing_function(node)
        allowed, extra, anchored = None, set(), False
        after_await = contains_await(node)
        current = node
        while current is not None and current is not boundary:
            parent = self.parents.get(current)
            if parent is None:
                break
            c = None
            if isinstance(parent, ast.If) and current is not parent.test:
                c = self.constraint(parent.test, var, current in parent.body)
            elif isinstance(parent, ast.IfExp) and current is not parent.test:
                c = self.constraint(parent.test, var, current is parent.body)
            elif isinstance(parent, ast.match_case):
                match = self.parents.get(parent)
                c = self.case_constraint(parent, match, var)
            elif isinstance(parent, ast.Try) and (current in parent.handlers or current in parent.finalbody or current in parent.orelse):
                for stmt in parent.body:
                    extra.update(self.writes_in(stmt, var))
                    if not anchored and contains_await(stmt):
                        after_await = True
            if c is not None:
                allowed = intersect(allowed, c)
                anchored = True
            if not anchored:
                for field in ("body", "orelse", "finalbody"):
                    block = getattr(parent, field, None)
                    if isinstance(block, list) and current in block:
                        for stmt in reversed(block[: block.index(current)]):
                            d = self.definite_write(stmt, var)
                            if d is not None:
                                allowed, anchored = intersect(set(d), allowed), True
                                break
                            if isinstance(stmt, ast.If) and not stmt.orelse and stmt.body and isinstance(stmt.body[-1], (ast.Return, ast.Raise, ast.Continue, ast.Break)):
                                g = self.constraint(stmt.test, var, False)
                                if g is not None:
                                    allowed, anchored = intersect(allowed, g), True
                                    break
                            extra.update(self.writes_in(stmt, var))
                            if contains_await(stmt):
                                after_await = True
            if parent is boundary:
                break
            current = parent
        if not anchored:
            return None, False
        return sorted(allowed | extra) if allowed is not None else None, after_await

    # ----------------------------------------------------------------- run
    def run(self):
        f = self.file
        p = self.p
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for t in targets:
                    var = self.state_var_of(t)
                    if var is None and isinstance(node, ast.AnnAssign) and isinstance(t, ast.Name):
                        cls = self.enclosing_class(node)
                        if cls is not None and self.parents.get(node) is cls:
                            key = (f, cls.name, t.id)
                            var = p.state_vars.get(key)
                            if var is not None and node.value is not None:
                                v = p.value_of(node.value)
                                if v:
                                    var["initial"] += [x for x in v if x not in var["initial"]]
                        continue
                    if var is None:
                        continue
                    fn = self.enclosing_function(node)
                    values = p.value_of(node.value) if node.value is not None else None
                    if isinstance(fn, ast.FunctionDef) and fn.name in ("__init__", "__post_init__") and self.enclosing_function(fn) is None:
                        if values:
                            var["initial"] += [x for x in values if x not in var["initial"]]
                        continue
                    sources, after_await = self.sources_of(node, var)
                    p.facts["writes"].append({
                        "variable": var["id"], "targets": values, "sources": sources, "event": self.event(node),
                        "loc": loc(f, node), "afterAwait": after_await, "text": self.text(node),
                    })
            elif isinstance(node, ast.Compare):
                leaf = self.comparison(node)
                if leaf:
                    p.facts["reads"].append({"variable": leaf[0]["id"], "values": sorted(leaf[1]), "loc": loc(f, node)})
            elif isinstance(node, ast.Match):
                var = self.state_var_of(node.subject)
                if var is not None:
                    cases, has_default = [], False
                    for case in node.cases:
                        c = case.pattern
                        pats = c.patterns if isinstance(c, ast.MatchOr) else [c]
                        for pat in pats:
                            if isinstance(pat, ast.MatchValue):
                                cases += p.value_of(pat.value) or []
                            elif isinstance(pat, ast.MatchAs) and pat.pattern is None:
                                has_default = True
                    p.facts["switches"].append({"subject": ast.unparse(node.subject), "variable": var["id"], "domain": var["values"], "cases": cases, "hasDefault": has_default, "loc": loc(f, node), "event": self.event(node)})
            elif isinstance(node, ast.ClassDef):
                self.class_fact(node)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.function_fact(node)
            elif isinstance(node, ast.Call):
                self.call_fact(node)
        self.module_fact()

    # --------------------------------------------------------------- resources
    def owner(self, node):
        fn = self.enclosing_function(node)
        while isinstance(fn, ast.Lambda):
            fn = self.enclosing_function(fn)
        cls = self.enclosing_class(node)
        member = fn.name if fn is not None else "module"
        if cls is not None:
            return f"{self.file}#{cls.name}", "class", member
        if fn is not None:
            return f"{self.file}#{fn.name}", "function", member
        return None

    def stored_handle(self, node):
        parent = self.parents.get(node)
        while isinstance(parent, ast.Await):
            node, parent = parent, self.parents.get(parent)
        if isinstance(parent, (ast.Assign, ast.AnnAssign)):
            targets = parent.targets if isinstance(parent, ast.Assign) else [parent.target]
            return dotted(targets[0])
        if isinstance(parent, ast.withitem):
            return "with"
        return None

    def in_finally(self, node):
        current = node
        while current is not None and not is_function(current):
            parent = self.parents.get(current)
            if isinstance(parent, ast.Try) and current in parent.finalbody:
                return True
            current = parent
        return False

    def call_fact(self, node):
        p = self.p
        name = dotted(node.func) or ""
        short = name.split(".")[-1]
        receiver = dotted(node.func.value) if isinstance(node.func, ast.Attribute) else None
        if short[:1].isupper() and isinstance(node.func, (ast.Name, ast.Attribute)):
            cls = self.enclosing_class(node)
            fn = self.enclosing_function(node)
            p.facts["instantiations"].append({"className": short, "loc": loc(self.file, node), "inClass": cls.name if cls else None, "inMember": fn.name if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) else None, "inTest": self.test})
        kind = op = handle = None
        if short == "open" and not receiver:
            kind, op = "file", "acquire"
        elif short in ("mkdtemp", "TemporaryDirectory") and receiver in ("tempfile", None):
            kind, op = "temp-dir", "acquire"
        elif short in ("rmtree",):
            kind, op, handle = "temp-dir", "release", ast.unparse(node.args[0]) if node.args else None
        elif short == "Popen":
            kind, op = "process", "acquire"
        elif short in ("kill", "terminate", "wait", "communicate") and receiver:
            kind, op, handle = "process", "release", receiver
        elif short == "acquire" and receiver:
            kind, op, handle = "lock", "acquire", receiver
        elif short == "release" and receiver:
            kind, op, handle = "lock", "release", receiver
        elif short == "subscribe" and receiver:
            kind, op = "subscription", "acquire"
        elif short == "unsubscribe" and receiver:
            kind, op, handle = "subscription", "release", receiver
        elif short == "close" and receiver and not node.args:
            op, handle = "release", receiver
        if op is None:
            return
        if op == "acquire":
            handle = self.stored_handle(node) if handle is None or kind != "lock" else handle
            if handle == "with":
                return  # released by the with statement
        owner = self.owner(node)
        if owner is None:
            return
        if kind is None:
            acquired = [r for r in p.facts["resources"] if r["op"] == "acquire" and r.get("handle") == handle and r["owner"] == owner[0]]
            if not acquired:
                return
            kind = acquired[0]["kind"]
        p.facts["resources"].append({
            "kind": kind, "op": op, "owner": owner[0], "ownerKind": owner[1], "member": owner[2], "loc": loc(self.file, node),
            "handle": handle, "guaranteed": op == "release" and self.in_finally(node), "text": self.text(node),
        })

    # ----------------------------------------------------------------- classes
    def class_fact(self, node):
        p = self.p
        bases = [dotted(b) or ast.unparse(b) for b in node.bases]
        shorts = [b.split(".")[-1] for b in bases]
        fields, methods = {}, []
        for stmt in node.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                fields[stmt.target.id] = {"name": stmt.target.id, "visibility": vis(stmt.target.id), "readonly": "Final" in ast.unparse(stmt.annotation), "static": "ClassVar" in ast.unparse(stmt.annotation), "type": ast.unparse(stmt.annotation)}
            elif isinstance(stmt, ast.Assign):
                for t in stmt.targets:
                    if isinstance(t, ast.Name):
                        fields[t.id] = {"name": t.id, "visibility": vis(t.id), "readonly": t.id.isupper(), "static": True}
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                methods.append(self.method_fact(stmt))
                for n in ast.walk(stmt):
                    if isinstance(n, (ast.Assign, ast.AnnAssign)):
                        for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                            if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self" and t.attr not in fields:
                                fields[t.attr] = {"name": t.attr, "visibility": vis(t.attr), "readonly": False, "static": False}
        decorators = [(dotted(d.func if isinstance(d, ast.Call) else d) or "").split(".")[-1] for d in node.decorator_list]
        is_interface = any(s in ("Protocol", "ABC") for s in shorts) or any("ABCMeta" in ast.unparse(k.value) for k in node.keywords)
        p.facts["classes"].append({
            "id": f"{self.file}#{node.name}", "name": node.name, "language": "python", "loc": loc(self.file, node),
            "lines": (node.end_lineno or node.lineno) - node.lineno + 1, "abstract": is_interface or any(m["abstract"] for m in methods),
            "extends": next((b for b, s in zip(bases, shorts) if s not in ("Protocol", "ABC", "object", "Generic")), None),
            "implements": [b for b, s in zip(bases, shorts) if s not in ("object",)][1:],
            "decorators": decorators, "providedInRoot": False, "privateConstructor": False,
            "fields": list(fields.values()), "methods": methods, "overridesNew": any(m["name"] == "__new__" for m in methods),
        })
        if is_interface and node.name not in p.enums:
            names = [m["name"] for m in methods if not m["name"].startswith("__") or m["name"] == "__call__"]
            p.facts["interfaces"].append({"name": node.name, "loc": loc(self.file, node), "language": "python", "methods": [n for n in names if n != "__call__"], "callable": names == ["__call__"]})
        if node.name in p.enums:
            return

    def method_fact(self, fn):
        params = [a.arg for a in fn.args.args[1:]] + [a.arg for a in fn.args.kwonlyargs]
        decorators = [(dotted(d.func if isinstance(d, ast.Call) else d) or "").split(".")[-1] for d in fn.decorator_list]
        fact = {
            "name": fn.name, "visibility": vis(fn.name), "static": "staticmethod" in decorators or "classmethod" in decorators,
            "abstract": "abstractmethod" in decorators, "loc": loc(self.file, fn), "lines": (fn.end_lineno or fn.lineno) - fn.lineno + 1,
            "params": len(params), "returnsThis": False, "returnsNew": [], "returnsFunction": False, "calls": [], "iteratesAndCalls": [], "addsParamTo": [],
            "removesFrom": [], "notImplemented": False, "assigns": [], "validates": False,
        }
        def self_field(e):
            return e.attr if isinstance(e, ast.Attribute) and isinstance(e.value, ast.Name) and e.value.id == "self" else None
        def add(key, v):
            if v and v not in fact[key]:
                fact[key].append(v)
        for n in ast.walk(fn):
            if isinstance(n, ast.Return) and n.value is not None:
                if isinstance(n.value, ast.Name) and n.value.id == "self":
                    fact["returnsThis"] = True
                if isinstance(n.value, ast.Lambda) or (isinstance(n.value, ast.Name) and any(isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name == n.value.id for s in fn.body)):
                    fact["returnsFunction"] = True
                if isinstance(n.value, ast.Call):
                    callee = (dotted(n.value.func) or "").split(".")[-1]
                    if callee[:1].isupper():
                        add("returnsNew", callee)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
                if isinstance(n.func.value, ast.Name) and n.func.value.id == "self":
                    add("calls", n.func.attr)
                field = self_field(n.func.value)
                if field:
                    if n.func.attr in ("append", "add", "insert") and any(isinstance(a, ast.Name) and a.id in params for a in n.args):
                        add("addsParamTo", field)
                    if n.func.attr in ("remove", "discard", "pop", "clear"):
                        add("removesFrom", field)
            if isinstance(n, (ast.For, ast.AsyncFor)) and self_field(n.iter) and isinstance(n.target, ast.Name):
                var = n.target.id
                if any(isinstance(c, ast.Call) and ((isinstance(c.func, ast.Name) and c.func.id == var) or (isinstance(c.func, ast.Attribute) and isinstance(c.func.value, ast.Name) and c.func.value.id == var)) for s in n.body for c in ast.walk(s)):
                    add("iteratesAndCalls", self_field(n.iter))
            if isinstance(n, (ast.Assign, ast.AugAssign)):
                for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                    field = self_field(t)
                    if field:
                        add("assigns", field)
                        if isinstance(n.value, (ast.ListComp, ast.SetComp)) and self_field(getattr(n.value.generators[0], "iter", None)) == field:
                            add("removesFrom", field)
            if isinstance(n, ast.If) and any(isinstance(s, ast.Raise) for s in n.body):
                fact["validates"] = True
        body = [s for s in fn.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str))]
        if len(body) == 1:
            only = body[0]
            if isinstance(only, ast.Raise) and "NotImplementedError" in ast.unparse(only):
                fact["notImplemented"] = True
            value = only.value if isinstance(only, (ast.Return, ast.Expr)) else None
            if isinstance(value, ast.Await):
                value = value.value
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute):
                field = self_field(value.func.value)
                if field:
                    fact["delegatesTo"] = field
        return fact

    # --------------------------------------------------------------- functions
    def function_fact(self, fn):
        cls = self.enclosing_class(fn)
        outer = self.enclosing_function(fn)
        params = [a.arg for a in fn.args.args + fn.args.kwonlyargs]
        own = set(params) - {"self", "cls"}
        mutates, outer_writes, effects = set(), set(), set()
        higher = any("Callable" in ast.unparse(a.annotation) for a in fn.args.args if a.annotation is not None) or (fn.returns is not None and "Callable" in ast.unparse(fn.returns))
        uses_self = False
        def root(e):
            while isinstance(e, (ast.Attribute, ast.Subscript)):
                e = e.value
            return e
        for n in ast.walk(fn):
            if isinstance(n, (ast.Global, ast.Nonlocal)):
                outer_writes.update(n.names)
            if isinstance(n, ast.Name) and n.id == "self":
                uses_self = True
            if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                    if isinstance(t, (ast.Attribute, ast.Subscript)):
                        r = root(t)
                        if isinstance(r, ast.Name) and r.id in own:
                            mutates.add(r.id)
            if isinstance(n, ast.Call):
                name = dotted(n.func) or ""
                if isinstance(n.func, ast.Attribute) and n.func.attr in MUTATORS:
                    r = root(n.func.value)
                    if isinstance(r, ast.Name) and r.id in own:
                        mutates.add(r.id)
                if name.split(".")[-1] in HIGHER_ORDER and any(isinstance(a, ast.Lambda) for a in n.args + [k.value for k in n.keywords]):
                    higher = True
                if EFFECT.match(name):
                    effects.add(name)
            if isinstance(n, ast.Return) and isinstance(n.value, ast.Lambda):
                higher = True
        if any(isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and isinstance(fn.body[-1], ast.Return) and isinstance(fn.body[-1].value, ast.Name) and fn.body[-1].value.id == s.name for s in fn.body):
            higher = True
        self.p.facts["functions"].append({
            "id": f"{self.file}#{fn.name}", "name": fn.name, "loc": loc(self.file, fn), "lines": (fn.end_lineno or fn.lineno) - fn.lineno + 1,
            "exported": not fn.name.startswith("_"), "free": cls is None and outer is None, "params": len(own), "higherOrder": higher,
            "mutatesParams": sorted(mutates), "writesOuter": sorted(outer_writes), "effects": sorted(effects), "usesThis": uses_self,
            "complexity": complexity_of(fn),
        })

    # ----------------------------------------------------------------- modules
    def resolve(self, module, level):
        parts = module.split(".") if module else []
        if level:
            base = os.path.dirname(self.file).split("/") if os.path.dirname(self.file) else []
            base = base[: len(base) - (level - 1)] if level > 1 else base
            parts = base + parts
        for candidate in ("/".join(parts) + ".py", "/".join(parts + ["__init__.py"])):
            if candidate in self.p.module_files:
                return candidate
            for prefix in ("src/",):
                if prefix + candidate in self.p.module_files:
                    return prefix + candidate
        return None

    def module_fact(self):
        imports, globals_, assigned = [], [], {}
        mutations = reassign = immutable = 0
        for stmt in self.tree.body:
            if isinstance(stmt, ast.Import):
                for a in stmt.names:
                    imports.append({"specifier": a.name, "resolved": self.resolve(a.name, 0), "loc": loc(self.file, stmt), "typeOnly": False})
            elif isinstance(stmt, ast.ImportFrom):
                imports.append({"specifier": ("." * stmt.level) + (stmt.module or ""), "resolved": self.resolve(stmt.module or "", stmt.level), "loc": loc(self.file, stmt), "typeOnly": False})
            elif isinstance(stmt, ast.If) and "TYPE_CHECKING" in ast.unparse(stmt.test):
                for s in stmt.body:
                    if isinstance(s, ast.ImportFrom):
                        imports.append({"specifier": ("." * s.level) + (s.module or ""), "resolved": self.resolve(s.module or "", s.level), "loc": loc(self.file, s), "typeOnly": True})
            elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                for t in (stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]):
                    if isinstance(t, ast.Name):
                        if t.id.isupper() or (isinstance(stmt, ast.AnnAssign) and "Final" in ast.unparse(stmt.annotation)):
                            immutable += 1
                        assigned.setdefault(t.id, []).append(stmt)
        declared_global = {name for n in ast.walk(self.tree) if isinstance(n, ast.Global) for name in n.names}
        for name, stmts in assigned.items():
            if len(stmts) > 1 or name in declared_global:
                globals_.append({"name": name, "loc": loc(self.file, stmts[0])})
        for n in ast.walk(self.tree):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                counts = {}
                for s in ast.walk(n):
                    if isinstance(s, (ast.Assign, ast.AugAssign)):
                        for t in (s.targets if isinstance(s, ast.Assign) else [s.target]):
                            if isinstance(t, ast.Name):
                                counts[t.id] = counts.get(t.id, 0) + 1
                            elif isinstance(t, (ast.Attribute, ast.Subscript)) and not (isinstance(t.value, ast.Name) and t.value.id == "self"):
                                mutations += 1
                    if isinstance(s, ast.Call) and isinstance(s.func, ast.Attribute) and s.func.attr in MUTATORS and not (isinstance(s.func.value, ast.Attribute) and isinstance(s.func.value.value, ast.Name) and s.func.value.value.id == "self"):
                        mutations += 1
                reassign += sum(c - 1 for c in counts.values() if c > 1)
        self.p.facts["modules"].append({
            "file": self.file, "language": "python", "lines": len(self.lines), "imports": imports, "mutableGlobals": globals_,
            "mutations": mutations, "reassignments": reassign, "immutableDeclarations": immutable, "isTest": self.test,
        })
        text = "\n".join(self.lines)
        if self.test:
            return
        if "StateGraph(" in text and re.search(r"^\s*(from|import)\s+langgraph", text, re.M):
            self.p.facts["declaredMachines"].append({"name": os.path.splitext(os.path.basename(self.file))[0], "loc": {"file": self.file, "line": 1}, "library": "langgraph", "text": text})
        elif re.search(r"@start\s*\(", text) and re.search(r"^\s*(from|import)\s+crewai", text, re.M):
            self.p.facts["declaredMachines"].append({"name": os.path.splitext(os.path.basename(self.file))[0], "loc": {"file": self.file, "line": 1}, "library": "crewai", "text": text})
        for n in ast.walk(self.tree):
            if isinstance(n, ast.Call) and (dotted(n.func) or "").split(".")[-1] in ("Machine", "HierarchicalMachine", "AsyncMachine") and any(k.arg == "transitions" for k in n.keywords):
                machine = self.transitions_machine(n)
                if machine:
                    self.p.facts["declaredMachines"].append(machine)

    def transitions_machine(self, call):
        """python-transitions: Machine(states=[...], transitions=[...], initial=...)."""
        kw = {k.arg: k.value for k in call.keywords}
        def literal(node):
            if node is None:
                return None
            if isinstance(node, ast.Name):
                for n in ast.walk(self.tree):
                    if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == node.id for t in n.targets):
                        node = n.value
            try:
                return ast.literal_eval(node)
            except (ValueError, SyntaxError, TypeError):
                return None
        states = literal(kw.get("states"))
        transitions = literal(kw.get("transitions"))
        if not isinstance(transitions, list):
            return None
        out = []
        for t in transitions:
            if isinstance(t, dict):
                trigger, source, dest = t.get("trigger"), t.get("source"), t.get("dest")
            elif isinstance(t, (list, tuple)) and len(t) >= 3:
                trigger, source, dest = t[0], t[1], t[2]
            else:
                continue
            for s in (source if isinstance(source, list) else [source]):
                if s == "*":
                    for st in states or []:
                        out.append({"source": st if isinstance(st, str) else st.get("name"), "target": dest, "event": trigger})
                else:
                    out.append({"source": s, "target": dest, "event": trigger})
        names = [s if isinstance(s, str) else s.get("name") for s in (states or [])]
        initial = literal(kw.get("initial"))
        cls = self.enclosing_class(call)
        return {"name": cls.name if cls else "machine", "loc": loc(self.file, call), "library": "transitions", "states": names, "initial": initial if isinstance(initial, str) else (names[0] if names else None), "transitions": out}


def vis(name):
    return "private" if name.startswith("__") and not name.endswith("__") else "protected" if name.startswith("_") and not name.startswith("__") else "public"


def union(a, b):
    if a is None or b is None:
        return None
    return a | b


def intersect(a, b):
    if a is None:
        return set(b) if b is not None else None
    if b is None:
        return set(a)
    return a & b


def main():
    root = sys.argv[1]
    data = sys.stdin.read()
    if data.lstrip().startswith("{"):
        request = json.loads(data)
        files, overrides = request["files"], request.get("overrides") or {}
    else:
        files, overrides = [l.strip() for l in data.splitlines() if l.strip()], {}
    facts = Project(root, files, overrides).run()
    json.dump(facts, sys.stdout)


if __name__ == "__main__":
    main()
