---
name: bd-cut
description: Cut a finalized implementation plan into a beads (bd) epic with dependency-ordered subtasks and correct blockers, ready for autonomous execution by /bd-run. Use whenever the user wants to turn a plan into beads issues — "cut this plan", "create a beads epic from this", "push this plan into bd", "file this in beads", "make issues from the plan" — or immediately after ce-plan produces an implementation-ready plan. Understands beads DAG semantics (blocks, parent-child, related, discovered-from), ready/blocked derivation, and the ce-unified-plan/v1 artifact contract. Trigger even on casual mentions like "get this into beads" or "bd this plan".
argument-hint: [plan path | blank to auto-discover newest implementation-ready plan] [epic:<existing-bd-id> to attach under an existing epic] [dry-run]
model: opus
---

# Cut a Plan into a Beads Epic

This skill converts a durable implementation plan (typically a `ce-plan` unified plan in `docs/plans/`) into a beads issue DAG: one epic, one child task per implementation unit, and dependency edges that make `bd ready` / `bd blocked` reflect the plan's true sequencing. It is the first half of a two-step pipeline — `/bd-cut` files the work, `/bd-run <epic-id>` executes it autonomously.

**This skill files work; it does not do work.** Never implement code, never resolve open plan questions, never edit plan content beyond the traceability write-back in Phase 5. Execution — including all status transitions past `open` — belongs to `/bd-run`.

## Beads Mental Model (read carefully — correctness lives here)

Beads is a dependency-aware issue tracker. Issues live in `.beads/` (Dolt/SQLite source of truth, JSONL export) and are manipulated via the `bd` CLI. `--json` on any command gives structured output.

**Issue types:** `task`, `bug`, `feature`, `epic`, `chore`. Plans become one `epic` plus `task` children (use `feature` only for a genuinely user-facing slice; when in doubt, `task`).

**Priorities:** `p0`–`p4` (0 highest). Default `p2`; high-risk or critical-path units may get `p1`.

**Statuses:** `open` ○, `in_progress` ◐, `blocked` ● (manual, external blockers only — dependency-blocking is _derived_ from open `blocks` edges), `closed` ✓, `deferred` ❄. Every bead this skill creates is `open` — the cut never sets any other status; that is `/bd-run`'s contract.

**Dependency types:**

| Type              | Meaning                                     | Affects ready/blocked? |
| ----------------- | ------------------------------------------- | ---------------------- |
| `blocks`          | Hard ordering — dependency must close first | **Yes**                |
| `parent-child`    | Epic membership. Structural only            | No                     |
| `related`         | Soft cross-reference                        | No                     |
| `discovered-from` | Provenance — found while working that issue | No                     |

**Direction is the #1 way to corrupt a DAG.** Canonical shape: `bd dep add <issue> <depends-on>` — the first argument waits on the second. Plan line "U3 — Dependencies: U1" → `bd dep add <U3-id> <U1-id>`. Epic membership: `bd dep add <child> <epic> --type parent-child` (or `--parent <epic>` at creation). **Never trust this paragraph over the installed CLI** — verify in Phase 0, sanity-check in Phase 5.

**Ready derivation:** an issue is _ready_ when open with zero open `blocks` dependencies. `parent-child` does not block — this is why you never model membership with `blocks`, and never model ordering with `parent-child`.

## Phase 0: Environment and Input Resolution

### 0.1 Verify the toolchain — never assume flags

1. `command -v bd` — if missing, stop and tell the user to install beads. Do not simulate.
2. `bd --version`, `bd --help`
3. `bd create --help`, `bd dep --help`

Confirm from help output before proceeding: the argument order and semantics of `bd dep add` (help text wins over this document); whether `bd create` supports `--parent`; flag names for type/priority/description; `--json` availability on `create`/`show`/`list`.

If no `.beads/` database exists, ask before `bd init` — the user may intend a different repo or a Dolt remote.

### 0.2 Resolve the plan

1. **Explicit path argument.** Verify it exists and is a plan document.
2. **`epic:<id>` argument** with a path — attach under that existing epic instead of creating a new one (skip epic creation in Phase 5; validate via `bd show <id> --json`).
3. **Blank** — newest `docs/plans/` file with `artifact_readiness: implementation-ready`. If several are plausible, ask which (blocking question, single-select). Never guess.

If the plan is `artifact_readiness: requirements-only`, stop: it hasn't been through planning enrichment. Suggest `ce-plan` first; proceed only on explicit override.

### 0.3 Idempotency check — never double-file

Before creating anything: `bd list -t epic --json` matched against the plan path, and check the plan frontmatter for a `beads_epic:` key (this skill writes one in Phase 5). If an epic already exists, ask: **update** (diff plan units against existing children — create missing tasks, add missing edges, flag orphaned tasks whose unit was deleted; never auto-delete), **hand off to `/bd-run` instead**, **replace** (explicit confirmation only), or **abort**. Default recommendation: update.

## Phase 1: Read the Plan

Extract per implementation unit: **U-ID and name** (`### U3. Name` headings), Goal, Requirements (R/F/AE citations), Dependencies (U-ID citations), Files, Approach, Execution note, Test scenarios, Verification. Also capture: plan title, type prefix (`feat`/`fix`/`refactor`), Goal Capsule / summary, phase groupings (Deep plans), Scope Boundaries, and `Deferred to Follow-Up Work`.

**Parsing rules:**

- U-IDs may have gaps (U1, U3, U5 is valid). Preserve them exactly; never renumber.
- A unit's `Dependencies` field is the **only** source of `blocks` edges. Document order is NOT a dependency signal — sequential units with no stated dependency are parallel work, and inventing edges destroys the parallelism the plan deliberately preserved (and that `/bd-run` will exploit).
- A cited U-ID that doesn't exist in the plan is a plan defect — ask, don't silently drop the edge.
- Non-`ce-plan` markdown: map whatever unit structure exists to this shape, state your mapping assumptions in the preview, lean harder on the confirmation gate.

## Phase 2: Build the Mapping

Construct the full DAG in memory before touching `bd`.

**Epic:**

- Title: the plan title (e.g., `feat: Add user authentication`)
- Type `epic`; priority from user signal or `p2`
- Description: condensed Goal Capsule, then `Plan: <plan-path>` on its own line (this line is `/bd-run`'s pointer back to the decision record — never omit it), then the Definition of Done if the plan has one

**One task per implementation unit** — 1:1, no exceptions without asking:

- Title: the unit name, standalone-readable (`Add session token rotation`, not `U3` — someone scanning `bd ready` should understand it without the plan open). No U-ID prefix.
- Description template — this is the entire brief a cold `/bd-run` subagent receives, so completeness here is load-bearing:

  ```
  Plan: <plan-path> (U<N>)

  Goal: <goal>
  Requirements: <R/F/AE citations, verbatim>
  Files: <repo-relative paths — /bd-run uses this field to detect
         file-surface conflicts between parallel beads; be complete>
  Approach: <condensed — decisions, not padding>
  Execution note: <only if the plan carries one>

  Test scenarios:
  <verbatim — the implementer's coverage contract; never summarize away>

  Verification: <verbatim — this is the bead's definition of done;
                /bd-run refuses to close a bead without it being met>
  ```

- Type `task` (or `feature` per the rule above); priority inherits the epic's unless the unit is high-risk (auth, payments, migrations, external APIs → consider `p1`).

**Edges:** `parent-child` every task → epic; `blocks` exactly the plan's Dependencies fields, direction per Phase 0.1; `discovered-from` only when updating and the plan says a unit emerged from executing another; no speculative `related`.

**Phases (Deep plans):** ask once — flat epic with tasks (default; `blocks` edges already encode ordering) or child epics per phase (only when phases have real semantic identity, not just sequencing).

**Deferred work:** items under `Deferred to Follow-Up Work` are NOT created by default. Offer once in the preview: "N deferred items — file as unblocked backlog issues outside this epic?" Never wire them as blockers.

**Open Questions:** surface unresolved plan questions in the preview. A question that genuinely gates a unit gets noted in that task's description — `/bd-run` will park the bead as `blocked` rather than guess, so an unresolved gate filed silently becomes a stalled bead later. Prefer resolving it with the user now, at the cheap checkpoint.

## Phase 3: Validate the DAG (before any writes)

Refuse to execute until all pass or the user explicitly overrides:

1. **Acyclicity.** Topologically sort the `blocks` edges. A cycle is a plan defect — report the path, stop.
2. **Direction sanity.** Restate each edge in words ("_Session rotation_ waits on _Token model_") against the plan's prose. One reversed edge silently inverts the whole workflow.
3. **Non-empty ready set.** At least one task with zero `blocks` deps — a plan where nothing is ready is mis-wired.
4. **No orphans.** Every task has a `parent-child` edge to the epic.
5. **Redundant transitive edges** (lint, not blocker). Keep, but note in the preview.
6. **Connectivity.** Fully parallel tasks are fine, but a mostly disconnected graph warrants asking whether the Dependencies fields are complete.

## Phase 4: Preview and Confirm

This gate is the pipeline's **one human checkpoint** — everything after it (`/bd-run`) is headless, so scope corrections are cheap here and expensive later. Present:

1. A compact table: title, type, priority, blocks (by title), for the epic and every task
2. A mermaid graph of the `blocks` DAG (epic membership omitted — noise) with the initial ready set marked
3. Counts: N tasks, M `blocks` edges, K initially ready — K is the parallelism `/bd-run` will open with
4. Lint notes from Phase 3, the deferred-work offer, open-question callouts, mapping assumptions for non-ce-plan inputs

If `dry-run`: print the exact `bd` command sequence that would run, and exit.

Otherwise ask: **Create** / **Adjust** (free-form edits, re-validate, re-preview) / **Abort**.

## Phase 5: Execute the Cut and Verify

**Order matters — IDs before edges:**

1. Create the epic (`--json`, capture ID). Skip if attaching to an existing epic.
2. Create every task (`--json`, capture IDs; `--parent` at creation when Phase 0.1 confirmed it, else batch `parent-child` edges after).
3. Add remaining `parent-child` edges, then all `blocks` edges in topological order — a mid-run failure leaves a coherent prefix.
4. **Verify against the live db, not your intentions:** `bd dep tree <epic-id>` matches the preview; `bd ready` matches the predicted ready set **exactly**; `bd blocked` shows every non-ready task with the right blockers. A ready-set mismatch means a reversed edge — find it, `bd dep remove` + re-add, re-verify. Never report success with a mismatched ready set.

**Partial-failure recovery:** stop, list created IDs vs. not-created, offer resume-from-failure or cleanup. Never leave the user guessing what half-exists.

**Traceability write-back** (skip on read-only plan locations): `beads_epic: <epic-id>` into the plan frontmatter; issue ID appended to each unit heading (`### U3. Name → <bd-id>`). This is what makes Phase 0.3 idempotency and future `update` runs reliable, and it completes the round-trip: plan → epic (the `Plan:` line) and epic → plan (this write-back).

## Phase 5.5: Handoff

The cut is not complete until the handoff is presented. `/bd-run` is user-invoked only (`disable-model-invocation`), so you cannot start it yourself — hand over a ready-to-paste command instead, exactly once:

```
Epic <epic-id> filed: <n> tasks, <m> blocks edges, <k> ready now.

Run it:   /bd-run <epic-id>
          (add max-parallel:<n> to change the default of 4)

Or:  bd ready            — inspect the opening frontier first
     /bd-cut ... update  — re-cut after plan edits
```

If open questions were filed into bead descriptions unresolved, say so here explicitly — those beads will park as `blocked` mid-run and wait for a human.

## Hard Rules

- Never model epic membership with `blocks`; never model ordering with `parent-child`.
- Never invent dependencies the plan doesn't state; never drop ones it does. Never renumber U-IDs.
- Never summarize test scenarios out of task descriptions — the bead description is the entire brief a cold executor receives.
- Every bead leaves this skill with status `open`. Claims, closes, and every other transition belong to `/bd-run`.
- Never create issues before the preview gate passes; never report success without the `bd ready` verification passing.
- The plan file stays canonical for decisions; beads is canonical for execution state. The `Plan:` line and the `beads_epic:` write-back are the contract between them — never omit either.
