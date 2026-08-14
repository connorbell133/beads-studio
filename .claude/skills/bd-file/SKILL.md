---
name: bd-file
description: File any beads issue — bug, task, feature, chore — from a quick description. Capture only, no investigation, no fixing. Use for "file a bug", "log this", "track that", "make an issue for X", "add a bead", "don't let me lose this", or any passing mention of a defect, gap, regression, or idea the user wants tracked — even mid-conversation about something else. Scope: project work tracked in this repo's beads database, NOT personal todos or reminders (those belong to the user's personal task system).
argument-hint: "<what you saw or want tracked, e.g. exporter drops rows with unicode names>"
---

Hand `$ARGUMENTS` to the **`issue-filer`** agent and report what it filed.
Noticing something while working should cost one sentence, not a detour into
the codebase — so this runs on Haiku, off your session's context.

## Dispatch

One `Agent` call, `subagent_type: "issue-filer"`, synchronous
(`run_in_background: false`) — the issue ID is the deliverable, so waiting for
it is the point.

The prompt is the user's own words, **verbatim**, plus context you already
hold — never context you'd have to go get:

- A locating detail already in the conversation: route, file path, command,
  error line, environment. Pass it as-is; do not go find it.
- A stated type or priority ("p1", "just a chore"). Stated beats inferred, so
  pass it; otherwise say nothing and let the agent's defaults decide.
- An active epic or bead from the conversation (an `/bd-run` in flight, a
  bead being discussed): pass its ID so the agent can wire `parent-child` or
  `discovered-from`. No ID in context → pass nothing; the agent never hunts
  for one.

Nothing else. The agent has `Bash` for `bd` and no file access, and that is
deliberate.

## Do not

- **Do not investigate first.** No reading the file, no grepping for the
  symbol, no reproducing the bug, no "let me just check". If you already know
  the locating detail from context, pass it; if you don't, the claimer finds it.
- **Do not pre-write the issue** and use the agent as a typist. The defaults
  (type inference, priority heuristics, title shape, description shape, link
  wiring) live in the agent definition — restating them in the prompt just
  risks contradicting them.
- **Do not fix anything**, or offer to. Analysis is deliberately deferred to
  whoever claims the issue — human, or an `/bd-run` subagent.
- **Do not dedupe.** A duplicate bead costs one merge later; a dedup search
  costs every capture now. Wrong trade.

## Report

The ID and title the agent returns, on one line. Then return to whatever the
conversation was about — filing is an aside, not a topic change.

Several items in one breath → one dispatch each, in a single message so they
run concurrently. They are independent `bd create`s and do not conflict.
