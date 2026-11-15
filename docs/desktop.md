# ProvenFlow as a web application and as a desktop application

The same code base builds two ways:

| | Web | Desktop |
| --- | --- | --- |
| What runs | the Node.js server (`packages/server`), serving the editor (`packages/app`) to browsers | an Electron application (`packages/desktop`): the same server inside it, on a private loopback port, and the editor in its window |
| Build | `npm run build` (or `npm run build:web`) | `npm run build:desktop`; installers with `npm run dist:desktop` |
| Run | `npm start`, then open http://localhost:3000 | `npm run desktop`, or install and open ProvenFlow |
| Platforms | any machine with Node.js ≥ 20.19 | macOS (DMG, zip; Apple silicon and Intel), Windows (installer, zip; x64 and Arm), Linux (AppImage, deb, tar.gz) |
| Folders by path | only when the server is bound to localhost (`HOST`, `PROVENFLOW_EXTRACT_PATHS`) | always: the application analyses the user's own code |

Nothing in the editor or the server is specific to the desktop. The desktop application adds:

- **Native menus.** File, Edit, View, Verify, Window and Help, with the usual shortcuts. File → Open…
  takes a `.pflow` diagram or a C4 workspace (`.dsl`, `.c4.json`).
- **Native folder dialogs.** A **Browse…** button next to the folder fields of Import code base and
  C4 architecture → Map.
- **File associations.** A double-click on a `.pflow` or `.dsl` file opens it in ProvenFlow, and so
  does a file given on the command line. A second launch hands its files to the running window.
  Recent documents are kept by the system.
- **The shell's `PATH`.** The application takes it at start on macOS and Linux, so nuXmv, Python,
  Semgrep, CBMC and the other tools are found as in a terminal. `NUXMV_PATH` and the other variables
  work the same way.
- **The window.** Its size and place are kept between runs.

## How it is put together

```
packages/desktop/
├── src/main.ts          the application: one instance, the server, the window, files to open, IPC
├── src/server.ts        createApp() from @provenflow/server on 127.0.0.1:<free port>
├── src/window.ts        a sandboxed window (no Node, context isolation) that stays on the local page;
│                        other links open in the browser
├── src/preload.cts      the bridge the editor sees as window.provenflowDesktop: menu commands,
│                        opened files, the folder picker. Nothing else of Node or Electron
├── src/menu.ts          the menus (plain data, tested without Electron)
├── src/files.ts  shell-path.ts  window-state.ts
├── scripts/stage.mjs    stages the application for packaging (below)
├── electron-builder.yml the targets for each platform
└── build/icon.svg, icon.png
```

On the editor side, `packages/app/src/app/desktop-bridge.ts` connects the menus and the opened
files to the editor's own actions. In a browser it does nothing.

**Packaging.** `scripts/stage.mjs` puts together, in `packages/desktop/stage/`:

- the compiled main process;
- the built editor;
- `@provenflow/language`, `extract` and `server`, each packed as npm would publish it (with their
  grammars, Semgrep rules and `python_facts.py`) and installed with their production dependencies.

electron-builder then packages that folder without an asar archive, because the analysers run
Python on the extract package's files. There are no native modules, so every platform builds from
any other: on a Mac, `npm run dist:linux -w @provenflow/desktop` builds the AppImage, and the
Windows zip builds too. The Windows installer is best built on Windows, which CI does.

## Building

```sh
npm ci
node node_modules/electron/install.js   # Electron's binary (npm ci does not fetch it)
npm run desktop                         # build, and run from the repository
npm run dist:desktop                    # installers for this platform, in packages/desktop/release/
npm run dist:mac -w @provenflow/desktop     # or dist:win, dist:linux (after npm run build:desktop)
npm run pack -w @provenflow/desktop         # the unpacked application only (quick check)
```

**CI.** `.github/workflows/desktop.yml` packages the application on macOS, Windows and Linux for
pull requests that touch it. On a version tag (`v*`) or a manual run, it builds the installers and
keeps them as artifacts.

**Signing.** The builds are unsigned: macOS asks before opening one the first time (Control-click →
Open), and Windows SmartScreen warns. To sign:

- remove `identity: null` from `electron-builder.yml`;
- give electron-builder a certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`);
- on macOS, also give the notarisation credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`), as secrets in CI.

## Settings and data

- **LLM keys and models** (Help → LLM settings, or ProvenFlow → Settings… on macOS) are kept where the
  web server keeps them: `~/.config/provenflow/llm.json`, or `PROVENFLOW_SETTINGS`.
- **The editor's own state** (open documents, the last report, the C4 workspace) is in the
  application's storage.
- **The window's size and place** are in the user data folder:
  - macOS: `~/Library/Application Support/ProvenFlow`
  - Windows: `%APPDATA%\ProvenFlow`
  - Linux: `~/.config/ProvenFlow`
