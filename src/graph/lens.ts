/**
 * The three lenses on the dependency graph, as one pure filter.
 *
 * A lens narrows the derived model to the node and edge set a view should draw,
 * before layout. All three share one render path, so the canvas has no idea
 * which lens it is drawing - it just gets fewer or more nodes.
 *
 *   epic          One epic, opened up: the epic and every descendant, with each
 *                 member tethered to its container so the picture converges on
 *                 the epic, plus the blocking edges among members. Answers
 *                 "what is inside this epic and in what order". Anchored by an
 *                 epic id chosen in the toolbar, not by the selection. The
 *                 default lens: it is the one that is smaller by construction,
 *                 and a 500-node hairball on open is a decision-paralysis
 *                 surface. Orphan top-level beads belong to the full lens, not
 *                 here.
 *   full          Every visible bead, every blocking edge between two of them.
 *   blast-radius  The transitive closure of blockage around one bead, upstream
 *                 and downstream. Answers "what does this touch".
 *
 * Rules that hold across all three:
 *
 *   Only blocking edges are drawn. parent-child is structure, not sequencing,
 *   and drawing containment alongside blockage is what makes a dependency graph
 *   unreadable. Hierarchy is the epic lens's membership, never an arrow.
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

export const GRAPH_LENSES = ["epic", "full", "blast-radius"] as const;

export type GraphLens = (typeof GRAPH_LENSES)[number];

/** The lens the DAG opens on. Never the full graph. */
export const DEFAULT_LENS: GraphLens = "epic";

export const LENS_LABELS: Record<GraphLens, string> = {
  epic: "Epics",
  full: "All beads",
  "blast-radius": "Blast radius",
};

/**
 * One plain sentence per lens: what its picture shows. Toolbar tooltips and
 * empty states both read from here, so a lens is described in the same words
 * wherever the user meets it.
 */
export const LENS_DESCRIPTIONS: Record<GraphLens, string> = {
  epic: "One epic at a time: everything inside it, and the blocking order among those beads. Pick which epic from the dropdown.",
  full: "Every bead, every blocking link.",
  "blast-radius":
    "The chain through one bead: everything it blocks and everything blocking it, however many links away.",
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
  /**
   * A coordination bead - a gate, agent, role or message - drawn only because
   * it blocks visible work. These are not work, so they read muted, but
   * omitting them left a hole in the chain exactly where the ready lane names
   * a blocker, and the two surfaces disagreed about why something was stuck.
   */
  coordination: boolean;
  /** Closed-of-total across the epic's members, on the epic lens's epic card only. */
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
  /**
   * What the line means.
   *
   * `blocks` is sequencing - the only kind that gates readiness, and the only
   * kind drawn as a directed arrow. `contains` is an epic holding a member: it
   * says nothing about order, and is drawn as a subdued tether so an epic is
   * not left floating unattached to work that belongs to it.
   *
   * Keeping them one list with a kind, rather than two lists, means layout
   * places containment and sequencing in one pass - an epic drawn far from its
   * own members would be worse than not drawing the link at all.
   */
  kind: "blocks" | "contains";
}

export interface LensResult {
  lens: GraphLens;
  nodes: LensNode[];
  edges: LensEdge[];
  /** The lens's anchor, when it has a usable one: the blast-radius focus, or the chosen epic. */
  focusId?: string;
  /** Beads in the model that this lens does not represent at all. */
  omitted: number;
}

/**
 * The lens to open on for a given project.
 *
 * The epic lens when there is any epic to open up - a readable subtree beats a
 * hairball, and it is the view that answers "what order does this work go in".
 * A project with no epics has nothing for that lens to draw, so it falls
 * through to the full graph. Density still governs from there.
 */
export function chooseInitialLens(model: BeadsGraphModel, beads: LensBead[]): GraphLens {
  return listEpics(model, beads).length > 0 ? DEFAULT_LENS : "full";
}

export interface LensOptions {
  lens: GraphLens;
  /** Anchor for `blast-radius`. Without one, that lens has nothing to draw. */
  focusId?: string | null;
  /** Anchor for `epic`. Without one, that lens has nothing to draw. */
  epicId?: string | null;
  /** Types kept off every lens. Defaults to the coordination types. */
  hiddenTypes?: readonly string[];
  /** Hop limit for `blast-radius`. Unlimited by default. */
  depth?: number;
}

/** One entry in the epic picker: an epic and how far along its subtree is. */
export interface EpicOption {
  id: string;
  /** Title when there is one, id otherwise. Never empty. */
  label: string;
  /** Descendants, the epic itself excluded. */
  total: number;
  /** Closed descendants. */
  closed: number;
}

/**
 * The epics a project offers the epic lens, in id order.
 *
 * "Epic" here means a bead that contains work: anything typed `epic`, plus any
 * bead that is some visible bead's parent. Typing is convention, containment is
 * fact, and a picker built on the convention alone would omit a task with
 * subtasks that the tree view happily renders as a container.
 */
export function listEpics(model: BeadsGraphModel, beads: LensBead[]): EpicOption[] {
  const context = buildContext(model, beads, undefined);
  const parents = new Set<string>();
  for (const id of context.ids) {
    const parent = model.nodes[id]?.parent;
    if (parent && context.beads.has(parent)) parents.add(parent);
  }

  return context.ids
    .filter((id) => parents.has(id) || context.beads.get(id)?.type === "epic")
    .sort(byId)
    .map((id) => {
      const bead = context.beads.get(id) as LensBead;
      const members = descendantsOf(model, context, id);
      return {
        id,
        label: bead.title && bead.title.length > 0 ? bead.title : id,
        total: members.length,
        closed: members.filter((member) => context.beads.get(member)?.status === "closed").length,
      };
    });
}

/**
 * Every visible bead whose parent chain reaches `epicId`, in model order.
 * A parent cycle terminates the walk rather than looping it.
 */
function descendantsOf(model: BeadsGraphModel, context: Context, epicId: string): string[] {
  return context.ids.filter((id) => {
    if (id === epicId) return false;
    const seen = new Set<string>([id]);
    let current = model.nodes[id]?.parent;
    while (current && context.beads.has(current) && !seen.has(current)) {
      if (current === epicId) return true;
      seen.add(current);
      current = model.nodes[current]?.parent;
    }
    return false;
  });
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
  /** Ids admitted only because they gate visible work. Drawn muted. */
  coordination: Set<string>;
}

export function applyLens(
  model: BeadsGraphModel,
  beads: LensBead[],
  options: LensOptions
): LensResult {
  const context = buildContext(model, beads, options.hiddenTypes);
  const total = Object.keys(model.nodes).length;

  switch (options.lens) {
    case "epic":
      return epicDetail(model, context, options, total);
    case "blast-radius":
      return blastRadius(model, context, options, total);
    case "full":
    default:
      return finish(model, context, "full", context.ids, undefined, total);
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
  const coordination = new Set<string>();
  const ids: string[] = [];
  for (const id of Object.keys(model.nodes)) {
    const bead = byId.get(id);
    if (!bead || hidden.has(bead.type ?? "")) continue;
    visible.set(id, bead);
    ids.push(id);
  }

  // Re-admit a coordination bead that actually gates something visible. It is
  // not work and never appears as a chain of its own, but dropping it broke the
  // chain precisely where the ready lane names it as the blocker - so the
  // picture and the lane disagreed about why a bead was stuck. Re-admitting the
  // real node keeps them consistent without inventing an edge bd never
  // recorded, which is what bridging across it would have done.
  for (const id of [...ids]) {
    for (const blocker of model.nodes[id].blockedBy) {
      if (visible.has(blocker)) continue;
      const bead = byId.get(blocker);
      if (!bead || !hidden.has(bead.type ?? "")) continue;
      visible.set(blocker, bead);
      coordination.add(blocker);
      ids.push(blocker);
    }
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

  return { beads: visible, ids, blocks, blockedBy, coordination };
}

/**
 * One epic opened up: the epic itself plus every visible descendant, each
 * member drawn as its own node.
 *
 * The containment tethers run member -> container here, the reverse of the
 * full lens, so the left-to-right layout converges the whole subtree on the
 * epic instead of fanning out from it: the epic reads as the destination the
 * work flows into, which is what "0 of 7 closed" on its card is a summary of.
 * Blocking edges among members keep their usual direction, so sequencing and
 * containment point the same way and the picture stays a DAG.
 */
function epicDetail(
  model: BeadsGraphModel,
  context: Context,
  options: LensOptions,
  total: number
): LensResult {
  const epicId = options.epicId ?? undefined;
  if (!epicId || !context.beads.has(epicId)) {
    return { lens: "epic", nodes: [], edges: [], omitted: total };
  }

  const members = descendantsOf(model, context, epicId);
  const result = finish(model, context, "epic", [epicId, ...members], undefined, total);

  // The epic's own card carries the progress line, so the lens answers "how far
  // along" without a separate header.
  const epic = result.nodes.find((node) => node.id === epicId);
  if (epic && members.length > 0) {
    epic.progress = {
      closed: members.filter((member) => context.beads.get(member)?.status === "closed").length,
      total: members.length,
    };
  }
  result.focusId = epicId;
  return result;
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
  radius: Radius | undefined,
  total: number
): LensResult {
  const shown = new Set(ids);

  const nodes: LensNode[] = ids.map((id) => {
    const bead = context.beads.get(id) as LensBead;
    const derived = model.nodes[id];

    const node: LensNode = {
      id,
      label: bead.title && bead.title.length > 0 ? bead.title : id,
      type: bead.type,
      status: bead.status,
      ready: derived.ready,
      blocked: derived.blockedBy.length > 0,
      inCycle: derived.inCycle,
      leverage: derived.leverage,
      coordination: context.coordination.has(id),
      rank: derived.rank,
    };

    if (radius) node.distance = radius.distance.get(id);

    return node;
  });

  // Bead-level edges between two drawn nodes, deduplicated in case the model
  // carries the same blocker twice.
  const seen = new Set<string>();
  const edges: LensEdge[] = [];
  for (const blocked of context.ids) {
    for (const blocker of context.blockedBy.get(blocked) ?? []) {
      if (!shown.has(blocker) || !shown.has(blocked)) continue;
      const key = `${blocker}${EDGE_KEY_SEP}${blocked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ blocker, blocked, kind: "blocks" });
    }
  }
  edges.sort((a, b) => byId(a.blocker, b.blocker) || byId(a.blocked, b.blocked));

  // Containment tethers, where blast-radius is the odd one out: it answers
  // "what does this reach", and a containment link is not part of the answer.
  // The epic lens reverses the tether (member -> container) so layout converges
  // the subtree on the epic; see `epicDetail`.
  if (lens === "full" || lens === "epic") {
    for (const id of context.ids) {
      const parent = model.nodes[id]?.parent;
      if (!parent || !shown.has(parent) || !shown.has(id)) continue;
      edges.push(
        lens === "epic"
          ? { blocker: id, blocked: parent, kind: "contains" }
          : { blocker: parent, blocked: id, kind: "contains" }
      );
    }
    edges.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        byId(a.blocker, b.blocker) ||
        byId(a.blocked, b.blocked)
    );
  }

  nodes.sort((a, b) => a.rank - b.rank || byId(a.id, b.id));

  const result: LensResult = {
    lens,
    nodes,
    edges,
    omitted: Math.max(0, total - nodes.length),
  };
  if (radius) result.focusId = radius.focusId;
  return result;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
