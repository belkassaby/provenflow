# ProvenFlow in VS Code

The extension (`packages/vscode`) brings ProvenFlow into VS Code while you work. It runs the `pflow`
command-line tool on the workspace folder, reads the report it writes, and shows it in three places:

- **The ProvenFlow sidebar** (its icon in the activity bar): the findings by kind with their
  counterexample steps, the extracted models with the properties found false, the hotspots and the
  quality trends.
- **The editor:** each finding in the Problems panel and as a squiggle on its lines, with the fix to
  make, the property nuXmv found false, whether replaying it on the real code confirmed it, and the
  steps of its counterexample as related places. A verified change is offered as a quick fix, and
  any finding can be fixed in a diff, with or without an LLM, and verified before it is applied.
- **ProvenFlow editor tabs:** the same editor as the web and desktop versions, in VS Code tabs. It
  shows a model as a diagram with its counterexample, the C4 architecture of the folder, and any
  `.pflow` diagram or Structurizr DSL workspace.

The extension contains no analysis of its own. It runs the same `pflow extract` as the CLI, the
GitHub Action and the editor, with the same `provenflow.config.json` and baseline.

## The sidebar

| View | What it shows | A click |
| --- | --- | --- |
| Findings | The findings grouped by kind (security, state machines, resource lifecycles, duplicated code...), the groups with errors first, with a badge counting errors and warnings. A finding says whether the replay confirmed it on the code, and lists its counterexample steps. | Opens the finding's line, or a step's line |
| Models | The state machines, resource lifecycles and patterns extracted from the code, those with false properties first, with the properties found false | Opens the model in a ProvenFlow editor tab, checked, so its counterexample shows |
| Hotspots | The complex functions in files that change often: Cognitive Complexity × commits to the file | Opens the function |
| Trends | Errors, warnings, false properties, duplication, complexity, coverage and code lines over the measured commits: the latest value, the change since the first and a bar per commit | - |

The buttons at the top of Findings are **Analyse workspace**, **Open report** (report.md),
**Open C4 architecture** and **Open the ProvenFlow editor**. On a finding:
- the light bulb applies its verified fix;
- the wrench (**Fix…**) fixes it in a diff (see [Fixes](#fixes));
- the bug button opens its model with the counterexample.

At the top of Trends:
- **Refresh trends** reads them again;
- **Measure older commits** measures 12 older commits from git, without checking them out
  (`pflow trends --backfill 12`).

Analyses on save don't add to the trends, because they measure uncommitted work. Each
`pflow extract` run in a terminal adds the commit it measures.

## ProvenFlow editor tabs

A tab opens for each document:
- a model, from the Models view or **ProvenFlow: Open model in the editor**;
- the C4 architecture of the folder, from **ProvenFlow: Open C4 architecture**;
- a `.pflow`, `.nxd`, `.dsl` or `.c4.json` file, from **Open in the ProvenFlow editor**. That button
  is in the editor's title bar and the explorer's context menu.

Opening the same document again shows its tab. A tab shows only its document (the diagram with
its text, inspector and panels, the C4 architecture, or the code base report), without the editor's
own menu bar and tabs. The tabs follow VS Code's light or dark theme. **Browse…** next to a folder
path opens VS Code's folder dialog. The editor's messages, such as "Opened …" or "Could not
import …", show in the status bar.

### The ProvenFlow menu

The editor's menus are VS Code's. The **ProvenFlow** button in the title bar of a ProvenFlow tab, and
at the top of the Findings view, opens the ProvenFlow menu. Every item is also in the Command Palette
as **ProvenFlow: …**. VS Code does not let extensions add menus to its menu bar, so the menu is
there rather than in Run.

| Submenu | Items |
| --- | --- |
| File | New Diagram, Open .pflow…, Import Agent Graph…, Import Code Base…, Code Base Report, C4 Architecture, Save .pflow, Export nuXmv Model (.smv), Export Diagram (.png, .svg), Export Python Implementation (.py), Export Jupyter Notebook (.ipynb) |
| Examples | Open Example…: a list of the editor's examples, each opened in a new tab |
| Attributes | Edit Attribute Table |
| nuXmv | Show Generated Model, Check Properties, Simulate the Diagram, Show nuXmv Output, Re-detect nuXmv |
| Help | Using the Editor, Walkthroughs, Logic Symbols, Glossary of Logic Terms, References, LLM Settings (API Keys)… |

It also has Analyse Workspace, Open Report, Open Model in the Editor and Measure Older Commits.

- The items that act on a diagram (Save, Export, Attributes, nuXmv) act on the ProvenFlow tab last
  in front.
- New Diagram, Import Agent Graph and the examples open a new tab.
- Open .pflow… uses VS Code's file dialog.

**Saving.** Save .pflow writes over the file a tab shows, when the tab shows a file of the
workspace. Otherwise, and for every export, VS Code's save dialog asks where the file goes, starting
next to that file or in the folder.

The editor runs on a local server, which `pflow serve` starts the first time a tab opens. It listens
on a free port of 127.0.0.1 only, and stops with VS Code. The editor needs a built
`packages/app` (`npm run build`). Checking a model needs nuXmv (`NUXMV_PATH`), as in the other
versions of the editor.

## Install from source

The extension needs a built `pflow`: in this repository, or in the project you open.

```sh
npm install
npm run build                 # pflow itself (packages/server/out/cli.js)
npm run build:vscode          # the extension (packages/vscode/out)
cd packages/vscode
npx @vscode/vsce package --no-dependencies
code --install-extension provenflow-vscode-0.2.1.vsix
```

`--no-dependencies` is needed because the extension has no run-time dependencies, and npm
workspaces keep the development ones at the root.

To try it without packaging, open `packages/vscode` in VS Code and press F5 (Run Extension).

## Which pflow it runs

In this order:

1. `provenflow.cliPath`, when set (absolute, or relative to the workspace folder). A `.js` file,
   such as `packages/server/out/cli.js`, runs with the `node` on the PATH.
2. `node_modules/.bin/pflow` in the workspace folder, or in a folder above it (a package of a
   monorepo).
3. `pflow` on the PATH.

When none is found, an error offers two buttons:
- **Choose pflow…** picks the file, such as `packages/server/out/cli.js` of a built ProvenFlow
  checkout. It's kept in your user settings (`provenflow.cliPath`) and used at once.
- **Open Settings** opens the setting.

## When it runs

- When a file is saved, after `provenflow.saveDelay` milliseconds without another save. Saves in
  `.provenflow/`, `.git/` and `node_modules/` don't count.
- With **ProvenFlow: Analyse workspace** from the Command Palette.

Only one analysis of a folder runs at a time: a new one stops the one still running.

While it runs, its progress shows with the steps pflow reports, such as "Checking model 3/12…":
- **Analyse workspace** shows a notification with a progress bar, the current step and **Cancel**.
- An analysis started by a save shows a progress bar on the Findings view instead, so saving doesn't
  open a notification each time.
- The status bar shows the percentage, with the step in its tooltip. When the analysis ends, it shows
  the number of errors and warnings. Click it to open the report.

The command is:

```sh
pflow extract <folder> -o <folder>/.provenflow/vscode --quiet --fail-on none --no-history --progress-json --no-analyzers --no-confirm --fix
```

pflow's own messages go to the **ProvenFlow** output channel.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `provenflow.cliPath` | empty | The pflow to run (see above). |
| `provenflow.runOnSave` | `true` | Analyse the folder when a file is saved. |
| `provenflow.saveDelay` | `1500` | Milliseconds to wait after the last save. |
| `provenflow.fullAnalysis` | `false` | Also run the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani) and replay counterexamples on the code. This drops `--no-analyzers --no-confirm`, and is slower. |
| `provenflow.proposeFixes` | `true` | Propose automatic fixes (`--fix`), each verified by re-running the analysis and the build. |
| `provenflow.offerUnverifiedFixes` | `false` | Also offer fixes pflow could not verify. |

## Commands

| Command | What it does |
| --- | --- |
| ProvenFlow: Analyse workspace | Runs pflow on the folder of the active file (or the one you pick). |
| ProvenFlow: Open report | Opens `report.md` in the Markdown preview. |
| ProvenFlow: Open model in the editor | Opens one of the extracted models (`models/*.pflow`) in a ProvenFlow editor tab. |
| ProvenFlow: Open the ProvenFlow editor | Opens an editor tab with nothing in it: draw a diagram, or File → Import code base. |
| ProvenFlow: Open C4 architecture | Maps the folder and the projects around it as a C4 model, in an editor tab. |
| ProvenFlow: Open in the ProvenFlow editor | Opens the active `.pflow` diagram or C4 workspace in an editor tab. |
| ProvenFlow: Refresh trends, Measure older commits | Read the trends again, or first measure 12 older commits. |

## Fixes

A finding with a verified change offers **ProvenFlow: apply verified fix** as a quick fix (the light
bulb, or Cmd+. / Ctrl+.). "Verified" means pflow re-ran the analysis and the build on the changed
code: the finding was gone and nothing new appeared.

Applying it replaces the text of each file the change touches, in one edit you can undo. The files
are left unsaved, so you can read the change first. Saving them starts a new analysis.

With `provenflow.offerUnverifiedFixes`, changes pflow could not verify are offered too, as
**apply unverified fix (review it)**. Read them before keeping them.

### Fixing any finding in a diff

Every finding with a place in the code can be fixed in a diff: **Fix…** on the finding in the
sidebar (its context menu, or the wrench), or **ProvenFlow: fix <rule>…** in the quick fixes of its
lines. Choose how:

| Choice | What you get |
| --- | --- |
| Review the verified fix (or proposed fix) | The change the analysis proposed, when the finding has one. |
| Fix without an LLM | The automatic fix where the analysis has one for the rule (state values not handled, a stale write after an `await`, a resource leak), checked. For any other finding, a draft: the suggested fix as a `TODO(pflow <rule>)` comment where the code has to change, to finish by hand. |
| Fix with <provider> <model> | The LLM implements the suggested fix, and the change is checked like the automatic fixes. One entry for each LLM set up in **LLM Settings (API Keys)…**, the preferred one first. |
| Edit by hand | The file as it is, to change yourself in the diff. |
| Set up an LLM (API keys)… | Shown while no Anthropic or OpenAI key is set: opens the editor's LLM settings. |

The change opens in a diff for each file it touches: the file at the left, the change at the right.
The right side can be edited. The buttons at the top of the diff, and the notification, are:

- **Verify** checks the right side as it is now: the analysis again on the changed files, and the
  build or type check on a copy of the project. It says whether the finding is gone and whether
  anything new appeared.
- **Apply** writes the right side into the files, in one edit you can undo, as long as they did not
  change since the fix was made. It warns when that version was not verified.
- **Discard** closes the diff.

The fixes and the checks run in the editor's server (`pflow serve`, started when needed), with the
LLM keys of its settings. The first one in a folder analyses the folder; the next ones reuse that
analysis until a file changes, and then redo only the changed files. The changes under review live
in memory (the `provenflow-fix:` scheme) until they are applied or discarded.

## Development

- `src/report.ts`: report.json as problems per file.
- `src/sidebar.ts`, `src/trends.ts`: what the sidebar's views show, as plain trees.
- `src/cli.ts`: which pflow to run, and its arguments.
- `src/analysis-process.ts`: one run at a time.
- `src/editor-page.ts`, `src/editor-documents.ts`, `src/editor-server.ts`: the page of an editor tab,
  what it opens, and `pflow serve`.
- `src/change-client.ts`: the ways to fix a finding, and the requests to `pflow serve` for a fix or a
  check (`POST /api/fix`, `POST /api/verify-change`).

None of the files above imports `vscode`. These use VS Code's API:
- `src/extension.ts`;
- `sidebar-views.ts` and `tree-view.ts`;
- `editor-panels.ts`;
- `problem-view.ts`, `fix-actions.ts`, `fix-review.ts` (fixing in a diff) and `analysis-status.ts`.

An editor tab is a webview whose only content is a frame of the editor that `pflow serve` runs. The
page passes messages between the extension and the editor, each one `{ provenflow: <type>, ... }`:

| From | Message | What it does |
| --- | --- | --- |
| extension | `open-file` | Opens a diagram, a model to check (`check: true`) or a C4 workspace. |
| extension | `map-c4` | Maps a folder in the C4 tab. |
| extension | `theme` | Sets the light or dark theme. |
| extension | `command` | Runs a menu command (`name` or `name:argument`, such as `example:door` or `help:symbols`), as the desktop application's menus do. |
| extension | `folder` | Answers `pick-folder`. |
| editor | `ready` | Says the editor listens, with the examples its Examples menu lists. Messages wait until then. |
| editor | `save-file` | A file it saves or exports (`name`, `content`, `encoding`: text or base64), for the extension to write. |
| editor | `notify` | A message to show (the status bar). |
| editor | `pick-folder` | Asks for VS Code's folder dialog. |

The editor's side is `packages/app/src/app/host-frame.ts`. The page allows only its own script and
the editor's origin (Content Security Policy). It passes on only the editor frame's messages.

`npm test -w provenflow-vscode` tests the files that don't use `vscode`, with vitest.
