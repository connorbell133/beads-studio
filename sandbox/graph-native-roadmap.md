# Making vscode-beads 10x better: the graph-native roadmap

A deep review of what this extension does today, what `bd` actually offers, and what anton
already proves you can build on top of beads — turned into a concrete, sequenced plan.

**Thesis:** beads is a *distributed graph database with agent memory*. This extension currently
presents it as *a sortable table*. Every genuinely 10x idea below comes from closing that gap.

---

## 1. Audit: where we actually are

### 1.1 CLI surface coverage

`bd`'s CLI reference lists roughly 120 commands and subcommands. This extension invokes
**thirteen verbs**: `list`, `show`, `create`, `update`, `close`, `dep add`, `dep remove`,
`comments`, `comments add`, `info`, `version`, `dolt status|start|stop`, `where`.

Never touched, and every one of them is a feature the UI could own:

| Area | Unused commands |
|------|-----------------|
| Graph/query | `ready` `blocked` `dep tree` `dep cycles` `graph` `epic` `children` `orphans` `search` `count` |
| Quality | `lint` `stale` `doctor` `preflight` `find-duplicates` `duplicates` `recompute-blocked` |
| Memory | `remember` `recall` `memories` `forget` `prime` `kv` |
| Coordination | `swarm` `gate *` `merge-slot` `human` `assign` `audit` |
| Workflows | `mol *` `formula` `cook` `todo` `promote` |
| History | `history` `diff` `branch` `vc` `restore` `backup` |
| Lifecycle | `defer` `undefer` `reopen` `note` `label` `tag` `supersede` `duplicate` `q` |
| Integrations | `github` `jira` `linear` `gitlab` `notion` `ado` |

### 1.2 Verified findings in the code

**a) The "ready" count is not readiness.**
`src/providers/DashboardViewProvider.ts:87` — `readyCount: byStatus.open`. In beads, *ready*
means "open **and no open blockers**"; that's the entire point of `bd ready`, and it's the only
thing the `blocks` edge type affects. On any project with real dependencies the dashboard's
headline number is simply wrong. `blockedCount: byStatus.blocked` has the same problem — it
counts a *status label*, not graph-derived blockage.

**b) The list payload carries no graph.**
`BeadsDoltBackend.list()` (`src/backend/BeadsDoltBackend.ts:122`) selects 15 columns from
`issues` and joins labels — **no dependency query at all**. Edges are loaded only per-issue, in
`loadDependencies(issueId)`, on the details path. So the extension holds ~N beads and zero edges
in the view model that every list/board/dashboard renders from.

Meanwhile `bd list --json` *already ships the edges inline*. Anton relies on exactly this
(`anton/src/lib/beads/bd.ts:456` — "ONE call for the whole board: `bd list --json` carries each
issue's `parent` and inline `dependencies`, so grouping + edges are derived in-process"). Our CLI
backend passes that payload straight through, but `BackendBeadDependency`
(`src/backend/types.ts:125`) expects the *shaped* `{id, dependency_type}` form that `bd show` and
the Dolt join produce — not the raw `{issue_id, depends_on_id, type}` rows `bd list` emits. So
even on the CLI path the edges land as `{id: undefined}` and are effectively discarded.

Net: the two backends disagree about graph fidelity, and both end up at zero. **This one fact
blocks every idea in section 3.**

**c) `viewInGraph` is a promise we don't keep.**
`BaseViewProvider.ts:174` and `BeadDetailsViewProvider.ts:230` both run
`executeCommand("beadsGraph.focus")`. There is no `beadsGraph` view in `package.json`. The
button does nothing.

**d) `normalizeBead()` is dead code.** `src/backend/types.ts:323` is referenced only by its own
test. It also parses the legacy `depends_on: string[]` shape bd 1.x no longer emits.

**e) Everything lives in the ~300px sidebar.** Three webview *views*, no webview *panel*. A DAG,
a board with swimlanes, a full-page bead editor, a burndown — none of them fit in a sidebar, and
that constraint has quietly shaped the whole product.

**f) We filter out the interesting types.** `HIDDEN_LIST_TYPES` drops `gate`, `agent`, `role`,
`message`. That's correct for backend parity with `bd list`, but it means the extension is
*structurally blind* to beads' coordination layer — gates, agent messages, human asks — which is
precisely what a multi-agent operator needs to see.

### 1.3 What anton already solved that we haven't

anton is the same data, one layer up, and it has working answers to our hardest problems:

| anton | file | what it gives us |
|-------|------|------------------|
| Epic-level rollup DAG, Kahn topo-rank, cycle flagging | `src/lib/epic-graph.ts` | The whole graph model, ~200 lines, pure over `Bead[]` |
| Pure dagre layout, framework-free by design | `src/components/epic/graph-layout.ts` | Drop-in, already unit-tested, no React types |
| Graph→view mapping, blocker→blocked orientation | `src/components/epic/{dependency,project}-graph-model.ts` | Direction conventions already reasoned through |
| `deriveStage`, `labelValue`, `createdMeta` | `src/lib/ticket-view.ts` | Derived stage from labels+PR ref; `agent:`/`risk:`/`size:` chips |
| Advisory claims, run leases, steal semantics | `src/lib/beads/{claim,bd}.ts` | How to render "who holds this, and is the lease stale" |
| Standalone/orphan lane | `src/lib/board.ts` | Parentless work is first-class, not lost |

anton derives *everything* at read time and stores nothing — "the board is never a cache to
reconcile" (DESIGN.md §3). That principle should be this extension's too.

---

## 2. The one unlock: a real graph model

Before any feature below, do this:

```
src/backend/BeadsGraph.ts        # pure, no vscode import, fully unit-testable
```

1. **Load edges in bulk.** Dolt backend: one extra `SELECT issue_id, depends_on_id, type FROM
   dependencies` alongside `list()` (same shape as `loadLabels`). CLI backend: normalize the
   inline `dependencies` rows `bd list --json` already returns. Add `parent` to both.
2. **Build the model once per refresh** — adjacency both directions, keyed by id.
3. **Derive**, never store:
   - `isReady(id)` = open ∧ no open `blocks` blocker → the real `bd ready`
   - `blockers(id)` / `blocking(id)` with reasons
   - `rank(id)` — Kahn longest-path topological rank (port from `epic-graph.ts`)
   - `cycles()` — flag edges in unresolved regions, degrade rank gracefully instead of throwing
   - `leverage(id)` — transitive count of beads a close would unblock
   - `subtree(id)` — parent-child rollup, completion %
4. **Ship it to the webview** as a compact edge list next to `setBeads`, so every view can reason
   about the graph without a round trip.

Cost: roughly one query, one module, one message field. Everything in §3 is then mostly UI.

---

## 3. The ideas

### Tier 1 — Graph-native (this is the actual 10x)

**1. A real Ready lane.**
Replace the dashboard's fake `readyCount` with graph-derived readiness, and make it a
first-class surface: *"What can I pick up right now"*, each row annotated with why it's ready and
what it unblocks. Blocked items show their blocker chain inline (`bd-a → bd-b → bd-c`), not just
a red badge.

**2. DAG view in an editor tab.**
A `WebviewPanel` (not a sidebar view) rendering the dependency graph left-to-right, blocker→blocked.
Port `graph-layout.ts` from anton verbatim — it was deliberately written free of React and XYFlow
types for exactly this reuse. Node = bead, tinted by status, dimmed when closed, ringed when it's
on the critical path. Click focuses the Details panel. Three lenses:
- **Epic rollup** — one node per epic, ticket-level edges rolled up (anton's `computeEpicGraph`)
- **Full graph** — every bead, filtered by the Issues panel's active filter
- **Blast radius** — one bead, N hops out, both directions

This is the single most visible upgrade and it makes the extension look like nothing else in the
marketplace.

**3. Tree view, graph-derived.**
`sandbox/tree-view-design-proposal.md` already designs the TanStack side. Build it on the graph
model instead of ad-hoc parent-child scanning, and add what the proposal doesn't have: an
**Orphans** lane for parentless work (anton's "Standalone" lane), and epic rows showing
`7/12 · 58%` rollup completion.

**4. Cycles as diagnostics.**
`bd dep cycles` → VS Code `Diagnostic`s in the Problems panel, with a code action that offers to
drop the weakest edge. Circular dependencies are the one beads failure mode with its own recovery
doc upstream; today we render them as an infinite-looking tree.

**5. Leverage scoring.**
For every bead, "closing this unblocks N others." Sort the ready lane by it. Badge the top three.
This is a genuinely novel view of a backlog — nothing else in the ecosystem shows it, and once
you have the graph it's ten lines.

**6. Critical path.**
Longest blocker chain to each epic's completion, highlighted in the DAG and flagged in the list.
"This epic is 9 sequential beads deep" is the most actionable planning fact there is.

### Tier 2 — IDE-native (things a web UI structurally cannot do)

**7. Code ↔ bead binding.**
A `DocumentLinkProvider` + `HoverProvider` that recognises bead ids (`vsbeads-a1b2`) in comments,
commit messages, and branch names. Hover shows title/status/assignee; click opens Details.
CodeLens on `TODO(bd-xxx)`. `Markdown.tsx:80` already posts `openFile` — nothing currently
*generates* those links. This closes the loop in both directions and is the feature people will
tell their teammates about.

**8. Quick capture from a selection.**
Select code → `Beads: Capture` → creates a bead via `bd q`, prefilled with `file:line`, a
permalink back, and a `discovered-from` edge to whatever bead is currently active. This is the
highest-frequency action in agent-adjacent work and today it requires leaving the editor.

**9. SCM integration.**
- Bead picker for the commit message box (SCM input box API)
- Branch ↔ bead inference; status bar shows the current bead
- On branch create: offer `bd update <id> --claim`
- On PR: write the PR url to `--external-ref` (anton's exact convention)

**10. Health as diagnostics, not an output channel.**
`bd lint`, `bd stale`, `bd doctor`, `bd preflight`, `bd orphans`, `bd find-duplicates` →
Problems panel + a "Beads Health" tree. `bd preflight` before a push is a natural pre-commit hook
surface.

**11. A full-page Bead editor.**
`WebviewPanel` with the full contract — Goal / Acceptance / Design / Notes — markdown editing,
comments thread, dependency editor, history. The sidebar Details panel stays as the quick view.

### Tier 3 — Agent-aware (the anton lessons, brought local)

**12. Presence layer: who holds what.**
Render `assignee`, claim state, and lease labels (anton uses `run-lease:<ts>` +
`stage:implementing`) as live ownership. A bead whose lease has expired gets a "stale claim"
warning. Make the swarm legible: an **Agents** view grouping in-flight work by holder, with
elapsed time. Right now multi-agent activity is invisible in the UI even though it's fully
recorded in the data.

**13. Project Memory panel.**
`bd memories` / `bd remember` / `bd recall` / `bd forget`. Beads' persistent-memory layer is
arguably its biggest differentiator over every other tracker, and the extension shows exactly
none of it. Add a Memory view plus **"Remember this"** on any selection or bead comment. Show
what `bd prime` would inject, so a human can see what their agents are being told.

**14. Human inbox.**
`bd human` beads are agents asking *you* a question. That deserves a badge on the activity-bar
icon and a notification — it's the one thing in the system that's actually blocking on a person.

**15. Gates view.**
Stop hiding `gate` beads; give them a lane. "What is this epic waiting on — CI, a review, a
human?" with `bd gate check` as a refresh action. Same for `merge-slot`: show who holds the mutex
and who's queued.

**16. Molecule / workflow position.**
`bd mol current`, `bd mol progress`, `bd mol ready` — render where a workflow instance sits in its
formula. This is beads' most under-explained feature; a picture would do more for adoption than
the docs do.

**17. Namespaced label chips, config-driven.**
anton renders `agent:`, `risk:`, `size:`, `stage:` as typed chips rather than generic labels.
Generalise it: `beads.labelNamespaces` maps a prefix to a chip style + a filter facet. Any team's
convention becomes first-class UI for free — and anton's board becomes reproducible inside VS Code.

**18. Approve / claim controls.**
Optional, config-gated: an Approve button that writes the `approved` label, Claim/Release that
set and clear assignee with anton's soft-lock semantics (refuse to steal without an explicit
override). This makes the extension a viable *control surface* for an anton pipeline, not just a
viewer.

**19. Language Model Tools.**
Register the graph model as VS Code Language Model Tools (`bd ready`, `bd show`, `bd create`,
`bd dep add`). Copilot/Claude *inside the IDE* then gets the bead graph with zero MCP setup —
the extension becomes the integration point instead of another thing to configure. Given anton
drives `claude` headlessly outside the editor, this is the in-editor counterpart of the same idea.

**20. anton bridge.**
Detect an anton server on `localhost:3000`; if present, show per-bead run status, PR link,
and a "open run" action. The two tools are looking at the same `.beads/` — they should
acknowledge each other.

### Tier 4 — Dolt-native (nobody else can do this at all)

**21. Time travel.**
beads is Dolt. Every historical state is queryable. A date scrubber on the board — *"show me the
backlog as of last Friday"* — is a few `AS OF` queries and is the single best demo this
extension could possibly have.

**22. Bead blame.** `bd history <id>` inline: who changed status/priority/assignee, when, and in
which commit.

**23. Branch-aware diff.** `bd diff main..feature` → "this branch adds 3 beads, closes 5, changes
2 priorities." Review a *plan* the way you review code.

### Tier 5 — Insight

**24. Velocity.** Burndown, throughput, cycle-time — all derivable from `created_at`/`closed_at`
already in the payload. Per-epic completion forecast from historical close rate.

**25. Aging heat.** `bd stale` + age-based tinting. Backlogs rot silently; make it visible.

### Tier 6 — Plumbing that makes the rest possible

**26. Editor-tab panel host.** A `BeadsPanelHost` that opens any view as a `WebviewPanel`. Single
biggest unblock for Tier 1 and 2.

**27. Change detection, properly.** `dolt_hashof_db()` polling exists on the Dolt path; the CLI
path returns `null` from `getChangeToken()` and falls back to a fixed 3s timer. Add a
`FileSystemWatcher` on `.beads/` for the CLI path, and back off polling when the window is
unfocused.

**28. Command palette parity.** Every action reachable by keyboard. Today five commands are
registered and the Dolt controls are dashboard-only by deliberate choice — but ready/capture/
graph/search deserve bindings.

**29. Move derivation out of providers.** `DashboardViewProvider` computing the summary inline is
how (a) happened. Summary, stage, readiness, chips → one derivation module with tests, consumed
by every view. That's anton's `ticket-view.ts` rule, and it's the reason anton can add a field in
one place.

---

## 4. Sequencing

**Phase 0 — Foundation (unblocks everything).**
Bulk edge loading in both backends · `BeadsGraph.ts` + tests · fix `readyCount`/`blockedCount` ·
`WebviewPanel` host · delete `normalizeBead`, fix or remove `viewInGraph`.

**Phase 1 — Graph-native.** Ready lane · DAG view in an editor tab · tree view · cycle
diagnostics · leverage + critical path.

**Phase 2 — IDE-native.** Bead links/hover/CodeLens · quick capture · SCM integration · health
diagnostics · full-page bead editor.

**Phase 3 — Agent-aware.** Presence/leases · memory panel · human inbox · gates · label
namespaces · LM Tools.

**Phase 4 — Dolt-native + insight.** Time travel · blame · branch diff · velocity.

Phase 0 + 1 alone is the 10x. Phases 2–4 are what make it the only tool anyone uses for beads.

---

## 5. Non-goals and risks

- **Don't fork the data model.** Everything stays derived from `bd` / Dolt at read time. anton's
  "never a cache to reconcile" rule is the reason its board is trustworthy.
- **Don't break backend parity.** Every graph feature must produce identical results on the CLI
  and Dolt paths, or the extension becomes mode-dependent — the failure this audit already found.
- **Watch the version floor.** Several proposals need commands that may post-date
  `MIN_SUPPORTED_BD_VERSION`. Feature-detect, degrade gracefully; never let an unknown flag take
  down a view (bd rejects unknown flags outright).
- **Respect the sidebar.** Sidebar views stay fast and narrow; the ambitious surfaces go in
  editor tabs. Don't make the quick view slow to serve the big one.
