/**
 * The four lenses on the dependency graph, as one pure filter.
 *
 * A lens narrows the derived model to the node and edge set a view should draw,
 * before layout. All four share one render path, so the canvas has no idea
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
 *   drift         What moved since a prior Dolt commit: the beads that changed,
 *                 plus one hop of blocking context so a change is read against
 *                 the work around it rather than as loose confetti. Answers
 *                 "what did the swarm do overnight". Anchored by a commit
 *                 picked in the toolbar (src/graph/drift.ts).
 *
 * Rules that hold across all four:
 *
 *   Only blocking edges are drawn. parent-child is structure, not sequencing,
 *   and drawing containment alongside blockage is what makes a dependency graph
 *   unreadable. Hierarchy is the epic lens's membership, never an arrow.
 *
 *   Edges come from `dependsOn` - every recorded blocking edge, whether or not
 *   the blocker has closed. A met dependency is drawn recessed (`satisfied`)
 *   rather than dropped, and layout is derived from the same complete set, so
 *   an epic keeps its shape as its members close instead of re-flowing on
 *   every read. What is still in the way is a per-node fact (`blocked`, from
 *   the model's open-blocker view), not the presence or absence of a line.
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

import type { DriftKind } from "./drift";
import { BeadsGraphModel, COORDINATION_TYPES } from "./types";

/** Edge keys join two ids; no bd id contains a tab. */
const EDGE_KEY_SEP = "\t";

export const GRAPH_LENSES = ["epic", "full", "blast-radius", "drift"] as const;

export type GraphLens = (typeof GRAPH_LENSES)[number];

/** The lens the DAG opens on. Never the full graph. */
export const DEFAULT_LENS: GraphLens = "epic";

export const LENS_LABELS: Record<GraphLens, string> = {
  epic: "Epics",
  full: "All beads",
  "blast-radius": "Blast radius",
  drift: "Plan drift",
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
  drift:
    "What moved since a point in the past: beads added, closed, reopened, rescoped or reprioritized, with one hop of context. Pick the comparison point from the dropdown.",
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
   * Depth over every recorded blocker, closed or not. Node order is fixed by
   * this rather than by `rank` so the picture does not re-sort - and dagre does
   * not re-lay-out - each time a bead closes.
   */
  layoutRank: number;
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
  /**
   * How this bead changed since the drift comparison point, when one is set.
   *
   * Stamped on EVERY lens, not only the drift lens: a comparison point is a
   * reading of the same graph, so an epic being worked through can wear its
   * overnight changes without leaving the epic lens. Absent means the bead did
   * not change, or that no comparison point is set at all.
   *
   * Decoration only. It is deliberately not an input to node order, node size,
   * or the edge set, because all three feed dagre - see the note on
   * `layoutRank`, and src/graph/__tests__/graph-stability.test.ts.
   */
  drift?: DriftKind;
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
  /**
   * The blocker has closed, so this dependency is met.
   *
   * Drawn recessed rather than deleted. Deleting it was the old behaviour and
   * it cost more than the ink it saved: the arrow disappeared mid-epic, and
   * because layout was derived from the same filtered edge set, every
   * downstream bead moved with it. Always false on `contains`, which describes
   * membership and has nothing to satisfy.
   */
  satisfied: boolean;
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
  /**
   * What changed since the comparison point, keyed by bead id
   * (`DriftReport.kinds`). Anchors the `drift` lens, and annotates the nodes of
   * every other lens. Absent or empty means no comparison is running.
   *
   * A plain record rather than a Map: this arrives from the webview side of a
   * postMessage boundary, where a Map deserializes to an empty object.
   */
  drift?: Record<string, DriftKind>;
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
  /**
   * Every member has closed, so there is nothing left to open this epic up for.
   *
   * Membership decides this, not the epic's own status: a container's status
   * says nothing about its contents, and bd does not close an epic when its
   * last child lands. An epic with no members is never complete - 0 of 0 is not
   * an achievement, and hiding it would make it unreachable.
   */
  complete: boolean;
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
      const closed = members.filter(
        (member) => context.beads.get(member)?.status === "closed"
      ).length;
      return {
        id,
        label: bead.title && bead.title.length > 0 ? bead.title : id,
        total: members.length,
        closed,
        complete: members.length > 0 && closed === members.length,
      };
    });
}

/**
 * The epics the picker offers, given the toggle and what the lens is anchored on.
 *
 * Finished epics are hidden by default - a project accumulates them forever and
 * they are never the thing being worked on. The anchor is re-admitted
 * unconditionally, because the alternative is that the epic you are watching
 * drops out of the list at the moment its last bead closes, and the lens falls
 * through to some unrelated epic exactly when you wanted to see the finish.
 */
export function visibleEpics(
  epics: EpicOption[],
  showCompleted: boolean,
  anchorId: string | null
): EpicOption[] {
  if (showCompleted) return epics;
  return epics.filter((epic) => !epic.complete || epic.id === anchorId);
}

/** How many epics the default filter is holding back. */
export function hiddenEpicCount(epics: EpicOption[], anchorId: string | null): number {
  return epics.length - visibleEpics(epics, false, anchorId).length;
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
  /**
   * blocker -> blocked, between visible beads only.
   *
   * Built from every recorded blocking edge, not just the open ones. A lens
   * describes what the graph *is*; whether a given dependency has been met is
   * carried per-edge by `satisfied` and per-node by `blocked`.
   */
  blocks: Map<string, string[]>;
  /** blocked -> blocker, between visible beads only. Structural, as above. */
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
    case "drift":
      return driftLens(model, context, options, total);
    case "full":
    default:
      return finish(model, context, "full", context.ids, undefined, total, options.drift);
  }
}

/**
 * The beads that moved since the comparison point, in context.
 *
 * The drifted set alone would be a scatter of unrelated cards - "seven things
 * changed" without the one fact that makes it a plan: what those seven were
 * sequenced against. So the node set is the drifted beads plus one blocking hop
 * either side, which is the smallest addition that lets a new bead be read as
 * "filed in front of the thing it now blocks" rather than as a loose square.
 *
 * One hop, not the transitive closure: that is the blast-radius lens's job, and
 * on a busy week the closure of every changed bead is the full graph again.
 *
 * Deleted beads are not here. They have no node in the current model to
 * annotate, and drawing one would put a bead on the canvas that the project
 * does not contain; the report carries them as text instead.
 */
function driftLens(
  model: BeadsGraphModel,
  context: Context,
  options: LensOptions,
  total: number
): LensResult {
  const drift = options.drift ?? {};
  const changed = context.ids.filter((id) => drift[id] !== undefined);
  if (changed.length === 0) {
    return { lens: "drift", nodes: [], edges: [], omitted: total };
  }

  const shown = new Set(changed);
  for (const id of changed) {
    for (const blocker of context.blockedBy.get(id) ?? []) shown.add(blocker);
    for (const blocked of context.blocks.get(id) ?? []) shown.add(blocked);
  }

  return finish(
    model,
    context,
    "drift",
    context.ids.filter((id) => shown.has(id)),
    undefined,
    total,
    drift
  );
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
    for (const blocker of model.nodes[id].dependsOn) {
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
    for (const blocker of model.nodes[id].dependsOn) {
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
  const result = finish(
    model,
    context,
    "epic",
    [epicId, ...members],
    undefined,
    total,
    options.drift
  );

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
  return finish(
    model,
    context,
    "blast-radius",
    ids,
    { distance, focusId },
    total,
    options.drift
  );
}

interface Radius {
  distance: Map<string, number>;
  focusId: string;
}

/**
 * Node and edge assembly, shared by all four lenses.
 *
 * Ordering is fixed here rather than at each call site: nodes shallowest-first
 * then by id, edges by endpoint. Determinism matters because dagre's output
 * depends on insertion order - an unstable sort would move the whole picture
 * between two renders of identical data.
 *
 * `drift` is stamped last and read by nothing else in this function. That is
 * the whole reason a comparison point can be turned on over an epic somebody is
 * watching without the epic moving: it changes no id, no order, no edge, and no
 * size input, so dagre receives byte-identical input either way.
 */
function finish(
  model: BeadsGraphModel,
  context: Context,
  lens: GraphLens,
  ids: string[],
  radius: Radius | undefined,
  total: number,
  drift?: Record<string, DriftKind>
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
      layoutRank: derived.layoutRank,
    };

    if (radius) node.distance = radius.distance.get(id);
    const changed = drift?.[id];
    if (changed) node.drift = changed;

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
      edges.push({
        blocker,
        blocked,
        kind: "blocks",
        satisfied: context.beads.get(blocker)?.status === "closed",
      });
    }
  }
  edges.sort((a, b) => byId(a.blocker, b.blocker) || byId(a.blocked, b.blocked));

  // Containment tethers, where blast-radius is the odd one out: it answers
  // "what does this reach", and a containment link is not part of the answer.
  // The epic lens reverses the tether (member -> container) so layout converges
  // the subtree on the epic; see `epicDetail`.
  // Drift joins the tether-drawing lenses because a changed epic drawn beside
  // its changed member is a container holding work, and the untethered pair
  // would read as two unrelated changes.
  if (lens === "full" || lens === "epic" || lens === "drift") {
    for (const id of context.ids) {
      const parent = model.nodes[id]?.parent;
      if (!parent || !shown.has(parent) || !shown.has(id)) continue;
      edges.push(
        lens === "epic"
          ? { blocker: id, blocked: parent, kind: "contains", satisfied: false }
          : { blocker: parent, blocked: id, kind: "contains", satisfied: false }
      );
    }
    edges.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        byId(a.blocker, b.blocker) ||
        byId(a.blocked, b.blocked)
    );
  }

  // layoutRank, not rank: dagre's output depends on insertion order, so
  // ordering by a depth that shrinks as work closes would move the whole
  // picture between two renders of a graph nobody restructured.
  nodes.sort((a, b) => a.layoutRank - b.layoutRank || byId(a.id, b.id));

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
