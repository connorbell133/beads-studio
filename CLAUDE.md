# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
bun install              # Install dependencies
bun run compile          # Build extension + webview
bun run compile:quiet    # Build (quiet output - use this to save context)
bun run watch            # Watch mode (extension + webview in parallel)
bun run lint             # ESLint on src/**/*.{ts,tsx}
bun run test             # Jest tests (experimental VM modules)
bun run package          # Create VSIX package
```

## Development Workflow

**Always branch before making changes.** Never commit directly to main. Create a feature branch before any code changes:
```bash
git checkout -b fix/descriptive-name   # or feat/, chore/, etc.
```
Exception: If already on a feature branch and told to continue on it (e.g., multiple beads under one PR).

**Testing workflow with Chrome DevTools MCP**: After building, ask the user to reload code-server and test. Don't automate the reload/test cycle via browser tools - it wastes context.

**code-server for testing**: See `docs/code-server-testing.md` - living document for agent reference. Keep it updated with working config and lessons learned.

**Option 1: Extension Development Host (recommended for debugging)**

1. Open this repo in VS Code
2. Run `bun run watch` in terminal
3. Press `F5` to launch Extension Development Host
4. `Cmd+R` (Mac) / `Ctrl+R` (Win/Linux) to reload after changes

**Option 2: Symlink for local testing**

```bash
# Link extension to VS Code extensions directory
ln -s "$(pwd)" ~/.vscode/extensions/vscode-beads

# Reload VS Code window: Cmd+Shift+P → "Developer: Reload Window"
# Unlink when done
rm ~/.vscode/extensions/vscode-beads
```

**Option 3: Install VSIX locally**

```bash
bun run package                              # Creates vscode-beads-0.1.0.vsix
code --install-extension vscode-beads-0.1.0.vsix
```

## Architecture

VS Code extension for managing [Beads](https://github.com/gastownhall/beads) issues via `bd` CLI.

### Data Flow

1. **BeadsBackend** (`src/backend/BeadsBackend.ts`) - Single source of truth per project. Spawns `bd` CLI commands with `--json` output, parses responses.
2. **BeadsProjectManager** (`src/backend/BeadsProjectManager.ts`) - Discovers `.beads` directories in workspace, manages active project, daemon lifecycle.
3. **View Providers** (`src/views/`) - Extend `BaseViewProvider`, register webview views, handle message passing.
4. **React Webviews** (`src/webview/`) - Single React app with routing by `viewType`. Receives data via `postMessage`, sends actions back to extension.

### Key Patterns

- All Beads operations go through CLI (`bd list --json`, `bd show <id> --json`, etc.) - never access `.beads` files directly
- Status/priority normalization in `src/backend/types.ts` - CLI returns various formats, extension normalizes to internal types
- Webview↔Extension communication via typed messages (`ExtensionToWebviewMessage`, `WebviewToExtensionMessage`)
- Single webview bundle at `dist/webview/main.js` serves all views (Dashboard, Issues, Details); view type determines which component renders
- **Prefer components over ad-hoc markup**: Extract reusable UI elements into `src/webview/common/` components (e.g., `StatusBadge`, `FilterChip`) rather than inline spans with class names
- **No native HTML controls**: Don't use native `<select>`, `<input type="checkbox">`, etc. Use custom components (`Dropdown`, `ColoredSelect`) for consistent VS Code-themed styling

### Build System

- esbuild for both extension (Node/CommonJS) and webview (browser/IIFE)
- Extension entry: `src/extension.ts` → `dist/extension.js`
- Webview entry: `src/webview/index.tsx` → `dist/webview/main.js`

## Status/Priority Mapping

CLI status values are normalized: `in-progress`/`active` → `in_progress`, `completed` → `done`, etc.
Priority is 0-4 where 0 = Critical (P0), 4 = None (P4).

## CHANGELOG

Maintain `CHANGELOG.md` using [Keep a Changelog](https://keepachangelog.com/) format.

- Add entries under `## [Unreleased]` as features/fixes are completed
- Only log notable changes: features, bug fixes, breaking changes
- Skip minor/internal changes (refactors, typos, CI tweaks)
- Keep entries terse - one line per change, with bead reference (e.g., `vsbeads-xxx`)
- Use sections: `### Added`, `### Fixed`, `### Changed`, `### Removed`

At release time, `[Unreleased]` content moves to `## [x.y.z] - date`.

## Code Conventions

- **kebab-case**: Source code, docs, configs (`my-module.ts`, `api-reference.md`)
- **UPPERCASE**: Only for standard files (`README.md`, `CHANGELOG.md`, `CLAUDE.md`, `LICENSE`)

## Icons

Use [Font Awesome Free](https://fontawesome.com) icons unless there's a good reason not to. Icons are stored as SVG files in `src/webview/icons/` and imported via the `Icon` component or `icons` object. See `src/webview/icons/index.ts` for available icons.

## Upstream Sync

Periodically check [gastownhall/beads](https://github.com/gastownhall/beads) for changes that affect this extension:

- **Daemon API**: Check `internal/rpc/protocol.go` and `internal/types/types.go` for new operations, fields, or type changes. Update `BeadsDaemonClient.ts` and `docs/reference/beads-daemon-api.md`.
- **Bead types**: Check for new `issue_type` values (e.g., `merge-request`, `molecule`). Update `BeadType`, `TYPE_LABELS`, `TYPE_COLORS`, `TYPE_SORT_ORDER` in `src/webview/types.ts` and add icons.
- **CLI changes**: Check for new commands or flags that should be exposed in the extension.

Reference repo: `~/ws/reference/beads` - refresh with `git fetch && git pull` before investigating.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
