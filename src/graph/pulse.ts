/**
 * The dashboard's pulse: what happened while the operator wasn't looking.
 *
 * An agent swarm mutates the project while its operator is in another
 * terminal. The state they return to is less interesting than the movement
 * they missed - closed, filed, newly unblocked - and a claim that has stopped
 * moving usually means a wedged agent. All of that derives from timestamps
 * the beads already carry, plus one fact only the extension host can know:
 * when an id first appeared in the graph's ready set (`BecameReadyEvent`,
 * recorded by the dashboard provider as it reloads).
 *
 * Lives here rather than in the view for the same reason as readyLane.ts:
 * every threshold and ordering decision is testable, and the view keeps only
 * markup.
 */

export interface PulseBead {
  id: string;
  status: string;
  assignee?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
}

/** When an id first showed up ready, in epoch ms. Recorded by the provider. */
export interface BecameReadyEvent {
  id: string;
  at: number;
}

/** The hour is the operator's unit: shorter flickers, longer goes stale. */
export const PULSE_WINDOW_MS = 60 * 60 * 1000;

/**
 * A claim untouched this long is suspect. Agents update beads as they work;
 * two silent hours is more often a crash than a deep think. A false positive
 * is a mild hint, not an alarm, so the threshold leans early.
 */
export const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

const ACTIVITY_CAP = 5;

export interface StaleClaim<B> {
  bead: B;
  heldMs: number;
}

export interface Pulse<B> {
  /** Closed inside the window, newest first. */
  closed: B[];
  /** Created inside the window, newest first. */
  filed: B[];
  /** Became ready inside the window and still open, newest event first. */
  newlyReady: B[];
  /** In progress with no movement past the stale threshold, longest-held first. */
  staleClaims: StaleClaim<B>[];
  /** Most recently touched beads regardless of window, newest first. */
  activity: B[];
  /** True when the window saw no closes, files, or unblocks. */
  quiet: boolean;
}

export interface PulseOptions {
  now?: number;
  windowMs?: number;
  staleMs?: number;
  activityCap?: number;
}

const parse = (iso?: string): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function computePulse<B extends PulseBead>(
  beads: readonly B[],
  becameReady: readonly BecameReadyEvent[],
  options: PulseOptions = {}
): Pulse<B> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? PULSE_WINDOW_MS;
  const staleMs = options.staleMs ?? STALE_CLAIM_MS;
  const activityCap = options.activityCap ?? ACTIVITY_CAP;
  const cutoff = now - windowMs;

  const inWindow = (t: number | null): t is number => t !== null && t >= cutoff && t <= now;

  const closed = beads
    .filter((b) => b.status === "closed" && inWindow(parse(b.closedAt)))
    .sort((a, b) => (parse(b.closedAt) ?? 0) - (parse(a.closedAt) ?? 0));

  const filed = beads
    .filter((b) => inWindow(parse(b.createdAt)))
    .sort((a, b) => (parse(b.createdAt) ?? 0) - (parse(a.createdAt) ?? 0));

  // An event whose bead has since closed belongs to `closed`, and one whose
  // bead got claimed belongs to the doing count - "newly ready" only means
  // "still there for the taking".
  const byId = new Map(beads.map((b) => [b.id, b]));
  const newlyReady = becameReady
    .filter((e) => inWindow(e.at))
    .sort((a, b) => b.at - a.at)
    .map((e) => byId.get(e.id))
    .filter((b): b is B => b !== undefined && b.status === "open");

  const staleClaims = beads
    .flatMap((bead) => {
      if (bead.status !== "in_progress") return [];
      const touched = parse(bead.updatedAt);
      if (touched === null) return [];
      const heldMs = now - touched;
      return heldMs >= staleMs ? [{ bead, heldMs }] : [];
    })
    .sort((a, b) => b.heldMs - a.heldMs);

  const activity = beads
    .filter((b) => parse(b.updatedAt) !== null)
    .sort((a, b) => (parse(b.updatedAt) ?? 0) - (parse(a.updatedAt) ?? 0))
    .slice(0, activityCap);

  return {
    closed,
    filed,
    newlyReady,
    staleClaims,
    activity,
    quiet: closed.length === 0 && filed.length === 0 && newlyReady.length === 0,
  };
}

/** Ids ready now that were not ready at the previous look. */
export function diffReady(
  prev: ReadonlySet<string>,
  next: readonly string[],
  at: number
): BecameReadyEvent[] {
  return next.filter((id) => !prev.has(id)).map((id) => ({ id, at }));
}

/** Drops events too old to ever re-enter the window. */
export function pruneEvents(
  events: readonly BecameReadyEvent[],
  now: number,
  keepMs: number = PULSE_WINDOW_MS
): BecameReadyEvent[] {
  return events.filter((e) => now - e.at <= keepMs);
}
