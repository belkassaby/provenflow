# C4 architecture: the projects around a code base, and where code belongs

ProvenFlow reads, draws, edits and writes [C4 models](https://c4model.com) in the
[Structurizr DSL](https://docs.structurizr.com/dsl/language). It can also build one from the code: the
projects around a code base that have the same owner, how they depend on each other, what each one
is made of, and where code belongs between them.

- **In the editor**, use File → **C4 architecture…**. When a code base has been analysed by path,
  the review also has a **System map (C4)** button.
- **On the command line**, run `pflow c4 [dir]`.
- **Over HTTP**, call `POST /api/c4/discover` and `POST /api/c4/save`.

## The editor

| | |
| --- | --- |
| **Open…** | a `workspace.dsl` file, or ProvenFlow's JSON form of a workspace (which keeps where boxes were placed) |
| **View** | each view of the workspace: system landscape, system context, containers, components, dynamic, deployment |
| **Add** | the elements the view can show: people and software systems; containers in a container view; components in a component view; deployment and infrastructure nodes in a deployment view (inside the selected node) |
| **Connect** | drag from one box to another to add a relationship (in a dynamic view, also the next step) |
| **Double-click** | opens the next level: the containers of a software system, the components of a container. The view is created when the workspace has none |
| **Properties** | name, description, technology, tags and group of the selection; description, technology and tags of a relationship; with nothing selected, the view itself (key, title, layout direction, include and exclude) |
| **DSL** | the workspace as Structurizr DSL. You can edit it and apply it; problems are listed with their line |
| **Layout** | lays the view out again, in the direction of its `autoLayout`. Boxes you dragged keep their places until you do this |
| **Undo / redo** | ⌘Z / ⇧⌘Z: every edit is a step |
| **Export** | the view as **SVG** or **PNG**, as **C4-PlantUML** (`.puml`) or as **Mermaid C4** (`.mmd`); the workspace as **Structurizr DSL** or **JSON** |

The diagrams follow Structurizr's rules:

- **Implied relationships.** A relationship between two components also shows between their
  containers and between their software systems, in the views where those are the boxes.
- **`include *`.** In a context view it means the software system and the people and systems connected
  to it. In a container or component view it means the elements inside, plus what they are connected to.
- **Boundaries.** A container view draws its software system as a boundary, and a component view draws
  its container. Groups (`group "…" { }`) are drawn as boundaries too.
- **Deployment views.** Deployment nodes are nested boxes. Instances carry the relationships of the
  containers they are instances of, within the same deployment groups.
- **Styles.** `styles { element "Tag" { … } relationship "Tag" { … } }` set colours, shapes (`Person`,
  `Cylinder`, …), dashed borders and lines. An element without a style gets C4's own colours.

The DSL reader takes everything in this list:

- **Workspace and model:** `workspace`, `model`, `person`, `softwareSystem`, `container`, `component`,
  `group`, `enterprise` (read as the model), and `!element` / `!extend`.
- **Relationships:** `a -> b`, `-> b` and `this` inside an element, and identifiers written as
  `x = …`, including `!identifiers hierarchical` names such as `system.container`.
- **Element properties:** `tags`, `description`, `technology`, `url`, `properties { }`.
- **Deployment:** `deploymentEnvironment`, `deploymentGroup`, `deploymentNode` (nested, with
  instances), `infrastructureNode`, `containerInstance`, `softwareSystemInstance`.
- **Views:** `systemLandscape`, `systemContext`, `container`, `component`, `dynamic` (steps and parallel
  blocks), `deployment`, each with `include`, `exclude`, `autoLayout` (direction and separations),
  `title`, `description`.
- **Styles:** `element` and `relationship` styles.
- **Constants and comments:** `!const` / `!constant` values substituted into `${NAME}`, comments
  (`#` and `//` lines, `/* */`), `"""` text blocks and `\` line continuations.

What the model has no place for is skipped with a warning, so a workspace written for Structurizr
still opens:

- `workspace extends`
- `!include`
- `!docs` and `!adrs`
- themes, branding and terminology
- `filtered`, `image` and `custom` views
- perspectives and animations

Writing DSL keeps the model, groups, views and styles. It does not keep comments or hand placement:
use the JSON form for placement.

## The map of a code base's projects

Give it a code base's folder. ProvenFlow then does the following.

1. **Finds the projects next to it.** It looks at the folders of the parent folder, and one level
   below (`--scan` gives other folders). A project is a folder with a manifest:
   - `package.json`, with npm workspaces, Nx `project.json` and Angular `angular.json` projects as its
     modules;
   - `pyproject.toml`, `setup.cfg` or `setup.py`, with `requirements.txt`;
   - `pom.xml`, with Maven `<modules>`;
   - `build.gradle(.kts)`;
   - `go.mod`;
   - `Cargo.toml`, with workspace members.
2. **Keeps those with the same owner.** The owner is the organisation of the repository (the
   manifest's `repository`, else the git remote `origin`), the npm scope, or the author. Ownership
   spreads, so a scoped package of the same organisation counts even without a repository.
   `--owner` adds organisations, `@scopes` or authors. Projects of other owners are shown only when
   one of these depends on them.
3. **Links the dependencies.** Every dependency one project declares on another is linked by its
   published name: the npm name, the Python distribution and import packages, or Maven `group:artifact`.
   The project's local version is checked against the range.
4. **Reads the TypeScript and Python sources:** what each file imports, from its own project and from
   the others, and the functions and classes it defines.
5. **Builds a C4 model.**
   - Each project is a software system.
   - Its modules (or the project itself) are its containers.
   - The top folders of each container's sources are its components.
   - Dependencies become relationships between containers, tagged `Dev dependency`,
     `Peer dependency`, `Optional dependency` and `Outdated`.
   - Imports between folders, and towards other projects, become relationships between components.
     They are labelled with the names imported.
   - The libraries several projects use become external systems.
   - Views: the landscape of all the projects, plus the context, containers and components of the
     code base.
6. **Suggests where code belongs.**

If the code base has its own model, it is offered too. ProvenFlow looks for `docs/c4/workspace.dsl`,
`docs/architecture/workspace.dsl`, `workspace.dsl` or a `.dsl` file in `docs/c4/`. You can open it
with the discovered projects merged in:

- An element with the same name (case, npm scope and punctuation aside) is the same element.
- The others are added, tagged `Discovered` and drawn dashed.
- What the hand-written model says is never changed.

### Suggestions

| Kind | When | What to do |
| --- | --- | --- |
| Projects in a cycle | projects depend on each other | move what the lower one uses from the higher one down, so dependencies go one way (catalogue: *Cyclic Dependency*) |
| Behind the local version | a project depends on another at a range the local version is outside of (`^0.10.0` while it is 0.13.0) | update the range, or keep it on purpose |
| Imported, not declared | the code imports another project that is not a dependency, or only a development dependency | declare it |
| Declared, never imported | a dependency on another project no source file imports | drop it, or make it optional if it is loaded another way |
| Duplicated across projects | functions or classes 85% alike in two projects (token bags, as for *similar functions*) | keep one copy, in the project the other depends on, or in a dependency both have (catalogue: *DRY*) |
| Could move to a dependency | a file that imports nothing of its own project, only projects it depends on, and libraries | move it to the lowest of those projects that has all it needs, where other users can share it. High confidence when that project already has the libraries the file uses (catalogue: *Orthogonality*) |
| Used by one consumer only | a file of a library, used by none of the library's own files, that only one of the library's consumers imports | it may belong in that consumer, unless code outside these projects uses it |
| Library at clashing versions | projects loaded together (one depends on the other, or a third depends on both) use a library at ranges with no version in common | align the ranges |

In the editor, choosing a suggestion points out its projects on the diagram. The landscape opens
if the current view does not show them.

## Command line

```sh
pflow c4 ../my-app                                   # Markdown: projects, dependencies, suggestions, and the DSL
pflow c4 ../my-app -o docs/c4/projects.dsl           # Structurizr DSL (the format follows the extension)
pflow c4 ../my-app --format plantuml --view context  # one view as C4-PlantUML (.puml), or mermaid (.mmd)
pflow c4 ../my-app --json                            # everything, as JSON
pflow c4 ../my-app --merge -o docs/c4/workspace.dsl  # the code base's own workspace.dsl with the projects added
pflow c4 ../my-app --scan ~/git/org,~/git/other --owner my-org,@my-scope --depth 3
```

## REST API

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/c4/discover` | `{ path, scan?, owners?, depth? }`. The folder is read by path, so only on a server bound to localhost. Returns `{ projects, links, libraries, suggestions, workspace, existing?, notes }` |
| POST | `/api/c4/save` | `{ path, file, text }`: writes a `.dsl`, `.json`, `.puml`, `.mmd` or `.md` file into a folder the server has mapped or analysed since it started |

## Limits

- **Sources.** Only TypeScript/JavaScript and Python are read for imports and definitions. The other
  ecosystems are linked through their manifests only.
- **Hidden connections.** What the manifests and imports do not say is not seen: REST calls between
  services, message queues, shared databases. Write those in the model by hand (or in the code
  base's `workspace.dsl`, which the map merges with).
- **Published code.** "Used by one consumer only" cannot see code outside the folders scanned. For a
  published library, check before moving anything.
