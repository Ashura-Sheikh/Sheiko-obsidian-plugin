# Contributing to Sheiko Task Lifecycle

Thanks for your interest. This is a small plugin maintained on a best-effort basis by one person, so please keep that in mind when opening issues or pull requests.

## Reporting a bug

Open an issue on [GitHub](https://github.com/Ashura-Sheikh/Sheiko-obsidian-plugin/issues) with:

- Your Obsidian version, the plugin version, and your **TaskNotes** version (Sheiko is tested on TaskNotes 4.13.4)
- What you did, what you expected, and what happened instead
- If notes were changed unexpectedly: the relevant frontmatter and the `## Status History` / `## Context` lines (remove anything private)
- Whether **Dry run** shows the same behaviour (its output is in the developer console, at the *Verbose* log level)

## Suggesting a feature

Open an issue describing the problem you want solved, not just the solution. Sheiko deliberately stays small and cautious: it edits people's notes, so features that write more, or write without being asked, get a high bar.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Set up: Node.js 20+, then `npm i`.
3. Before opening the PR, all of these must pass:
   - `npm run build` (type-check and production build)
   - `npm run lint` (ESLint with the Obsidian plugin rules)
   - `npm test` (type-checks the tests, then runs them)
4. If you change how Sheiko edits notes (status history, closure fields, auto-roll), add or update a test in `test/`. The tests run the real tracker and auto-roll code against an in-memory vault (see `test/fake-vault.ts`).
5. Keep the safety defaults: nothing happens without TaskNotes, nothing is written until the vault is allowed, auto-roll stays off by default, batch runs stay capped.
6. Test in a separate vault, never one with notes you care about. See *Loading it in a dev vault* in the README.

## Licence

By contributing, you agree your contributions are licensed under the project's [MIT licence](LICENSE).
