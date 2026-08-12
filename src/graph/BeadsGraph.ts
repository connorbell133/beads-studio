/**
 * The one place readiness, rank, leverage, cycles, and hierarchy are derived.
 *
 * Pure over its input and free of any vscode import, so it is unit-testable and
 * reusable by every surface. Derived on each read and stored never - the board
 * is not a cache to reconcile.
 *
 * Two rules govern everything here and are stated once so no view re-decides
 * them:
 *
 *   Direction. An edge is `from` depends on `to`, matching
 *   `bd dep add <from> <to>`. Read every edge as "from is blocked by to".
 *
 *   Gating. Only `blocks` edges affect readiness. parent-child, related, and
 *   discovered-from express structure, not sequencing.
 *   See docs/reference/beads-dependency-model.md.
 *
 * Traversals are iterative throughout. A 2000-deep blocker chain is a plausible
 * shape for a real backlog and would overflow a recursive walk.
 */

import { normalizeStatus } from "../backend/types";
import {
  BeadGraphNode,
  BeadsGraphModel,
  COORDINATION_TYPES,
  DeriveGraphOptions,
  GraphInputEdge,
  GraphInputNode,
} from "./types";

const BLOCKS = "blocks";
const PARENT_CHILD = "parent-child";

export function deriveGraph(
  inputNodes: GraphInputNode[],
  inputEdges: GraphInputEdge[],
  options: DeriveGraphOptions = {}
): BeadsGraphModel {
  const coordinationTypes = new Set(options.coordinationTypes ?? COORDINATION_TYPES);
  const byId = new Map(inputNodes.map((n) => [n.id, n]));
  const ids = inputNodes.map((n) => n.id);

  // A bead outside the node set is treated as open: over-reporting blocked is
  // recoverable, over-reporting ready is not.
  const isClosed = (id: string): boolean => {
    const raw = byId.get(id);
    return raw ? normalizeStatus(raw.status) === "closed" : false;
  };

  // Only edges whose dependent end is a bead we actually have. An edge from an
  // unknown source has nothing to hang derived facts on.
  const blockEdges = inputEdges.filter((e) => e.type === BLOCKS && byId.has(e.from));

  // blockedBy: the open blockers of each bead. blocksFor: the reverse, used for
  // leverage and for the topological walk.
  const blockedBy = new Map<string, string[]>(ids.map((id) => [id, []]));
  const blocksFor = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of blockEdges) {
    if (isClosed(edge.to)) continue;
    blockedBy.get(edge.from)?.push(edge.to);
    // The blocker may be outside the node set; only track reverse edges we can
    // attribute to a real bead.
    if (byId.has(edge.to)) blocksFor.get(edge.to)?.push(edge.from);
  }

  const cycles = findCycles(ids, blockedBy);
  const inCycle = new Set(cycles.flat());
  const rank = computeRanks(ids, blockedBy, blocksFor, byId, inCycle);
  const leverage = computeLeverage(ids, blocksFor, isClosed);
  const { parentOf, childrenOf } = resolveHierarchy(inputNodes, inputEdges, byId);

  const nodes: Record<string, BeadGraphNode> = {};
  const ready: string[] = [];
  const blocked: string[] = [];
  const parentless: string[] = [];

  for (const raw of inputNodes) {
    const id = raw.id;
    const blockers = (blockedBy.get(id) ?? []).slice().sort(compareIds(rank));
    const children = childrenOf.get(id) ?? [];
    const isWork = !coordinationTypes.has(raw.issue_type ?? "");
    // bd's own `bd ready` excludes in_progress, pinned, and deferred beads even
    // when nothing blocks them, so readiness keys on the exact open status
    // rather than on "not closed".
    const isOpen = normalizeStatus(raw.status) === "open";
    const isReady = isOpen && blockers.length === 0 && isWork;

    const node: BeadGraphNode = {
      id,
      blockedBy: blockers,
      ready: isReady,
      rank: rank.get(id) ?? 0,
      leverage: leverage.get(id) ?? 0,
      blockerChain: longestBlockerChain(id, blockedBy, rank),
      children,
      inCycle: inCycle.has(id),
    };

    const parent = parentOf.get(id);
    if (parent) node.parent = parent;
    if (children.length > 0) {
      node.childCounts = {
        closed: children.filter(isClosed).length,
        total: children.length,
      };
      node.criticalPath = Math.max(...children.map((c) => rank.get(c) ?? 0)) + 1;
    } else if (raw.issue_type === "epic") {
      // An epic with no members still has its own depth.
      node.criticalPath = 1;
    }

    nodes[id] = node;
    if (isWork && isOpen) (isReady ? ready : blocked).push(id);
    if (!parent) parentless.push(id);
  }

  return {
    nodes,
    ready,
    blocked,
    parentless,
    cycles,
    hasCycle: cycles.length > 0,
    complete: options.complete ?? false,
  };
}

/** Order blockers deepest-first so a chain reads outward from the bead. */
function compareIds(rank: Map<string, number>) {
  return (a: string, b: string): number =>
    (rank.get(b) ?? 0) - (rank.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Dependency cycles as strongly connected components of the open-blocker graph.
 *
 * Tarjan's algorithm, driven by an explicit stack. Component-level detection is
 * what lets two disjoint cycles report as two findings rather than one tangled
 * region - the difference between a diagnostic a user can act on and a blob.
 */
function findCycles(ids: string[], blockedBy: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index.has(root)) continue;

    // Each frame tracks how far through its successor list it has walked.
    const frames: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const successors = blockedBy.get(frame.id) ?? [];

      if (frame.next < successors.length) {
        const next = successors[frame.next++];
        if (!index.has(next)) {
          // Only descend into beads we have; an unknown blocker is a leaf.
          if (!blockedBy.has(next)) continue;
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          frames.push({ id: next, next: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
      }

      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
          if (member === frame.id) break;
        }
        // A single node is only a cycle if it depends on itself.
        const selfLoop =
          component.length === 1 && (blockedBy.get(component[0]) ?? []).includes(component[0]);
        if (component.length > 1 || selfLoop) cycles.push(component);
      }
    }
  }

  return cycles;
}

/**
 * Longest-path rank over open blockers: a blocker always precedes what it
 * blocks, so rank 0 means nothing is in the way.
 *
 * Kahn's algorithm settles the acyclic region. Nodes tangled in a cycle never
 * reach in-degree zero, so they are ranked afterwards by a stable
 * priority-then-created-then-id ordering. A cycle is bad data to report, not a
 * reason to throw or to leave ranks undefined.
 */
function computeRanks(
  ids: string[],
  blockedBy: Map<string, string[]>,
  blocksFor: Map<string, string[]>,
  byId: Map<string, GraphInputNode>,
  inCycle: Set<string>
): Map<string, number> {
  const indegree = new Map<string, number>();
  for (const id of ids) {
    // Blockers outside the node set can never be settled, so they would stall
    // the walk. They are already reflected in blockedBy and readiness.
    indegree.set(id, (blockedBy.get(id) ?? []).filter((b) => byId.has(b)).length);
  }

  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue: string[] = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  let head = 0;

  while (head < queue.length) {
    const blocker = queue[head++];
    for (const dependent of blocksFor.get(blocker) ?? []) {
      rank.set(dependent, Math.max(rank.get(dependent) ?? 0, (rank.get(blocker) ?? 0) + 1));
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (inCycle.size > 0) {
    const tangled = ids.filter((id) => inCycle.has(id));
    tangled
      .map((id) => byId.get(id))
      .filter((n): n is GraphInputNode => Boolean(n))
      .sort(byPriorityThenCreated)
      .forEach((n, i) => rank.set(n.id, i));
  }

  return rank;
}

function byPriorityThenCreated(a: GraphInputNode, b: GraphInputNode): number {
  const pa = a.priority ?? 4;
  const pb = b.priority ?? 4;
  if (pa !== pb) return pa - pb;
  const ca = a.created_at ?? "";
  const cb = b.created_at ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * How many beads each bead's closure would unblock, counted transitively and
 * deduplicated across shared descendants.
 *
 * Closed dependents are traversed but not counted. An edge from an
 * already-closed bead is still a real edge - it can lead on to open work
 * further down the chain - but closing its blocker unblocks nothing for the
 * closed bead itself, so counting it would inflate the number the ready lane
 * sorts on.
 *
 * A breadth-first walk per bead. That is O(nodes x edges) in the worst case,
 * which stays comfortable at backlog scale and avoids holding a reachable set
 * per node in memory.
 */
function computeLeverage(
  ids: string[],
  blocksFor: Map<string, string[]>,
  isClosed: (id: string) => boolean
): Map<string, number> {
  const leverage = new Map<string, number>();

  for (const start of ids) {
    const seen = new Set<string>();
    const queue = [...(blocksFor.get(start) ?? [])];
    let head = 0;
    let unblocked = 0;
    while (head < queue.length) {
      const id = queue[head++];
      if (id === start || seen.has(id)) continue;
      seen.add(id);
      if (!isClosed(id)) unblocked++;
      for (const next of blocksFor.get(id) ?? []) {
        if (!seen.has(next)) queue.push(next);
      }
    }
    leverage.set(start, unblocked);
  }

  return leverage;
}

/**
 * The deepest open blocker path out of a bead, nearest blocker first.
 *
 * Follows the highest-ranked blocker at each hop, which is the path that sets
 * the bead's own rank. The visited guard keeps a cycle from looping forever -
 * the chain simply stops when it revisits a bead.
 */
function longestBlockerChain(
  id: string,
  blockedBy: Map<string, string[]>,
  rank: Map<string, number>
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>([id]);
  let current = id;

  for (;;) {
    const blockers = (blockedBy.get(current) ?? []).filter((b) => !visited.has(b));
    if (blockers.length === 0) return chain;
    const deepest = blockers.reduce((best, candidate) =>
      (rank.get(candidate) ?? 0) > (rank.get(best) ?? 0) ? candidate : best
    );
    chain.push(deepest);
    visited.add(deepest);
    current = deepest;
  }
}

/**
 * Parent/child structure, preferring the `parent` scalar `bd list` emits and
 * falling back to the parent-child edge.
 *
 * A parent naming a bead outside the node set is dropped rather than recorded,
 * so the child surfaces as an orphan instead of nesting under nothing.
 */
function resolveHierarchy(
  inputNodes: GraphInputNode[],
  inputEdges: GraphInputEdge[],
  byId: Map<string, GraphInputNode>
): { parentOf: Map<string, string>; childrenOf: Map<string, string[]> } {
  const parentOf = new Map<string, string>();

  for (const node of inputNodes) {
    const declared = node.parent ?? node.parent_id;
    if (declared && declared !== node.id && byId.has(declared)) {
      parentOf.set(node.id, declared);
    }
  }

  for (const edge of inputEdges) {
    if (edge.type !== PARENT_CHILD) continue;
    if (parentOf.has(edge.from)) continue;
    if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to)) continue;
    parentOf.set(edge.from, edge.to);
  }

  const childrenOf = new Map<string, string[]>();
  for (const node of inputNodes) {
    const parent = parentOf.get(node.id);
    if (!parent) continue;
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(node.id);
    childrenOf.set(parent, siblings);
  }

  return { parentOf, childrenOf };
}
