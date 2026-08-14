/**
 * The dashboard summary, derived from the graph rather than from status labels.
 *
 * Lives here rather than inside a view provider because computing it inline in
 * DashboardViewProvider is exactly how `readyCount: byStatus.open` shipped: a
 * derived number with no test and no second reader to disagree with it.
 */

import { BeadsGraphModel } from "./types";

export interface GraphSummaryInput {
  id: string;
  status: string;
  priority?: number;
}

export interface GraphSummary {
  total: number;
  /**
   * Raw status tallies, keyed by string because bd allows custom statuses.
   * Read with `byStatus[s] ?? 0` - this is not a total map.
   */
  byStatus: Record<string, number>;
  byPriority: Record<number, number>;
  /** Open, unblocked, and real work - not a count of the `open` label. */
  readyCount: number;
  /** Open work with at least one open blocker. */
  blockedCount: number;
  inProgressCount: number;
  /**
   * True when the node set was partial, so blockedCount may over-report.
   * Surfaced rather than hidden: a number that might be wrong should say so.
   */
  degraded: boolean;
}

export function deriveSummary(
  beads: GraphSummaryInput[],
  model: BeadsGraphModel,
  builtInStatuses: readonly string[] = []
): GraphSummary {
  // Seed the built-ins so they report 0 rather than undefined; custom statuses
  // are added as they are encountered.
  const byStatus: Record<string, number> = Object.fromEntries(
    builtInStatuses.map((status) => [status, 0])
  );
  const byPriority: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };

  for (const bead of beads) {
    byStatus[bead.status] = (byStatus[bead.status] ?? 0) + 1;
    if (bead.priority !== undefined && bead.priority in byPriority) {
      byPriority[bead.priority]++;
    }
  }

  return {
    total: beads.length,
    byStatus,
    byPriority,
    readyCount: model.ready.length,
    blockedCount: model.blocked.length,
    inProgressCount: byStatus.in_progress ?? 0,
    degraded: !model.complete,
  };
}

/** Blocking links, split by whether they are still in the way. */
export interface BlockingLinkCounts {
  /** The blocker is still open. */
  live: number;
  /** The blocker has closed, so the link is drawn but gates nothing. */
  satisfied: number;
}

/**
 * How many blocking links the graph holds, counted the way the canvas draws
 * them.
 *
 * Separate from `blockedBy.length` summed across nodes, which is the live count
 * alone. Once satisfied links became visible, that sum stopped matching the
 * arrows on screen - the header claimed three links over a picture with nine.
 * A pair recorded twice counts once, matching the lens's own de-duplication.
 */
export function countBlockingLinks(model: BeadsGraphModel): BlockingLinkCounts {
  let live = 0;
  let satisfied = 0;

  for (const node of Object.values(model.nodes)) {
    const open = new Set(node.blockedBy);
    for (const blocker of new Set(node.dependsOn)) {
      if (open.has(blocker)) live++;
      else satisfied++;
    }
  }

  return { live, satisfied };
}
