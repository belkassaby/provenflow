# Checks for coding agents (add this section to the project's AGENTS.md or CLAUDE.md)

This repository is checked by ProvenFlow in CI: a pull request fails on new errors, and on new
warnings in lines written by coding agents. Run the same checks before committing:

1. Before writing code, read the conventions: `pflow mcp` tool `project_conventions`
   (layers and what each may import, naming per language, complexity and size limits).
2. Before writing a helper, look for one: tool `find_existing_code` with the code you are about to
   write. Reuse what exists instead of adding a copy.
3. Before committing, run `pflow review . --base HEAD` (or the tool `review_changes`) and fix every
   error and warning it reports on your changes. Each finding comes with a fix; `propose_fix` gives
   the verified automatic one when there is one.
4. Change or add tests with every change of behaviour: a change without a test change is reported.
