# ProvenFlow

Design and verify state machines with nuXmv, and review code: model-check a code base or a pull request, measure its quality, and propose verified fixes. It ships as the `pflow` CLI, an Express server with an Angular editor (the web version), the same editor and server as a desktop application for macOS, Windows and Linux (Electron, `packages/desktop`), an MCP server for coding agents, a VS Code extension (`packages/vscode`), a JetBrains plugin (`packages/jetbrains`), and a GitHub Action (`action.yml`).

## Layout

npm workspaces, ESM, TypeScript, Node >= 20.19. The JetBrains plugin is a Gradle project in Kotlin, outside the npm workspaces.

| Package | Role | May import |
| --- | --- | --- |
| `packages/language` | Langium grammar (`state-diagram.langium`), model, nuXmv/Python generators, `text-edits.ts`, C4 model and Structurizr DSL (`src/c4/`) | nothing |
| `packages/extract` | Code facts IR (TypeScript, tree-sitter, `python_facts.py`), models, findings, quality checks (`src/quality/`), the project map and placement suggestions (`src/c4/`), gating, report formats | `language` |
| `packages/server` | Express app (`routes/`, `context.ts`), `pflow` CLI (`cli.ts`, `commands/`), MCP server (`mcp.ts`) | `language`, `extract` |
| `packages/app` | Angular editor (object-oriented style) | `language` |
| `packages/desktop` | Electron application: the server on a loopback port and the editor in a window, native menus, file associations (object-oriented style) | `server`, `extract` |
| `packages/vscode` | VS Code extension: runs the `pflow` CLI on save; a sidebar (findings, models, hotspots, trends), diagnostics, verified fixes as quick fixes, and the editor in VS Code tabs through `pflow serve` (object-oriented style) | nothing (it runs `pflow`) |
| `packages/jetbrains` | JetBrains plugin (Kotlin, Gradle): the same as the VS Code extension in IntelliJ Platform IDEs, with a tool window, highlights and Alt+Enter fixes, and the editor in JCEF tabs; `model/` has no IDE classes (object-oriented style) | nothing (it runs `pflow`) |

These rules are enforced by `provenflow.config.json` (`layers`). Import a package only through its `index.ts` facade. Don't reach into another package's files.

## Commands

```sh
npm run build        # language → extract → server → app, in this order (the web version)
npm run build:desktop  # the same, then packages/desktop (Electron); npm run desktop runs it
npm run dist:desktop   # installers for this platform in packages/desktop/release/
npm run build:vscode   # the VS Code extension (packages/vscode); npx @vscode/vsce package there makes the .vsix
npm run build:jetbrains  # the JetBrains plugin (Java 25; see docs/jetbrains.md for building against an installed IDE)
npm run typecheck
npm test             # vitest in each package (app: ng test)
npm run check:code   # self-check: pflow extract . --fail-on warning (needs a build first)
```

- Run a single package with `npm test -w @provenflow/extract`, and the CLI with `node packages/server/out/cli.js <command>`.
- Tests that need external tools skip themselves when the tool is missing: nuXmv, Python packages, CBMC/ESBMC, Semgrep and Infer. A skipped count isn't a failure.
- `packages/language/src/generated/` comes from Langium. Edit `state-diagram.langium`, then run `npm run langium:generate`. Never edit the generated files.
- `extract`'s build copies `src/python_facts.py` into `out/`. Rebuild after changing it.

## Quality gate

The repo checks itself with its own rules, so new code must pass `npm run check:code` (exit 0, "0 new"):

- **Limits** come from `provenflow.config.json` (`languages`). For TypeScript: functions at most 50 lines, 7 parameters, Cognitive Complexity 15, nesting 4. For Python: 50 lines, 5 parameters, complexity 15, nesting 5. Split long or deeply nested functions into named helpers rather than adding to the baseline.
- **Duplication:** no copy of 100 tokens or more and no functions over 80% alike. Reuse the existing helper. The `find_existing_code` MCP tool or `pflow review` finds it.
- **Naming:** camelCase functions and fields, PascalCase classes, SCREAMING_SNAKE_CASE constants. snake_case for functions in Python.
- **Baseline:** `provenflow-baseline.json` lists accepted older findings and must only shrink. Never add entries to make a change pass. Run `pflow baseline --update` only to remove entries that are gone, and only on a full local run: CI has fewer analysers, so it sees fewer findings.
- **Suppressions:** a finding that is a false positive goes in `ignore` in `provenflow.config.json`, with a `reason`.
- **New rules:** a rule that checks a pattern or practice belongs to an entry of the catalogue (`packages/extract/src/catalogue/entries.ts`, in Fowler's pattern form, with an example). After changing the entries, regenerate `docs/patterns-and-practices.md` with `node packages/server/out/cli.js catalogue -o docs/patterns-and-practices.md`. A new rule's findings in existing code go into the baseline (`pflow baseline .`), and only those.

## Docs

User-facing behaviour is documented in `README.md` (command table) and `docs/`:

- `code-model-checking.md` is the reference for the CLI, config and Action.
- `ai-code-guardrails.md` holds the research and roadmap.
- `coding-standards.md` gives the per-language limits.
- `quality-before-after.md` has the before/after report.
- `c4-architecture.md` covers the C4 editor, the project map and the placement suggestions.
- `desktop.md` covers the web and desktop builds, packaging and signing.
- `vscode.md` covers the VS Code extension: the sidebar, the editor tabs, settings, commands, fixes and packaging.
- `jetbrains.md` covers the JetBrains plugin: building, installing, the tool window, settings and the editor tabs.

Update them in the same change as the code. The anchors in `docs/code-model-checking.md` must match `CATEGORY_DOCS` in `packages/extract/src/report-formats.ts`.

## CI

- `ci.yml` builds and tests.
- `review.yml` runs the Action on pull requests in new-only mode. `review-post.yml` posts its results for PRs from forks.
- `scorecard.yml` runs OpenSSF Scorecard.
- `desktop.yml` packages the desktop application on macOS, Windows and Linux (installers on `v*` tags). `npm ci` does not fetch Electron's binary: run `node node_modules/electron/install.js`. Electron is pinned to an exact version (electron-builder needs one).
- Pin every third-party action to a full commit SHA, with the version in a comment.
- `ubuntu-latest` is Ubuntu 26.04. Tool downloads such as the CBMC `.deb` must fall back to the newest older release.

## Git

- Don't commit or push unless asked. When asked, use a branch and a PR into `main`.
- No Claude attribution: no `Co-Authored-By` trailer in commits and no "Generated with Claude Code" line in PR descriptions.
- Commit subjects are long descriptive sentences in the style of `git log`. A list of changes separated by semicolons is fine.
- Never commit nuXmv binaries: they are licensed separately and gitignored. `.provenflow/` (pflow output and the LLM cache) is gitignored too.
