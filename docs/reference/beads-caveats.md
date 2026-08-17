# Beads Caveats & Known Issues

Notes on beads behavior, naming changes, and gotchas encountered during development.

## JSONL Filename Change (v0.25.1)

**Canonical filename is now `issues.jsonl`** (not `beads.jsonl`).

- Changed in beads v0.25.1 (JSONL Canonicalization, bd-6xd)
- Old `beads.jsonl` name is legacy
- Source: `internal/configfile/configfile.go:24`
- Reference: https://github.com/gastownhall/beads/issues/409#issuecomment-3592298397

If you have an older setup with `beads.jsonl`, beads should handle migration automatically, but verify your `.beads/.gitignore` references the correct filename.

## bd doctor Warnings After Fresh Init

`bd doctor` may show warnings immediately after `bd init` - this is a known UX issue. A fresh init shouldn't require doctor fixes.

Reference: https://github.com/gastownhall/beads/issues/409

## Protected Branch Worktree

When using `--branch` mode, beads creates a git worktree at `.git/beads-worktrees/<branch>`. If this gets corrupted:

```bash
bd init --branch beads-metadata --force
```

## Dolt Status and Protected Branch Sync

In protected-branch mode, issue data still syncs through the metadata worktree, but daemon-specific guidance is obsolete.

- Use `bd sync` to reconcile metadata branch changes
- Use `bd hooks install --force` after upgrading `bd`
- If the extension cannot read issue data, check the active project's Dolt status from the dashboard or with `bd dolt status`

## Events Journal (bd >= 1.2.1)

`bd events tail --follow` streams every committed mutation as JSON lines. The
extension subscribes to it (`src/backend/bd-events-feed.ts`) so views refresh
when beads actually change rather than on a timer. Four properties of the
journal decide how that subscription has to be written.

**It is opt-in, and a disabled journal fails silently.** Records are only
emitted while `events-journal` is on:

```bash
bd config set events-journal true
```

With it off, `bd events tail --follow` still starts, still exits 0, and then
prints nothing forever - verified against bd 1.2.1. A disabled journal is
therefore indistinguishable from a quiet project at the stream level. Never
infer availability from the stream: read `bd config get events-journal --json`
first, which also resolves `BD_EVENTS_JOURNAL` from the environment.

**`bd sql` writes bypass it.** Raw DML does not go through bd's mutation seam,
so it is journaled nowhere and no consumer of the feed will ever see it.

**It is per-branch and per-replica, so it does not survive `dolt pull`/merge.**
Rows that arrive by sync were not mutated on this clone, so nothing journaled
them here. A `bd dolt pull` can change every bead on screen and produce no
events at all.

Because of those last two, the extension slows its poll when the feed is live
(5s -> 60s on the graph tab) rather than removing it. The poll is the only thing
that closes those two gaps, so it must not be deleted.

**Seq is per-replica.** A checkpoint taken against one clone is meaningless
against another, and a seq above the other replica's head reads as "caught up"
and stalls forever. The extension sidesteps this entirely by never tracking a
checkpoint: it only asks "did something change" and then re-reads, so it always
tails from `--since 0` and lets the debounce collapse the replayed backlog into
one refresh.
