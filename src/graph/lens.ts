/**
 * The three lenses on the dependency graph, as one pure filter.
 *
 * A lens narrows the derived model to the node and edge set a view should draw,
 * before layout. All three share one render path, so the canvas has no idea
 * which lens it is drawing - it just gets fewer or more nodes.
 *
 *   epic-rollup   Nodes are top-level beads: an epic stands for its whole
 *                 subtree, and ticket-level edges roll up onto it. Edges that
 *                 stay inside one epic are dropped, because "this epic blocks
 *                 itself" is noise. This is the default lens - a 500-node
 *                 hairball on open is a decision-paralysis surface.
 *   full          Every visible bead, every blocking edge between two of them.
 *   blast-radius  The transitive closure of blockage around one bead, upstream
 *                 and downstream. Answers "what does this touch".
 *
 * Rules that hold across all three:
 *
 *   Only blocking edges are drawn. parent-child is structure, not sequencing,
 *   and drawing containment alongside blockage is what makes a dependency graph
 *   unreadable. Hierarchy is how the rollup groups, never a line on the canvas.
 *
 *   Edges come from `blockedBy`, which the derivation already narrowed to open
 *   blockers. A closed blocker is not in the way, so it is not a line.
 *
 *   Coordination beads (gate, agent, role, message) are filtered out along with
 *   their edges, matching every other surface. They gate readiness in the
 *   model; they are not work to look at. Nothing is bridged across a removed
 *   node - an invented edge would claim a dependency bd never recorded.
 *
 *   A model node with no matching bead is skipped: there is no title, type, or
 *   status to draw, and the adjacency list makes the same choice.
 *
 * Pure and deterministic: same input, same node order, same edge order.
 */

import { BeadsGraphModel, COORDINATION_TYPES } from "./types";

/** Edge keys join two ids; no bd id contains a tab. */
const EDGE_KEY_SEP = "\t";

export const GRAPH_LENSES = ["epic-rollup", "full", "blast-radius"] as const;

export type GraphLens = (typeof GRAPH_LENSES)[number];

/** The lens the DAG opens on. Never the full graph. */
export const DEFAULT_LENS: GraphLens = "epic-rollup";

export const LENS_LABELS: Record<GraphLens, string> = {
  "epic-rollup": "Epics",
  full: "All beads",
  "blast-radius": "Blast radius",
};

/** The subset of a bead a lens reads. Satisfied by `Bead`. */
export interface LensBead {
  id: string;
  title?: string;
  type?: string;
  status: string;
}

export interface LensNode {
  id: string;
  /** Title when there is one, id otherwise. Never empty. */
  label: string;
  type?: string;
  status: string;
  ready: boolean;
  /** At least one open blocker. */
  blocked: boolean;
  inCycle: boolean;
  leverage: number;
  rank: number;
  /** Beads this node stands for, itself first. One entry unless rolled up. */
  members: string[];
  /** True when the node stands for more than itself. */
  rolled: boolean;
  /** Closed-of-total across `members`, on rolled nodes only. */
  progress?: { closed: number; total: number };
  /**
   * Hops from the focus bead, on the blast-radius lens only. Negative upstream
   * (a blocker), positive downstream (something this blocks), 0 for the focus.
   */
  distance?: number;
}

/** A blocking relationship between two lens nodes: `blocker` gates `blocked`. */
export interface LensEdge {
  blocker: string;
  blocked: string;
  /** How many underlying bead-level edges this line stands for. */
  weight: number;
  /** True when `weight > 1` or either end is a rolled node. */
  rolled: boolean;
}

export interface LensResult {
  lens: GraphLens;
  nodes: LensNode[];
  edges: LensEdge[];
  /** The blast-radius anchor, when the lens has a usable one. */
  focusId?: string;
  /** Beads in the model that this lens does not represent at all. */
  omitted: number;
}

export interface LensOptions {
  lens: GraphLens;
  /** Anchor for `blast-radius`. Without one, that lens has nothing to draw. */
  focusId?: string | null;
  /** Types kept off every lens. Defaults to the coordination types. */
  hiddenTypes?: readonly string[];
  /** Hop limit for `blast-radius`. Unlimited by default. */
  depth?: number;
}

interface Context {
  /** Visible beads, keyed by id. */
  beads: Map<string, LensBead>;
  /** Visible ids in model order. */
  ids: string[];
  /** blocker -> blocked, between visible beads only. */
  blocks: Map<string, string[]>;
  /** blocked -> blocker, between visible beads only. */
  blockedBy: Map<string, string[]>;
}

export function applyLens(
  model: BeadsGraphModel,
  beads: LensBead[],
  options: LensOptions
): LensResult {
  const context = buildContext(model, beads, options.hiddenTypes);
  const total = Object.keys(model.nodes).length;

  switch (options.lens) {
    case "full":
      return finish(model, context, "full", context.ids, undefined, total);
    case "blast-radius":
      return blastRadius(model, context, options, total);
    case "epic-rollup":
    default:
      return epicRollup(model, context, total);
  }
}

/**
 * The visible slice of the model, with the blocking edges reduced to the pairs
 * where both ends survive the type filter.
 */
function buildContext(
  model: BeadsGraphModel,
  beads: LensBead[],
  hiddenTypes: readonly string[] = COORDINATION_TYPES
): Context {
  const hidden = new Set(hiddenTypes);
  const byId = new Map(beads.map((bead) => [bead.id, bead]));

  const visible = new Map<string, LensBead>();
  const ids: string[] = [];
  for (const id of Object.keys(model.nodes)) {
    const bead = byId.get(id);
    if (!bead || hidden.has(bead.type ?? "")) continue;
    visible.set(id, bead);
    ids.push(id);
  }

  const blocks = new Map<string, string[]>(ids.map((id) => [id, []]));
  const blockedBy = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const blocker of model.nodes[id].blockedBy) {
      if (!visible.has(blocker)) continue;
      blocks.get(blocker)?.push(id);
      blockedBy.get(id)?.push(blocker);
    }
  }

  return { beads: visible, ids, blocks, blockedBy };
}

/**
 * Each visible bead rolls up to the top of its parent chain, so an epic stands
 * for its members and a parentless bead stands for itself.
 *
 * Rolling to the root rather than to the nearest epic is what keeps the lens a
 * readable dozen nodes when epics nest inside milestones.
 *
 * A parent cycle has no root to reach, so the whole ring elects its lowest id
 * as the container. That is malformed data the view still has to draw, and
 * dropping every bead in the ring would hide the beads that reveal the problem.
 */
function epicRollup(model: BeadsGraphModel, context: Context, total: number): LensResult {
  const containerOf = new Map<string, string>();
  for (const id of context.ids) {
    const chain = [id];
    const seen = new Set<string>([id]);
    let current = id;
    for (;;) {
      const parent = model.nodes[current]?.parent;
      if (!parent || !context.beads.has(parent)) break;
      if (seen.has(parent)) {
        current = chain.reduce((lowest, next) => (byId(next, lowest) < 0 ? next : lowest));
        break;
      }
      seen.add(parent);
      chain.push(parent);
      current = parent;
    }
    containerOf.set(id, current);
  }

  const containers = context.ids.filter((id) => containerOf.get(id) === id);
  const members = new Map<string, string[]>(containers.map((id) => [id, []]));
  for (const id of context.ids) {
    members.get(containerOf.get(id) as string)?.push(id);
  }

  return finish(
    model,
    context,
    "epic-rollup",
    containers,
    { containerOf, members },
    total
  );
}

/**
 * Everything reachable from the focus bead through blocking edges, in both
 * directions: what has to happen first, and what is waiting on it.
 *
 * Breadth-first from the focus so `distance` is the true hop count. Upstream
 * and downstream are walked separately - a bead can be both, and the direction
 * you met it first is the one that explains it.
 */
function blastRadius(
  model: BeadsGraphModel,
  context: Context,
  options: LensOptions,
  total: number
): LensResult {
  const focusId = options.focusId ?? undefined;
  if (!focusId || !context.beads.has(focusId)) {
    return { lens: "blast-radius", nodes: [], edges: [], omitted: total };
  }

  const limit = options.depth ?? Infinity;
  const distance = new Map<string, number>([[focusId, 0]]);

  const walk = (adjacency: Map<string, string[]>, sign: 1 | -1): void => {
    const queue: Array<{ id: string; hops: number }> = [{ id: focusId, hops: 0 }];
    const seen = new Set<string>([focusId]);
    let head = 0;
    while (head < queue.length) {
      const { id, hops } = queue[head++];
      if (hops >= limit) continue;
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (!distance.has(next)) distance.set(next, sign * (hops + 1));
        queue.push({ id: next, hops: hops + 1 });
      }
    }
  };

  walk(context.blockedBy, -1); // upstream: the blockers
  walk(context.blocks, 1); // downstream: what waits on this

  const ids = context.ids.filter((id) => distance.has(id));
  return finish(model, context, "blast-radius", ids, { distance, focusId }, total);
}

interface Rollup {
  containerOf: Map<string, string>;
  members: Map<string, string[]>;
}

interface Radius {
  distance: Map<string, number>;
  focusId: string;
}

/**
 * Node and edge assembly, shared by all three lenses.
 *
 * Ordering is fixed here rather than at each call site: nodes shallowest-first
 * then by id, edges by endpoint. Determinism matters because dagre's output
 * depends on insertion order - an unstable sort would move the whole picture
 * between two renders of identical data.
 */
function finish(
  model: BeadsGraphModel,
  context: Context,
  lens: GraphLens,
  ids: string[],
  extra: Rollup | Radius | undefined,
  total: number
): LensResult {
  const rollup = extra && "members" in extra ? extra : undefined;
  const radius = extra && "distance" in extra ? extra : undefined;
  const shown = new Set(ids);

  const nodes: LensNode[] = ids.map((id) => {
    const bead = context.beads.get(id) as LensBead;
    const derived = model.nodes[id];
    const members = rollup ? (rollup.members.get(id) ?? [id]) : [id];
    const ordered = [id, ...members.filter((member) => member !== id).sort(byId)];

    const node: LensNode = {
      id,
      label: bead.title && bead.title.length > 0 ? bead.title : id,
      type: bead.type,
      status: bead.status,
      ready: derived.ready,
      blocked: derived.blockedBy.length > 0,
      inCycle: derived.inCycle,
      leverage: derived.leverage,
      rank: derived.rank,
      members: ordered,
      rolled: ordered.length > 1,
    };

    if (node.rolled) {
      node.progress = {
        closed: ordered.filter((member) => context.beads.get(member)?.status === "closed").length,
        total: ordered.length,
      };
    }
    if (radius) node.distance = radius.distance.get(id);

    return node;
  });

  // Roll each bead-level edge onto the nodes actually drawn, then collapse the
  // duplicates that produces. An edge inside one rolled node is dropped: a
  // self-loop on an epic says nothing about what to work on next.
  const weights = new Map<string, number>();
  for (const blocked of context.ids) {
    for (const blocker of context.blockedBy.get(blocked) ?? []) {
      const from = rollup ? (rollup.containerOf.get(blocker) ?? blocker) : blocker;
      const to = rollup ? (rollup.containerOf.get(blocked) ?? blocked) : blocked;
      if (from === to) continue;
      if (!shown.has(from) || !shown.has(to)) continue;
      const key = `${from}${EDGE_KEY_SEP}${to}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  }

  const rolledIds = new Set(nodes.filter((node) => node.rolled).map((node) => node.id));
  const edges: LensEdge[] = [...weights.entries()]
    .map(([key, weight]) => {
      const [blocker, blocked] = key.split(EDGE_KEY_SEP);
      return {
        blocker,
        blocked,
        weight,
        rolled: weight > 1 || rolledIds.has(blocker) || rolledIds.has(blocked),
      };
    })
    .sort((a, b) => byId(a.blocker, b.blocker) || byId(a.blocked, b.blocked));

  nodes.sort((a, b) => a.rank - b.rank || byId(a.id, b.id));

  const represented = new Set(nodes.flatMap((node) => node.members));
  const result: LensResult = {
    lens,
    nodes,
    edges,
    omitted: Math.max(0, total - represented.size),
  };
  if (radius) result.focusId = radius.focusId;
  return result;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
