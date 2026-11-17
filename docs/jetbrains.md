# ProvenFlow in JetBrains IDEs

The plugin (`packages/jetbrains`) brings ProvenFlow into IntelliJ IDEA, WebStorm, PyCharm and the
other IDEs of the IntelliJ Platform (2026.2 and later). Like the VS Code extension, it runs the `pflow`
command-line tool on the project, reads the report it writes, and shows it in three places:

- **The ProvenFlow tool window** (on the right). It has a tab each for:
  - the findings by kind, with their counterexample steps;
  - the models extracted from the code, with the properties found false;
  - the hotspots;
  - the quality trends.
- **The code:** each finding highlights its lines, with a mark on the scroll bar and a gutter icon.
  The icon's tooltip has the message, the fix, the property nuXmv found false, and whether replaying
  it on the real code confirmed it. On a line with a verified fix, Alt+Enter offers
  **ProvenFlow: apply verified fix**.
- **ProvenFlow editor tabs:** the same editor as the web, desktop and VS Code versions. It shows a
  model as a diagram with its counterexample, the C4 architecture of the project, and any `.pflow`
  diagram or C4 workspace (`.dsl`, `.c4.json`). Those files get a **ProvenFlow** tab next to their
  text.

The plugin contains no analysis of its own. It runs the same `pflow extract` as the CLI, the GitHub
Action and the VS Code extension, with the same `provenflow.config.json` and baseline.

## Build and install

The plugin is built with Gradle and the IntelliJ Platform Gradle plugin. It needs Java 25, which the
2026.2 IDEs bundle. It also needs the editor and `pflow` built, for the editor tabs and the analyses.

```sh
npm install && npm run build            # pflow and the editor
cd packages/jetbrains
./gradlew buildPlugin \
  -PplatformLocalPath="$HOME/Applications/IntelliJ IDEA.app" \
  -Porg.gradle.java.installations.paths="$HOME/Applications/IntelliJ IDEA.app/Contents/jbr/Contents/Home"
```

The two properties are optional:
- `platformLocalPath` builds against an installed IDE instead of downloading IntelliJ IDEA 2026.2.3.
- `org.gradle.java.installations.paths` points Gradle at the IDE's Java 25. Without it, Gradle
  downloads a Java 25 when none is installed.

`npm run build:jetbrains` runs `./gradlew buildPlugin` without them.

This writes `packages/jetbrains/build/distributions/provenflow-jetbrains-0.1.0.zip`. To install it,
open **Settings | Plugins**, then **⚙ → Install Plugin from Disk…**, pick the zip, and restart the
IDE. To try it without installing, `./gradlew runIde` (with the same properties) starts a sandboxed
IDE with the plugin loaded.

## Which pflow it runs

In this order:

1. The **pflow command** in Settings | Tools | ProvenFlow, when it's set (absolute, or relative to the
   project). A `.js` file, such as `packages/server/out/cli.js`, runs with `node`.
2. `node_modules/.bin/pflow` in the project, or in a folder above it (a package of a monorepo).
3. `pflow` on the PATH of your login shell.

When none is found, a notification says so. **Choose pflow…** picks the file, keeps it in the
settings and analyses the project.

## When it runs

- When a file of the project is saved, after the delay in the settings (1.5 s by default). Saves in
  `.provenflow/`, `.git/`, `.idea/`, `node_modules/`, `build/` and `out/` don't count.
- With **Tools | ProvenFlow | Analyse Project**, or the ▶ button of the Findings tab.

One analysis runs at a time: a new one cancels the one still running. The command is:

```sh
pflow extract <project> -o <project>/.provenflow/jetbrains --quiet --fail-on none --no-history --no-analyzers --no-confirm --fix
```

Analyses on save don't add to the trends, because they measure uncommitted work. Each
`pflow extract` run in a terminal adds the commit it measures. **Measure Older Commits** in the
Trends tab measures 12 older commits from git (`pflow trends --backfill 12`).

## The tool window

| Tab | What it shows | Double-click (or Enter) |
| --- | --- | --- |
| Findings | The findings grouped by kind, errors first; the tab's title counts errors and warnings. A finding says whether the replay confirmed it, and lists its counterexample steps. Right-click: **Apply Fix**, **Show Model and Counterexample**. | Opens the finding's line, or a step's line |
| Models | The models, those with false properties first, with the properties found false | Opens the model in a ProvenFlow editor tab, checked, so its counterexample shows |
| Hotspots | Complex functions in files that change often: Cognitive Complexity × commits to the file | Opens the function |
| Trends | Errors, warnings, false properties, duplication, complexity, coverage and code lines over the measured commits | - |

## Settings

Settings | Tools | ProvenFlow:

| Setting | Default | Meaning |
| --- | --- | --- |
| pflow command | empty | The pflow to run (see above). |
| Analyse the project when a file is saved | on | |
| Wait after the last save | 1500 ms | |
| Full analysis | off | Also run the installed analysers (Semgrep, Infer, ESBMC/CBMC, Kani) and replay counterexamples on the code. Slower. |
| Propose automatic fixes | on | `--fix`: each fix is verified by re-running the analysis and the build. |
| Also offer fixes that could not be verified | off | |

## Actions

Under **Tools | ProvenFlow**, and in Find Action:
- Analyse Project;
- Open Report (report.md);
- Open Model in the Editor…;
- Open C4 Architecture;
- Open the ProvenFlow Editor;
- Refresh Trends;
- Measure Older Commits.

**Open in the ProvenFlow Editor** is in the context menu of `.pflow`, `.nxd`, `.dsl` and `.c4.json`
files.

## How the editor tabs work

The editor runs on a local server, which `pflow serve` starts the first time a tab opens. It listens
on a free port of 127.0.0.1 only, and stops with the IDE. A tab is a JCEF browser whose page holds a
frame of the editor (`?host=jetbrains`). The page passes messages between the plugin (a
`JBCefJSQuery`) and the editor (`packages/app/src/app/host-frame.ts`). The messages are the same as
the VS Code extension's: see [docs/vscode.md](vscode.md#development). The tabs follow the IDE's light
or dark theme, and **Browse…** opens the IDE's folder dialog. Checking a model needs nuXmv
(`NUXMV_PATH`), as in the other versions of the editor. A `.pflow` file's ProvenFlow tab shows the
text as it was when the tab opened.

## Development

- `src/main/kotlin/.../model/` (no IDE classes): report.json, which pflow to run and its arguments,
  the tool window's trees, the trends, and the editor tab's page.
- `src/main/kotlin/.../ide/`: settings, the analysis service, the highlighting and quick fix, the
  tool window, the actions, the editor server and the JCEF editor tabs.
- `src/main/resources/META-INF/plugin.xml`: what the plugin adds to the IDE.

`./gradlew test` tests the `model` package with JUnit. Use the same two properties as above.
