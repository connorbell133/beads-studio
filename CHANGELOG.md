# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Dependency graph refreshes itself every 5 seconds while its tab is visible, and carries a Refresh button for reading it again now (vsbeads-1ea)

### Changed

- Closed beads read purple, matching the epic they belong to, and pinned beads move to yellow — on the graph, the Issues list, the board, and the details panel
- Epic picker lists only epics with work still open, behind a "Show completed" toggle; the epic being viewed stays listed after it finishes

### Fixed

- Epic graphs keep their shape as work closes: a satisfied dependency is drawn recessed instead of deleted, and layout no longer re-flows every time a blocker lands
- Issues list keeps its filters, search text, and preset across a manual Refresh (vsbeads-fvl)

## [1.0.0] - 2026-08-12

### Added

- Dependency graph in an editor tab, opened with `Beads: Open Dependency Graph` or the Details panel's "View in graph"
- Dashboard rebuilt as a pulse surface for agent-swarm operators (vsbeads-zra): a "last hour" delta line (closed · filed · newly ready, with newly-ready tracked by diffing the graph's ready set across refreshes), stale-claim detection flagging in-progress beads untouched past two hours (a wedged agent, more often than not), and an activity feed of the five most recently touched beads with relative times. A flat stat strip routes each count to the Issues list pre-filtered (Total, Doing, Blocked) or opens the best ready pick (Ready); the stacked status bar sits directly under the strip as its denominator, captioned only with what the strip doesn't carry ("20 of 40 closed · 1 deferred"); a single graph-chosen "Up next" row and a toolbar button that opens the dependency graph round out the view. The dashboard's own ready/blocked/doing lists and label chips are gone: rows live in the Issues panel, the dashboard routes to them (vsbeads-vlw)
- Dependency cycles reported in the Problems panel
- "unblocks N" leverage and per-epic critical path
- One bead selection shared across every surface, plus command-palette entries for ready work, the graph, find-in-graph, and tree mode
- Tree mode for the Issues list, with an Orphans lane and child-completion rollup on epic rows
- DAG legibility at scale: find-in-graph, fit-to-selection, hover chain isolation, density auto-collapse above 150 nodes, and edge-following keyboard traversal
- Keyboard navigation for graph and lane surfaces, and a visible focus state throughout

### Changed

- Rebranded to **Beads Studio** (`connorbell133.beads-studio`): new publisher, new original logo replacing the Flaticon-derived icon, repository moved to [connorbell133/beads-studio](https://github.com/connorbell133/beads-studio) (vsbeads-nft)
- Graph lenses simplified: the Epics roll-up lens is gone (orphan top-level beads belong to All beads), the per-epic lens is renamed Epics and is now the default view, and over-dense graphs collapse to one epic instead of the roll-up (vsbeads-cfe)
- On the Epics lens the anchor epic is drawn as the goal — accent hue, heavier outline, "goal" flag and its closed count — instead of wearing ready's green (vsbeads-oea)
- Issues list redesigned in the style of Linear, mapped to beads-native objects (vsbeads-cgu, vsbeads-a9c, vsbeads-mkq, vsbeads-55o, vsbeads-fmn): rows are priority glyph · bead id · status ring · type icon · title · blocked-by/blocking chips from the dependency graph, grouped under their epic with sticky collapsible headers and a "No epic" group; status and priority are edited in place from the row; epic progress is a ring with the fraction on hover; labels, updated time, and assignee appear as the panel affords them, title first. Replaces the table and tree modes and their column chrome (headers, resizing, drag-reorder, show/hide menu)
- Issues toolbar condensed: the status preset is a dropdown beside the search box, and the filter row appears only for filters added beyond the preset — a preset no longer explodes into a row of chips (vsbeads-bft)
- The dependency graph carries the same filter row as the Issues list — status preset dropdown plus priority/type/assignee/label menus with faceted counts — filtering what every lens draws; filtered beads count into "not shown" (vsbeads-cwj, vsbeads-519)
- The graph's "same graph as text" list wears the Linear row anatomy (priority glyph · id · status ring · type icon · title), keeping its arrow-key and screen-reader contract and the "blocked by" text lines (vsbeads-519)
- Kanban cards adopt the issues list's anatomy — priority glyph · id · type icon with an initials avatar in the header, label pills below the title — replacing P-pills, raw assignee text, and tag-icon label rows (vsbeads-50i)
- The graph's filter controls sit inline on the toolbar row instead of floating detached beneath it, wrapping with the rest as the panel narrows (vsbeads-aw3)

### Fixed

- Graph empty states now say what the active lens shows and where to switch it; lens buttons carry plain-language tooltips; an anchored blast radius with no links gets its own message instead of the epic roll-up's; the graph header and text-list disclosure explain themselves (vsbeads-x00)
- Collapsed kanban columns render as clean uniform rails — counts pinned in an aligned row at the top, no ragged mid-column divider, long status names truncated (vsbeads-e2p)
- Graph layout bounds now cover routed edge arcs, so containment tethers no longer bleed into an off-centre letterbox and "Fit all" frames everything drawn (vsbeads-99t)
- Dashboard "Ready" and "Blocked" counts are derived from the dependency graph instead of counting status labels, so a bead with open blockers no longer counts as ready
- Dependency edges from `bd list --json` were discarded because the extension expected the `bd show` shape; the extension had never loaded a graph
- Gate and agent beads are now loaded so readiness can account for them, and filtered only where they are displayed
- Beads with no priority set no longer render as P0 Critical on the Dolt backend
- Badge colours are derived from VS Code theme tokens, fixing text that failed contrast on light and high-contrast themes
- "View in graph" opened a view that was never registered and silently did nothing

## [0.14.1] - 2026-07-30

### Fixed

- Markdown list bullets and numbers no longer get clipped out of description, design and notes fields

## [0.14.0] - 2026-07-30

### Added

- Icons, labels and colors for bd issue types `decision`, `message`, `gate`, `spike`, `story`, `milestone` and `event`
- Kanban columns for `deferred`, `pinned`, `hooked` and custom statuses, shown when beads use them
- `beads.projects` setting is now declared so it appears in the Settings UI (#76)

### Changed

- Minimum supported bd version raised to 1.0.5 (required for `bd show --include-dependents`)
- Dolt SQL backend now hides gate, infrastructure and template beads, matching `bd list` defaults

### Fixed

- Beads with `deferred`, `pinned`, `hooked` or user-defined custom statuses no longer disappear from every view
- Status/type dropdowns keep a bead's own custom value selectable instead of rendering as empty
- Dashboard "by status" bars fall back to the unknown-status color instead of rendering uncolored
- Bead Details panel now lists dependents on embedded Dolt projects, which bd 1.0.5+ omits from `bd show --json` unless requested
- `beads.userId` and `beads.pathToBd` now expand `${env:VAR}` placeholders (#60)
- Embedded Dolt projects now load Dashboard and Issues through the CLI backend without calling `bd dolt start`, including closed issues for the `All` filter (#77)
- Bead Details panel loads on bd >= 1.1 databases where the `dependencies` schema dropped `depends_on_id`; both old and new schemas supported (#79)
- Refresh now activates a newly discovered project instead of leaving views empty (#64)
- Backend-mode detection now times out after 5s so a hung `bd` cannot block project activation
- Dashboard and Issues views no longer spin on "Loading" forever when no Beads project is found; they show recovery hints, and discovery/`bd` path failures are logged at warn level (#76)
- Windows absolute paths are no longer treated as project-relative when opening files from bead details (#76)

## [0.13.0] - 2026-03-20

### Added

- Direct Dolt-backed backend with bd cli execution to bootstrap config/locations
- Projects panel for project and server management
- Real-time change detection via Dolt change-token polling

### Changed

- Project switching now updates immediately with improved loading feedback
- Removed daemon-era terminology and management surfaces
- Removed "Create Issue" quick command from editor UI

### Removed

- Daemon RPC client and socket management (removed in beads v0.50.0)
- Daemon start/stop commands and status bar lifecycle controls
- Auto-start daemon setting and zombie daemon detection

### Breaking Changes

- Requires beads v0.50.0 or later (daemon removed upstream)

### Fixed

- Dashboard project link hover target now limited to path text only
- Project switching no longer stalls on refresh sequencing
- Backend discovery and loading more stable with reduced refresh churn
- CLI backend properly isolated per project using BEADS_DIR
- Harden Dolt backend lifecycle and restore dashboard drill-down/refresh

## [0.12.0] - 2026-01-31

### Added

- Kanban board view toggle for Issues panel ([#56](https://github.com/jdillon/vscode-beads/pull/56) by [@micahbrich](https://github.com/micahbrich)) (`vsbeads-h5f`)
- Display bead IDs directly on kanban cards for quick reference (`vsbeads-zsz`)
- Display labels on kanban cards with truncation for long label lists (`vsbeads-89u`)
- Make all kanban columns collapsible, including the closed column (`vsbeads-cjh`)
- Use Lucide icons for kanban/table view toggle instead of Font Awesome (`vsbeads-uvh`)
- Improved filter state visibility: show "3/5" count when filters hide items
- Configurable tooltip delay on bead hover (set to 0 to disable) (`vsbeads-uvh`)

### Fixed

- DetailsView crashes when encountering unknown dependency types (`vsbeads-e74`)

## [0.11.0] - 2025-12-30

### Added

- Support for merge-request and molecule bead types (`vsbeads-rt9j`)
- Dependency type selector with direction support when editing (`vsbeads-hw6t`)
- Fallback handling for unknown bead types (`vsbeads-madg`)
- Type sort order for consistent epic-first display (`vsbeads-6d1`)
- Markdown links to relative files open in VS Code editor (`vsbeads-2byn`)

### Fixed

- Labels column empty on fresh VS Code startup (`vsbeads-re92`)
- Details panel children list vanishes when bead is updated (`vsbeads-u5xh`)
- Tooltip content shows raw markdown instead of rendered (`vsbeads-79pr`)
- Dependency display reordered: parent first, then children (`vsbeads-ifcn`)
- Show P? badge for dependencies with undefined priority (`vsbeads-mwr`)

## [0.10.0] - 2025-12-17

### Added

- Update activity bar icon with improved beads artwork (`vsbeads-94s`)

### Fixed

- Eliminate excessive spacing in markdown lists (`vsbeads-l27`)
- Edit mode now supports external_ref and estimate fields (`vsbeads-96o`, `vsbeads-7r2`)
- Improve external_ref display with clickable URL links (`vsbeads-7ba`)
- Normalize control heights to 20px across all panels (`vsbeads-cf6`)
- Add retry resilience for transient daemon errors (database is closed) (`vsbeads-m98`)

## [0.9.0] - 2025-12-11

### Added

- Label filter option for Issues list with autocomplete and counts (`vsbeads-65h`)
- FontAwesome icons for issue types and UI elements
- Tag/label icon to label displays (`vsbeads-qlp`)
- Time display in timestamps in Details panel footer (`vsbeads-ipb`)
- Improved timestamp display formatting (`vsbeads-vq3`)

### Fixed

- Typography inconsistency across dropdown menus (`vsbeads-efp`)

## [0.8.0] - 2025-12-10

### Added

- Assignee column and filter to Issues view with "Assign to me" quick action (`vsbeads-s2c`)
- Move labels inline with type/status/priority badges at top of Details panel (`vsbeads-677`)
- Timestamp component with timezone-aware display and adaptive formatting (`vsbeads-5bz`, `vsbeads-izh`)

### Fixed

- Clicking bead ID in Issues list now selects row and updates Details panel (`vsbeads-qgo`)
- Dropdown menus now close when clicking outside webview panel (`vsbeads-tbq`)
- Timestamp sorting now handles cross-timezone comparisons correctly (`vsbeads-5bz`)

## [0.7.0] - 2025-12-08

### Added

- Windows TCP socket support for daemon connection ([#30](https://github.com/jdillon/vscode-beads/pull/30) by [@cg-shmoop](https://github.com/cg-shmoop))

### Fixed

- Auto-recover from stale daemon socket after system reboot (`vsbeads-ugm`)
- Centralize daemon error notifications to avoid notification spam (`vsbeads-ugm`)

## [0.6.0] - 2025-12-05

### Added

- Error notifications when bd commands fail with output console access (`vsbeads-ycx`)
- Persist sort order, column visibility, and column order across reloads (`vsbeads-4fw`)
- Multi-column sorting with shift+click for secondary sort (`vsbeads-gsb`)

### Fixed

- Dynamic updates from daemon events now properly registered (`vsbeads-7eg`)
- Project list now refreshes when workspace folders are added/removed (`vsbeads-s4i`)
- Button press feedback now visible on webview buttons (`vsbeads-zsy`)
- Browser context menu disabled on Issues table (`vsbeads-zvs`)
- Global search now works correctly with TanStack Table
- Column resize no longer triggers column reorder

### Changed

- Issues view migrated to TanStack Table v8 (`vsbeads-4uw`, `vsbeads-7yz`)
- Updated beads logo SVG in activity bar icon (`vsbeads-94s`)

## [0.5.0] - 2025-12-03

### Added

- Project selector in Dashboard view for consistency (`vsbeads-xbq`)
- "Start Daemon" button on socket connection errors (`vsbeads-xbq`)
- Custom project dropdown with daemon status indicators per project (`vsbeads-d8u`)
- Status bar item showing daemon health with click-to-manage menu (`vsbeads-ly2`)
- Daemon restart command and zombie daemon detection (`vsbeads-ly2`)
- Prompt to init uninitialized projects with terminal helper (`vsbeads-ly2`)

### Fixed

- UI no longer blocked when daemon not running - project switching always available (`vsbeads-xbq`)
- Improved daemon start logging - shows command, cwd, and errors (`vsbeads-868`)
- Project dropdown now updates status indicators on daemon connect/disconnect (`vsbeads-ly2`)

### Changed

- Extracted reusable `Dropdown` and `ChevronIcon` components for consistent dropdown behavior
- Upgraded logging to use VS Code's `LogOutputChannel` for colored output and log levels (`vsbeads-868`)

## [0.4.0] - 2025-12-01

### Added

- Assignee and Estimate columns (hidden by default) (`vsbeads-kz0`)
- Comments render with markdown support (`vsbeads-rtk`)

### Fixed

- Column resize now works properly in Issues list (`vsbeads-oqb`)
- Table fills container width while respecting column minimums (`vsbeads-385`)
- Labels column shows all labels with ellipsis overflow (`vsbeads-8et`)
- Badge cells clip cleanly without ellipsis on overflow
- Column menu closes on click outside (`vsbeads-1nq`)
- Removing labels via X button now persists on save (`vsbeads-7g6`)
- Save button disabled when no pending changes
- Menus close when clicking outside VS Code webview
- Filter preset selector now uses styled dropdown (`vsbeads-cp3`)
- Sort labels alphabetically (case-insensitive) in Issues and Details views (`vsbeads-qtl`)

### Changed

- Removed unused Kanban and Graph view code

## [0.3.0] - 2025-11-30

### Added

- Colored dropdowns for type/status/priority in edit mode (`vsbeads-fwp`)
- TypeBadge and FilterChip components (`vsbeads-fwp`)
- Inline editing from Details view with auto-save (`vsbeads-fwp`)

### Changed

- Badge text normalized to lowercase with small-caps (`vsbeads-fwp`)
- Badge sizing unified with CSS variables (`vsbeads-fwp`)

### Fixed

- Filter count overlay stays fixed when scrolling (`vsbeads-eeg`)
- Filter menu: added submenu indicators and click-outside dismiss (`vsbeads-3zm`)

## [0.2.0] - 2025-11-29

### Added

- Auto-generated label colors from label name with contrast-aware text (`vsbeads-gfr`)
- Version and timestamp logging on extension activation

### Changed

- Dependencies now grouped by relationship type: Parent/Children, Blocked By/Blocks, Discovered From/Spawned, Related (`vsbeads-bci`)

### Fixed

- Daemon client resilience with exponential backoff (1s → 30s) on polling errors (`vsbeads-5nm`)
- CLI syntax for daemon commands: `start/stop` → `--start/--stop`
- Null/undefined API response handling to prevent "Cannot read properties of null" errors

## [0.1.2] - 2025-11-28

### Added

- Click-to-copy bead ID in issues list rows (`vsbeads-fyn`)
- Blocked, Closed, and Epics filter presets (`vsbeads-fb7`)
- Copy ID button in Details panel title bar (`vsbeads-jru`)
- "Blocks" section in Details showing dependent issues with type-colored badges (`vsbeads-jue`)
- Status and priority badges in dependency/dependent lists (`vsbeads-c04`)
- Sort dependency lists by status then priority (blocked→in_progress→open→closed, then P0→P4)
- `compile:quiet` script for reduced build output

## [0.1.1] - 2025-11-27

### Added

- GitHub Actions CI workflow for PR/push validation (`vsbeads-vt6`)
- GitHub Actions release workflow for marketplace publishing (`vsbeads-vt6`)
- VSIX artifact upload on CI runs for manual testing (`vsbeads-vt6`)
- Marketplace icon and README attribution

## [0.1.0] - 2025-11-27

First public release.

### Features

- **Issues Panel** - Sortable, filterable table with search and column customization
- **Details Panel** - View/edit individual issues with markdown rendering
- **Multi-Project** - Auto-detects `.beads` directories, switch between projects
- **Daemon Management** - Auto-start option, status monitoring

### Technical

- React-based webviews with VS Code theming
- Communicates with Beads via `bd` CLI (JSON output)
- esbuild for extension and webview bundling
