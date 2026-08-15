/**
 * Plan drift: what changed in the plan between a prior commit and now.
 *
 * The backing store is Dolt, so every write to a bead is a commit and the
 * roadmap as it stood on Monday is still there to be read. This module is the
 * pure half of exposing that: `bd diff <from> <to> --json` in, an annotation per
 * bead out. Nothing here spawns a process or touches a webview.
 *
 * WHAT bd CAN AND CANNOT TELL US (bd 1.2.1, verified against the CLI)
 *
 * `bd diff --json` emits one row per affected bead:
 *
 *   { IssueID, DiffType: "added" | "modified" | "removed", OldValue, NewValue }
 *
 * and each value carries only `id`, `title`, `description`, `status`,
 * `priority`. It does NOT carry dependencies, labels, assignee, or type, and
 * its `created_at` / `updated_at` come back as the zero time - so those five
 * fields are the whole vocabulary a drift annotation can speak.
 *
 * That has one consequence worth stating plainly, because it shapes the
 * `touched` kind below: a dependency rewire is NOT reported as a dependency
 * rewire. bd emits a `modified` row for the bead whose blockers moved, but
 * every field it prints is identical on both sides. `bd show --as-of <commit>`
 * does not fill the gap either - it omits dependencies too. So the graph cannot
 * honestly draw "this arrow is new". It can say "this bead changed in a way the
 * diff does not name", which is what `touched` means, and it says exactly that
 * rather than guessing at an edge bd never described.
 *
 * REFS. `bd diff` accepts a Dolt commit hash, a branch name, or HEAD. It
 * rejects relative refs (`HEAD~5`) and dates outright. Resolving "since
 * yesterday" into a hash is therefore this module's job too - see
 * `resolveDriftRef`.
 */

/** One value side of a diff row, as `bd diff --json` prints it. */
export interface DiffIssueValue {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
}

/** One row of `bd diff --json`, before interpretation. */
export interface RawDiffEntry {
  IssueID?: string;
  DiffType?: string;
  OldValue?: DiffIssueValue | null;
  NewValue?: DiffIssueValue | null;
}

/**
 * What happened to one bead since the comparison point.
 *
 * Ordered by how much a planner cares, because a bead can qualify for several
 * at once - a bead that was both closed and reprioritized reads as closed - and
 * `classifyDrift` resolves that by taking the first match down this list.
 *
 *   added         Did not exist at the prior ref. The swarm filed it.
 *   removed       Existed then, gone now. Never drawn on the canvas: it has no
 *                 node to annotate, and inventing one would put a bead on the
 *                 graph that the graph does not contain.
 *   closed        Open then, closed now. The plan advanced.
 *   reopened      Closed then, open now. The plan went backwards.
 *   rescoped      Title or description rewritten. The same bead now means
 *                 something else, which is the drift nobody notices by eye.
 *   reprioritized Priority moved. Direction is carried in `detail`.
 *   touched       Changed in some way `bd diff` reports no field for - most
 *                 often a dependency rewire. See the note above.
 */
export const DRIFT_KINDS = [
  "added",
  "removed",
  "closed",
  "reopened",
  "rescoped",
  "reprioritized",
  "touched",
] as const;

export type DriftKind = (typeof DRIFT_KINDS)[number];

/** The word drawn on a node wearing this drift. Kept short: it shares a line with the title. */
export const DRIFT_LABELS: Record<DriftKind, string> = {
  added: "new",
  removed: "deleted",
  closed: "closed",
  reopened: "reopened",
  rescoped: "rescoped",
  reprioritized: "repriced",
  touched: "touched",
};

/** One plain sentence per kind, for the legend and for tooltips. */
export const DRIFT_DESCRIPTIONS: Record<DriftKind, string> = {
  added: "Filed since the comparison point.",
  removed: "Existed then and has since been deleted.",
  closed: "Was open then, closed now.",
  reopened: "Was closed then, open again now.",
  rescoped: "Title or description rewritten - the same bead now means something else.",
  reprioritized: "Priority moved.",
  touched:
    "Changed in a way bd's diff does not name - most often a dependency rewire. bd reports no historical dependencies, so the graph does not guess which link moved.",
};

export interface BeadDrift {
  id: string;
  kind: DriftKind;
  /** Human-readable specifics, when the kind alone under-describes it. */
  detail?: string;
}

/**
 * The whole comparison, as it crosses to the webview.
 *
 * Plain JSON - a `Record`, not a `Map` - because a Map arrives in a webview as
 * an empty object.
 */
export interface DriftReport {
  /** The resolved ref the comparison ran from. A real commit hash or branch, never a date. */
  fromRef: string;
  /** When that ref was committed, ISO, when it came from a commit listing. */
  fromAt?: string;
  /** How the user asked for it: "Since yesterday", a commit's own label. */
  fromLabel: string;
  /** Every bead that still exists and drifted, keyed by id. */
  kinds: Record<string, DriftKind>;
  /** Every drifted bead including the deleted ones, id-ordered. */
  beads: BeadDrift[];
  /** How many beads carry each kind. Kinds with none are absent. */
  counts: Partial<Record<DriftKind, number>>;
  /** Beads that existed at the ref and no longer do. Reported as text, never drawn. */
  removed: BeadDrift[];
}

/** A commit the drift picker can compare against. */
export interface DriftCommit {
  hash: string;
  /** ISO timestamp of the commit. */
  at: string;
}

/**
 * `bd diff --json` output, defensively.
 *
 * bd prints `{ "error": ... }` instead of an array when the ref is bad, and a
 * bare array otherwise. Both arrive here as already-parsed JSON.
 */
export function parseDiffEntries(raw: unknown): RawDiffEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter(
      (entry): entry is RawDiffEntry => typeof entry === "object" && entry !== null
    );
  }
  if (raw && typeof raw === "object") {
    const error = (raw as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) {
      throw new Error(error);
    }
  }
  return [];
}

/** Whitespace-insensitive so a reflowed description does not read as a rescope. */
function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * One diff row, interpreted.
 *
 * Returns null for a row bd emitted with no usable id, rather than inventing a
 * node key that matches nothing in the graph.
 */
export function classifyDrift(entry: RawDiffEntry): BeadDrift | null {
  const id = entry.IssueID ?? entry.NewValue?.id ?? entry.OldValue?.id;
  if (!id) return null;

  if (entry.DiffType === "added") return { id, kind: "added" };
  if (entry.DiffType === "removed") return { id, kind: "removed" };

  const before = entry.OldValue ?? {};
  const after = entry.NewValue ?? {};

  // A bd row with one side missing but no add/remove marker is still a real
  // change; treat it as the add or remove it looks like rather than dropping it.
  if (!entry.OldValue && entry.NewValue) return { id, kind: "added" };
  if (entry.OldValue && !entry.NewValue) return { id, kind: "removed" };

  const wasClosed = before.status === "closed";
  const isClosed = after.status === "closed";
  if (!wasClosed && isClosed) return { id, kind: "closed" };
  if (wasClosed && !isClosed) {
    return { id, kind: "reopened", detail: `${before.status} → ${after.status}` };
  }
  if (before.status !== after.status && before.status && after.status) {
    return { id, kind: "touched", detail: `${before.status} → ${after.status}` };
  }

  const titleMoved = normalizeText(before.title) !== normalizeText(after.title);
  const bodyMoved = normalizeText(before.description) !== normalizeText(after.description);
  if (titleMoved || bodyMoved) {
    return {
      id,
      kind: "rescoped",
      detail: titleMoved ? `was “${before.title ?? ""}”` : "description rewritten",
    };
  }

  if (
    typeof before.priority === "number" &&
    typeof after.priority === "number" &&
    before.priority !== after.priority
  ) {
    // Lower is more urgent in bd (P0 is critical), so a decrease is a promotion.
    const direction = after.priority < before.priority ? "raised" : "lowered";
    return { id, kind: "reprioritized", detail: `P${before.priority} → P${after.priority} (${direction})` };
  }

  return { id, kind: "touched" };
}

export interface BuildDriftOptions {
  fromRef: string;
  fromLabel: string;
  fromAt?: string;
}

/**
 * A whole `bd diff` reading, folded into the report the graph annotates from.
 *
 * Deterministic: rows are id-ordered, and a repeated id keeps its first
 * classification, so the same diff always produces the same report.
 */
export function buildDriftReport(
  entries: RawDiffEntry[],
  options: BuildDriftOptions
): DriftReport {
  const seen = new Map<string, BeadDrift>();
  for (const entry of entries) {
    const drift = classifyDrift(entry);
    if (!drift || seen.has(drift.id)) continue;
    seen.set(drift.id, drift);
  }

  const beads = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kinds: Record<string, DriftKind> = {};
  const counts: Partial<Record<DriftKind, number>> = {};
  const removed: BeadDrift[] = [];

  for (const drift of beads) {
    counts[drift.kind] = (counts[drift.kind] ?? 0) + 1;
    if (drift.kind === "removed") {
      removed.push(drift);
      continue;
    }
    // Only beads the current graph still holds get an annotation; a deleted
    // bead has no node to hang one on.
    kinds[drift.id] = drift.kind;
  }

  return {
    fromRef: options.fromRef,
    fromLabel: options.fromLabel,
    ...(options.fromAt ? { fromAt: options.fromAt } : {}),
    kinds,
    beads,
    counts,
    removed,
  };
}

/** A one-line reading of a report, for the toolbar and the empty state. */
export function summarizeDrift(report: DriftReport): string {
  const parts = DRIFT_KINDS.filter((kind) => (report.counts[kind] ?? 0) > 0).map(
    (kind) => `${report.counts[kind]} ${DRIFT_LABELS[kind]}`
  );
  return parts.length === 0 ? "No changes since then" : parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Choosing a comparison point
// ---------------------------------------------------------------------------

/**
 * The offered comparison points, in the words a planner would use.
 *
 * "What did the swarm do overnight" and "does Monday's roadmap still exist" are
 * the two real questions, so the presets are a day and a week rather than an
 * arbitrary ladder. `hours` is turned into a cutoff and then into a real commit
 * by `resolveDriftRef`; nothing downstream ever sees a date, because `bd diff`
 * rejects them.
 */
export interface DriftPreset {
  id: string;
  label: string;
  hours: number;
}

export const DRIFT_PRESETS: readonly DriftPreset[] = [
  { id: "day", label: "Since yesterday", hours: 24 },
  { id: "three-days", label: "Last 3 days", hours: 72 },
  { id: "week", label: "Last week", hours: 24 * 7 },
  { id: "month", label: "Last 30 days", hours: 24 * 30 },
] as const;

export interface ResolvedDriftRef {
  hash: string;
  at: string;
  /**
   * The cutoff was earlier than every commit on offer, so this is the oldest
   * one known rather than the one that was head at the cutoff. Surfaced so the
   * picker can say "as far back as history goes" instead of quietly comparing
   * against the wrong moment.
   */
  clamped: boolean;
}

/**
 * The commit to diff from, for a cutoff time.
 *
 * The newest commit at or before the cutoff. When the commit listing is a
 * sample rather than the full log - which it is on the CLI path, because bd
 * exposes no project-wide commit log - the chosen commit can be a little older
 * than the true head at the cutoff. That direction is the safe one: the
 * comparison then covers slightly MORE than was asked for, never less, and the
 * resolved commit's own timestamp is reported alongside so the window being
 * drawn is the one the user can see rather than the one they typed.
 *
 * Returns null when nothing is old enough and there is no commit at all.
 */
export function resolveDriftRef(
  commits: readonly DriftCommit[],
  cutoffMs: number
): ResolvedDriftRef | null {
  const dated = commits
    .map((commit) => ({ ...commit, ms: Date.parse(commit.at) }))
    .filter((commit) => Number.isFinite(commit.ms))
    .sort((a, b) => b.ms - a.ms);

  if (dated.length === 0) return null;

  const atOrBefore = dated.find((commit) => commit.ms <= cutoffMs);
  if (atOrBefore) {
    return { hash: atOrBefore.hash, at: atOrBefore.at, clamped: false };
  }

  const oldest = dated[dated.length - 1];
  return { hash: oldest.hash, at: oldest.at, clamped: true };
}

/** Merges per-bead commit listings into one deduplicated, newest-first history. */
export function mergeCommits(listings: readonly (readonly DriftCommit[])[]): DriftCommit[] {
  const byHash = new Map<string, DriftCommit>();
  for (const listing of listings) {
    for (const commit of listing) {
      if (!commit.hash || byHash.has(commit.hash)) continue;
      byHash.set(commit.hash, commit);
    }
  }
  return [...byHash.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
