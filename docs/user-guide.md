# User Guide

Reference for commands, settings, day-to-day usage, and troubleshooting.

## Usage

1. Initialize: `bd init`
2. Click the Beads icon in the Activity Bar
3. If needed, use the dashboard controls to inspect/start/stop Dolt for the active project

### Issues panel

- Search by title, description, or bead ID
- Status preset dropdown beside the search box (All, Not Closed, Active, Blocked, Closed); add further filters beyond the preset as needed
- Rows are grouped under their epic with sticky collapsible headers; a "No epic" group collects the rest
- Edit status and priority in place from the row
- Click a row to view details, click the bead ID to copy it

### Details panel

- Click badges to edit type/status/priority inline
- "Assign to me" quick action for assignee
- Add/remove labels with auto-generated colors
- Markdown rendering in description/notes
- View dependencies grouped by relationship type

### Dependency graph

- Open with `Beads: Open Dependency Graph` (`Cmd/Ctrl+Alt+G`) or "View in graph" from Details
- Switch lenses in the toolbar to scope what's drawn (per-epic subtree, ready frontier, blast radius, plan drift)
- The status preset dropdown filters what every lens draws
- Hover a bead to isolate its chains; use arrow keys to traverse edges
- Find-in-graph: `Cmd/Ctrl+Alt+F`

#### Plan drift

Answers "what did the swarm do overnight" and "does the roadmap we agreed on
Monday still exist". Pick a comparison point from **Compare against…** — since
yesterday, last 3 days, last week, last 30 days, or one exact commit — and each
bead that moved since then is marked on the graph: `new`, `closed`, `reopened`,
`rescoped`, `repriced`, or `touched`.

The comparison annotates whatever lens you are on, so an epic you are already
watching can show its overnight changes without switching away. The **Plan
drift** lens narrows the picture to just the beads that moved, plus one hop of
blocking context.

Two limits worth knowing, both from `bd`:

- **Deleted beads are reported but never drawn.** They have no node left in the
  graph, and inventing one would put work on the canvas the project no longer
  contains. The count appears in the notice above the picture.
- **`touched` means "changed in a way `bd diff` does not name"** — most often a
  dependency rewire. `bd` reports no historical dependencies (neither
  `bd diff --json` nor `bd show --as-of` carries them), so the graph will not
  guess which link moved.

## Commands

Available in the Command Palette:

| Command                           | Description                     |
| --------------------------------- | ------------------------------- |
| `Beads: Switch Project`           | Select active project           |
| `Beads: Refresh`                  | Refresh all views               |
| `Beads: Open Issues Panel`        | Focus the Issues view           |
| `Beads: Open Issue Details`       | Focus the Details view          |
| `Beads: Open Dependency Graph`    | Open the graph in an editor tab |
| `Beads: Find in Dependency Graph` | Search for a bead in the graph  |
| `Beads: Show Ready Work`          | Jump to unblocked work          |
| `Beads: Copy Issue ID`            | Copy the selected bead ID       |

Starting and stopping Dolt, showing Dolt status, and opening the Dolt log are dashboard
controls rather than palette commands.

## Settings

| Setting                   | Default | Description                                               |
| ------------------------- | ------- | --------------------------------------------------------- |
| `beads.pathToBd`          | `"bd"`  | Path to `bd` CLI                                          |
| `beads.projects`          | `[]`    | Extra project paths to load (project root or `.beads`)    |
| `beads.refreshInterval`   | `3000`  | Dolt change polling interval in ms (0 = disable)          |
| `beads.renderMarkdown`    | `true`  | Render markdown in text fields                            |
| `beads.userId`            | `""`    | Your user ID for "Assign to me" (defaults to $USER)       |
| `beads.tooltipHoverDelay` | `1000`  | Delay in ms before showing tooltip on hover (0 = disable) |

## Troubleshooting

**"No Beads projects found"** — Run `bd init` in project root

**Dolt not available / issues not loading** — Use the dashboard actions to inspect Dolt status or start the Dolt server for the active project

**Commands fail** — Check the "Beads" output channel, verify `bd` is in PATH
