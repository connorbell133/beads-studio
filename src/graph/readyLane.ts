/**
 * The ready lane's ordering, grouping, and chain-flattening logic.
 *
 * Pure and free of React, because jest runs this project in a node environment
 * and matches only `*.test.ts` - a sort that lives inside a component is a sort
 * with no test. The component in `src/webview/views/ReadyLane.tsx` is left with
 * markup and nothing to decide.
 *
 * Nothing here re-derives readiness. `BeadsGraphModel` already settled which
 * beads are ready, which are blocked, and by what; this module only decides the
 * order they read in and how a chain too long to show is shortened.
 */

import { BeadGraphNode, BeadsGraphModel } from "./types";

/**
 * How many blocker hops a chain shows before it elides.
 *
 * Four is the point where a breadcrumb stops being scannable at sidebar width.
 * Past it the first and last hop are what carry meaning - the nearest thing in
 * the way, and the root cause - so those are the two that survive.
 */
export const DEFAULT_CHAIN_CAP = 4;

/** The subset of a bead the lane orders by. Satisfied by the webview `Bead`. */
export interface ReadyLaneBead {
  id: string;
  priority?: number;
}

/** A bead with nothing in its way, paired with the graph facts about it. */
export interface ReadyRow<T extends ReadyLaneBead> {
  bead: T;
  node: BeadGraphNode;
  /** How many beads closing this one would unblock, transitively. */
  unblocks: number;
}

/** A bead that cannot start, with the chain that explains why. */
export interface BlockedRow<T extends ReadyLaneBead> {
  bead: T;
  node: BeadGraphNode;
  chain: BlockerChain;
}

/**
 * A blocker chain, already shortened for display.
 *
 * Split into head and tail rather than handed over as one array with a marker
 * in it, so the renderer cannot accidentally treat the elision as a bead id.
 * `hiddenCount` is 0 and `tail` empty when the whole chain fits.
 */
export interface BlockerChain {
  head: string[];
  hiddenCount: number;
  tail: string[];
  /** The full chain length before truncation. */
  total: number;
}

/** A blocker offered as the next action when nothing is ready. */
export interface BlockerCandidate<T extends ReadyLaneBead> {
  id: string;
  /** Absent when the blocker is outside the payload - see `complete: false`. */
  bead?: T;
  /** Beads whose closure this one would release, transitively. */
  unblocks: number;
}

export interface ReadyLaneModel<T extends ReadyLaneBead> {
  ready: ReadyRow<T>[];
  blocked: BlockedRow<T>[];
  /**
   * The blocker whose closure would release the most work. Present whenever
   * anything is blocked, and the next action when `ready` is empty.
   */
  topBlocker: BlockerCandidate<T> | null;
  /** The node set was partial, so `blocked` may over-report. */
  degraded: boolean;
  /** No beads at all, which is a different empty state from nothing ready. */
  noBeads: boolean;
}

export interface ReadyLaneOptions {
  chainCap?: number;
}

const UNSET_PRIORITY = 4;

const priorityOf = (bead: ReadyLaneBead): number => bead.priority ?? UNSET_PRIORITY;

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ready order: leverage first, then priority, then id.
 *
 * Leverage leads because the lane answers "what should I pick up", and the bead
 * that releases six others outranks a P0 that releases none. Priority breaks
 * the tie, and id makes the order stable across refreshes - a list that
 * reshuffles on every poll is unusable regardless of how well it is sorted.
 */
export function compareReady<T extends ReadyLaneBead>(
  model: BeadsGraphModel
): (a: T, b: T) => number {
  return (a, b) => {
    const la = model.nodes[a.id]?.leverage ?? 0;
    const lb = model.nodes[b.id]?.leverage ?? 0;
    if (la !== lb) return lb - la;
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pa - pb;
    return compareId(a.id, b.id);
  };
}

/**
 * Blocked order: shortest chain first, then leverage, priority, id.
 *
 * A one-hop chain is one closure away from joining the ready group, so it is
 * the most actionable thing in the blocked list. Deep chains sink, which is
 * also where they are least distracting.
 */
export function compareBlocked<T extends ReadyLaneBead>(
  model: BeadsGraphModel,
  chainLength: (id: string) => number
): (a: T, b: T) => number {
  return (a, b) => {
    const ca = chainLength(a.id);
    const cb = chainLength(b.id);
    if (ca !== cb) return ca - cb;
    const la = model.nodes[a.id]?.leverage ?? 0;
    const lb = model.nodes[b.id]?.leverage ?? 0;
    if (la !== lb) return lb - la;
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pa - pb;
    return compareId(a.id, b.id);
  };
}

/**
 * Every open blocker standing between a bead and being ready, nearest first.
 *
 * `BeadGraphNode.blockerChain` walks a single deepest path, which under-reports
 * a bead held up by two independent blockers - the second one is invisible and
 * the user closes the first for no gain. This collects the whole reachable set
 * instead and orders it by descending rank, so the breadcrumb reads outward
 * from the bead and ends on the root cause.
 *
 * Iterative with a visited guard: a dependency cycle stops the walk rather than
 * hanging it.
 */
export function collectBlockers(model: BeadsGraphModel, id: string): string[] {
  const seen = new Set<string>([id]);
  const collected: string[] = [];
  const queue = [...(model.nodes[id]?.blockedBy ?? [])];
  let head = 0;

  while (head < queue.length) {
    const blocker = queue[head++];
    if (seen.has(blocker)) continue;
    seen.add(blocker);
    collected.push(blocker);
    // A blocker outside the node set has no onward edges to follow. It still
    // counts as a blocker - that is the fail-safe the graph model chose.
    for (const next of model.nodes[blocker]?.blockedBy ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }

  return collected.sort(
    (a, b) =>
      (model.nodes[b]?.rank ?? 0) - (model.nodes[a]?.rank ?? 0) || compareId(a, b)
  );
}

/**
 * Shorten a chain to the display cap, keeping the first and last hop.
 *
 * The cap is never silent. Dropping hops without saying how many were dropped
 * turns "blocked on 9 things" into "blocked on 4 things", which is a wrong
 * number rather than a shortened one.
 */
export function truncateChain(chain: string[], cap: number = DEFAULT_CHAIN_CAP): BlockerChain {
  const limit = Math.max(2, Math.floor(cap));
  if (chain.length <= limit) {
    return { head: [...chain], hiddenCount: 0, tail: [], total: chain.length };
  }
  return {
    head: chain.slice(0, limit - 1),
    hiddenCount: chain.length - limit,
    tail: [chain[chain.length - 1]],
    total: chain.length,
  };
}

/**
 * The blocker whose closure would release the most work.
 *
 * Drawn only from blockers that actually gate open work, not from every bead
 * with a non-zero leverage score: a bead blocking something already closed has
 * leverage but no claim on anyone's attention.
 */
export function mostBlocking<T extends ReadyLaneBead>(
  model: BeadsGraphModel,
  byId: Map<string, T>
): BlockerCandidate<T> | null {
  const candidates = new Set<string>();
  for (const id of model.blocked) {
    for (const blocker of collectBlockers(model, id)) candidates.add(blocker);
  }
  if (candidates.size === 0) return null;

  let best: string | null = null;
  for (const id of candidates) {
    if (best === null) {
      best = id;
      continue;
    }
    const lv = model.nodes[id]?.leverage ?? 0;
    const lb = model.nodes[best]?.leverage ?? 0;
    if (lv !== lb) {
      if (lv > lb) best = id;
      continue;
    }
    const pv = priorityOf(byId.get(id) ?? { id });
    const pb = priorityOf(byId.get(best) ?? { id: best });
    if (pv !== pb) {
      if (pv < pb) best = id;
      continue;
    }
    if (compareId(id, best) < 0) best = id;
  }

  const id = best as string;
  const bead = byId.get(id);
  return {
    id,
    ...(bead ? { bead } : {}),
    unblocks: model.nodes[id]?.leverage ?? 0,
  };
}

/**
 * The whole lane in one pass: both groups, ordered, with chains already cut to
 * the cap, plus the next action for the nothing-is-ready case.
 *
 * Driven off `model.ready` and `model.blocked` rather than off bead statuses,
 * so a bead labelled `blocked` with no blockers lands in the ready group and a
 * closed bead lands in neither.
 */
export function buildReadyLane<T extends ReadyLaneBead>(
  model: BeadsGraphModel,
  beads: readonly T[],
  options: ReadyLaneOptions = {}
): ReadyLaneModel<T> {
  const cap = options.chainCap ?? DEFAULT_CHAIN_CAP;
  const byId = new Map(beads.map((bead) => [bead.id, bead]));

  const ready = model.ready
    .map((id) => byId.get(id))
    .filter((bead): bead is T => Boolean(bead))
    .sort(compareReady<T>(model))
    .map((bead) => ({
      bead,
      node: model.nodes[bead.id],
      unblocks: model.nodes[bead.id]?.leverage ?? 0,
    }));

  // Collected once per bead and reused by the comparator, which would otherwise
  // re-walk the blocker graph on every comparison.
  const chains = new Map<string, string[]>();
  for (const id of model.blocked) chains.set(id, collectBlockers(model, id));

  const blocked = model.blocked
    .map((id) => byId.get(id))
    .filter((bead): bead is T => Boolean(bead))
    .sort(compareBlocked<T>(model, (id) => chains.get(id)?.length ?? 0))
    .map((bead) => ({
      bead,
      node: model.nodes[bead.id],
      chain: truncateChain(chains.get(bead.id) ?? [], cap),
    }));

  return {
    ready,
    blocked,
    topBlocker: mostBlocking(model, byId),
    degraded: !model.complete,
    noBeads: beads.length === 0,
  };
}
