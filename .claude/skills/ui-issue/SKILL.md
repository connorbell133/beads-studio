---
name: ui-issue
description: File a UI/UX defect in beads from a quick description — capture only, no investigation. Use for "file a UI issue", "log this visual bug", "the X page looks wrong, track it".
---

Hand `$ARGUMENTS` to the **`ui-issue-filer`** agent and report what it filed.
Noticing a defect while using the app should cost one sentence, not a detour
into the component tree — so this runs on Haiku, off your session's context.

## Dispatch

One `Agent` call, `subagent_type: "ui-issue-filer"`, synchronous
(`run_in_background: false`) — the issue ID is the deliverable, so waiting for
it is the point.

The prompt is the user's own words, verbatim, plus the route if they named one
or you already know it from the conversation. Nothing else: the agent has
`Bash` for `bd` and no file access, and that is deliberate.

## Do not

- **Do not investigate first.** No reading the component, no grepping for the
  class, no "let me just check which file that is". If you already know the
  route from context, pass it; do not go find it.
- **Do not pre-write the issue** and use the agent as a typist. The defaults
  (type, priority, `ui-ux-cleanup` label, title shape, epic parenting) live in
  the agent definition — restating them in the prompt just risks contradicting
  them.
- **Do not fix anything**, or offer to. Analysis is deliberately deferred to
  whoever claims the issue.

## Report

The ID and title the agent returns, on one line. Then stop.

Several defects in one breath → one dispatch each, in a single message so they
run concurrently. They are independent `bd create`s and do not conflict.
