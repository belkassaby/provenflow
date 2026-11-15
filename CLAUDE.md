# ProvenFlow

Design and verify state machines with nuXmv, and review code: model-check a code base or a pull request, measure its quality, and propose verified fixes. It ships as the `pflow` CLI, an Express server with an Angular editor, an MCP server for coding agents, and a GitHub Action (`action.yml`).

## Layout

npm workspaces, ESM, TypeScript, Node >= 20.19.

| Package | Role | May import |
| --- | --- | --- |
| `packages/language` | Langium grammar (`state-diagram.langium`), model, nuXmv/Python generators, `text-edits.ts` | nothing |
| `packages/extract` | Code facts IR (TypeScript, tree-sitter, `python_facts.py`), models, findings, quality checks (`src/quality/`), gating, report formats | `language` |
| `packages/server` | Express app (`routes/`, `context.ts`), `pflow` CLI (`cli.ts`, `commands/`), MCP server (`mcp.ts`) | `language`, `extract` |
| `packages/app` | Angular editor (object-oriented style) | `language` |

These rules are enforced by `provenflow.config.json` (`layers`). Import a package only through its `index.ts` facade. Don't reach into another package's files.

## Commands

```sh
npm run build        # language → extract → server → app, in this order
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

Update them in the same change as the code. The anchors in `docs/code-model-checking.md` must match `CATEGORY_DOCS` in `packages/extract/src/report-formats.ts`.

## CI

- `ci.yml` builds and tests.
- `review.yml` runs the Action on pull requests in new-only mode. `review-post.yml` posts its results for PRs from forks.
- `scorecard.yml` runs OpenSSF Scorecard.
- Pin every third-party action to a full commit SHA, with the version in a comment.
- `ubuntu-latest` is Ubuntu 26.04. Tool downloads such as the CBMC `.deb` must fall back to the newest older release.

## Git

- Don't commit or push unless asked. When asked, use a branch and a PR into `main`.
- No Claude attribution: no `Co-Authored-By` trailer in commits and no "Generated with Claude Code" line in PR descriptions.
- Commit subjects are long descriptive sentences in the style of `git log`. A list of changes separated by semicolons is fine.
- Never commit nuXmv binaries: they are licensed separately and gitignored. `.provenflow/` (pflow output and the LLM cache) is gitignored too.
