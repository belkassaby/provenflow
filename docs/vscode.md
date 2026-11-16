# ProvenFlow in VS Code

The extension (`packages/vscode`) shows ProvenFlow's findings in VS Code while you work. It runs the
`pflow` command-line tool on the workspace folder, reads the report it writes, and shows each
finding where it is:

- in the Problems panel and as a squiggle on its lines, with the fix to make;
- with the property nuXmv found false, and whether replaying it on the real code confirmed it;
- with the steps of its counterexample as related places, so you can follow the run in the code;
- with its proposed change as a quick fix, when pflow verified it.

The extension contains no analysis of its own. It runs the same `pflow extract` as the CLI, the
GitHub Action and the editor, with the same `provenflow.config.json` and baseline.

## Install from source

The extension needs a built `pflow`: in this repository, or in the project you open.

```sh
npm install
npm run build                 # pflow itself (packages/server/out/cli.js)
npm run build:vscode          # the extension (packages/vscode/out)
cd packages/vscode
npx @vscode/vsce package --no-dependencies
code --install-extension provenflow-vscode-0.1.0.vsix
```

`--no-dependencies` is needed because the extension has no run-time dependencies, and npm
workspaces keep the development ones at the root.

To try it without packaging, open `packages/vscode` in VS Code and press F5 (Run Extension).

## Which pflow it runs

In this order:

1. `provenflow.cliPath`, when set (absolute, or relative to the workspace folder). A `.js` file,
   such as `packages/server/out/cli.js`, runs with the `node` on the PATH.
2. `node_modules/.bin/pflow` in the workspace folder.
3. `pflow` on the PATH.

If none is found, the extension says so and does nothing else.

## When it runs

- When a file is saved, after `provenflow.saveDelay` milliseconds without another save. Saves in
  `.provenflow/`, `.git/` and `node_modules/` don't count.
- With **ProvenFlow: Analyse workspace** from the Command Palette.

Only one analysis of a folder runs at a time: a new one stops the one still running. The status bar
shows a spinner while it runs, then the number of errors and warnings. Click it to open the report.

The command is:

```sh
pflow extract <folder> -o <folder>/.provenflow/vscode --quiet --fail-on none --no-analyzers --no-confirm --fix
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
| ProvenFlow: Open model | Opens one of the extracted models (`models/*.pflow`). Open it in the ProvenFlow editor to check it and replay its counterexamples. |

## Fixes

A finding with a verified change offers **ProvenFlow: apply verified fix** as a quick fix (the light
bulb, or Cmd+. / Ctrl+.). "Verified" means pflow re-ran the analysis and the build on the changed
code: the finding was gone and nothing new appeared.

Applying it replaces the text of each file the change touches, in one edit you can undo. The files
are left unsaved, so you can read the change first. Saving them starts a new analysis.

With `provenflow.offerUnverifiedFixes`, changes pflow could not verify are offered too, as
**apply unverified fix (review it)**. Read them before keeping them.

## Development

- `src/report.ts`: report.json as problems per file (no `vscode` import).
- `src/cli.ts`: which pflow to run, and its arguments (no `vscode` import).
- `src/analysis-process.ts`: one run at a time (no `vscode` import).
- `src/extension.ts`, `problem-view.ts`, `fix-actions.ts`, `analysis-status.ts`: the parts that use
  VS Code's API.

`npm test -w provenflow-vscode` tests the first three with vitest.
