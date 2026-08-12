/**
 * Finding your way around a laid-out DAG.
 *
 * Two jobs, one module, because they answer the same question at different
 * scales: "where is the bead I mean?" First by name, then by edge.
 *
 *   find      Match nodes by id or title as the user types. Matches are marked
 *             and everything else is DIMMED - never removed. Removing a node
 *             changes the node set, which re-runs dagre, which moves every
 *             remaining node. The spatial memory the user just built is the
 *             whole value of a laid-out graph; a filter that destroys it costs
 *             more than it gives. Twenty nodes in, twenty nodes out, always.
 *
 *   traverse  Move along edges rather than through the DOM. In a dependency
 *             graph the only navigation model that means anything is "what
 *             blocks this" and "what waits on this", so that is what the arrow
 *             keys do. Siblings - the other beads sharing a blocker or a
 *             blocked - form the ring the perpendicular keys cycle.
 *
 * And one derived query both surfaces use: the transitive blocker and blocked
 * chains through a node, which is what hover-to-isolate dims against.
 *
 * Pure and deterministic throughout. Every returned id list is in a stable
 * order - input order for matches, id order for everything derived - because an
 * unstable order would make the keyboard cursor jump between two identical
 * renders.
 */

import { LensEdge } from "./lens";

/** The subset of a lens node that find reads. Satisfied by `LensNode`. */
export interface FindTarget {
  id: string;
  /** Title when there is one, id otherwise. */
  label: string;
  /**
   * Beads this node stands for, on a rolled-up node. A rollup is the only thing
   * drawn for its members, so a member matching has to light the container -
   * otherwise searching for a bead inside an epic reports nothing at all.
   */
  members?: readonly string[];
}

export interface FindResult {
  /** Trimmed and lower-cased. Empty when the find is not active. */
  query: string;
  /** False for an empty or whitespace-only query: nothing marked, nothing dimmed. */
  active: boolean;
  /** Matching ids, in the order the targets were given. */
  matches: string[];
  /** Everything else, in the order the targets were given. Never removed. */
  dimmed: string[];
  /** Targets considered. `matches.length + dimmed.length` when active. */
  total: number;
}

/** How a node should render under the current find. */
export type FindState = "match" | "dim" | "none";

/**
 * Case-insensitive substring match over id and title.
 *
 * Substring rather than prefix: bd ids carry a project prefix, so `vsbeads-4f2`
 * typed as `4f2` has to hit. Case-insensitive because nobody types an id's case
 * from memory.
 */
export function findMatches(targets: readonly FindTarget[], rawQuery: string): FindResult {
  const query = rawQuery.trim().toLowerCase();

  if (query.length === 0) {
    return { query: "", active: false, matches: [], dimmed: [], total: targets.length };
  }

  const matches: string[] = [];
  const dimmed: string[] = [];
  for (const target of targets) {
    (matchesTarget(target, query) ? matches : dimmed).push(target.id);
  }

  return { query, active: true, matches, dimmed, total: targets.length };
}

function matchesTarget(target: FindTarget, query: string): boolean {
  if (target.id.toLowerCase().includes(query)) return true;
  if (target.label.toLowerCase().includes(query)) return true;
  return (target.members ?? []).some((member) => member.toLowerCase().includes(query));
}

/** `match` / `dim` while a query is active, `none` when it is not. */
export function findState(result: FindResult, id: string): FindState {
  if (!result.active) return "none";
  return result.matches.includes(id) ? "match" : "dim";
}

/** The immediate edge neighbourhood of one node. */
export interface Neighbours {
  /** What has to happen first. Id-ordered. */
  blockers: string[];
  /** What is waiting on this. Id-ordered. */
  blocked: string[];
  /**
   * Other nodes reachable by one hop out and one hop back: the beads sharing a
   * blocker or sharing a blocked with this one. Id-ordered, excluding self.
   */
  siblings: string[];
  /** `blockers` then `blocked`. The stable traversal order. */
  all: string[];
}

export function neighboursOf(edges: readonly LensEdge[], id: string): Neighbours {
  const blockers = new Set<string>();
  const blocked = new Set<string>();
  for (const edge of edges) {
    if (edge.blocked === id) blockers.add(edge.blocker);
    if (edge.blocker === id) blocked.add(edge.blocked);
  }

  const siblings = new Set<string>();
  for (const edge of edges) {
    if (edge.blocked !== id && blockers.has(edge.blocker)) siblings.add(edge.blocked);
    if (edge.blocker !== id && blocked.has(edge.blocked)) siblings.add(edge.blocker);
  }
  siblings.delete(id);

  const orderedBlockers = sorted(blockers);
  const orderedBlocked = sorted(blocked);
  return {
    blockers: orderedBlockers,
    blocked: orderedBlocked,
    siblings: sorted(siblings),
    all: [...orderedBlockers, ...orderedBlocked],
  };
}

/**
 * Where an arrow key lands.
 *
 * `blocker`/`blocked` follow an edge; `previous`/`next` cycle the sibling ring
 * so that a fan-out of five blockers is reachable without leaving the node you
 * came from. Composed, that is the whole model: one key to enter a fan, another
 * to walk it.
 */
export type TraverseDirection = "blocker" | "blocked" | "previous" | "next";

/**
 * The id to move the cursor to, or `null` when the move is not available.
 *
 * `null` means the cursor stays exactly where it is. An isolated node has no
 * neighbours in any direction, and silently jumping somewhere else would be
 * worse than not moving.
 */
export function stepFocus(
  edges: readonly LensEdge[],
  from: string,
  direction: TraverseDirection
): string | null {
  const neighbours = neighboursOf(edges, from);

  if (direction === "blocker") return neighbours.blockers[0] ?? null;
  if (direction === "blocked") return neighbours.blocked[0] ?? null;

  // The ring includes the current node so the cycle has a defined starting
  // point, and wraps so a long fan never dead-ends.
  if (neighbours.siblings.length === 0) return null;
  const ring = sorted(new Set([...neighbours.siblings, from]));
  const at = ring.indexOf(from);
  const step = direction === "next" ? 1 : -1;
  return ring[(at + step + ring.length) % ring.length] ?? null;
}

/** The transitive blocker and blocked chains through one node. */
export interface GraphChains {
  id: string;
  /** Everything upstream, transitively. Id-ordered, excluding `id`. */
  blockers: string[];
  /** Everything downstream, transitively. Id-ordered, excluding `id`. */
  blocked: string[];
  /** `id` plus both chains, id-ordered. What stays lit when hover isolates. */
  connected: string[];
}

/**
 * Both chains out of a node, walked breadth-first with a seen set so a cycle
 * terminates rather than hanging. A cycle is data this graph has to draw, not a
 * reason to stop.
 */
export function chainsFrom(edges: readonly LensEdge[], id: string): GraphChains {
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const edge of edges) {
    push(upstream, edge.blocked, edge.blocker);
    push(downstream, edge.blocker, edge.blocked);
  }

  const walk = (adjacency: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>([id]);
    const queue = [id];
    const reached = new Set<string>();
    for (let head = 0; head < queue.length; head++) {
      for (const next of adjacency.get(queue[head]) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        reached.add(next);
        queue.push(next);
      }
    }
    return reached;
  };

  const blockers = walk(upstream);
  const blocked = walk(downstream);
  return {
    id,
    blockers: sorted(blockers),
    blocked: sorted(blocked),
    connected: sorted(new Set([id, ...blockers, ...blocked])),
  };
}

/**
 * A predicate for the edges that stay lit while `chains` is isolated.
 *
 * Both endpoints on the chain is the rule. It keeps a link between two blockers
 * of the same node visible, which is correct - that link is part of the order
 * the upstream work has to happen in.
 *
 * Returned as a closure over one membership set rather than as a per-edge
 * function, because the caller asks it once per edge on every hover frame.
 */
export function chainFilter(chains: GraphChains): (edge: LensEdge) => boolean {
  const connected = new Set(chains.connected);
  return (edge) => connected.has(edge.blocker) && connected.has(edge.blocked);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
