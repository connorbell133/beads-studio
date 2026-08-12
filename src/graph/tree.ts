/**
 * The backlog as a tree, shaped by the derived graph.
 *
 * Hierarchy is read from `BeadsGraphModel` - `nodes[id].parent`, `.children`,
 * `.childCounts` - not re-derived from per-bead dependency arrays. The graph
 * has already reconciled the two things bd emits for the same fact: `bd list`
 * carries a `parent` scalar *and* a `parent-child` edge, and a view that reads
 * only one of them silently loses beads that declare the other.
 *
 * Pure, generic over the bead shape, and free of any React or vscode import,
 * because jest runs this project in a node environment and matches only
 * `.test.ts` - logic that needs a test cannot live in the `.tsx` view.
 *
 * Two shapes come out rather than one:
 *
 *   `roots` - parentless beads that have children, with their descendants
 *   nested underneath. This is the hierarchy.
 *
 *   `orphans` - parentless beads with no children. Standalone work that sits
 *   outside every epic. On a healthy project this lane is small; when it is
 *   large, that is the finding, which is why it is a lane and not a silent
 *   append to the root list.
 *
 * Traversals are iterative and cycles are broken before any walk, so a
 * parent-child loop reports itself instead of expanding forever.
 */

import { BeadsGraphModel } from "./types";

/** Direct-child completion on a bead that has children. */
export interface TreeRollup {
  closed: number;
  total: number;
  /** 0-100, rounded. Drives the fill; never the only carrier of the value. */
  percent: number;
  /** "7/12" - the readable form, so completion is not progress-by-colour. */
  label: string;
}

/**
 * A bead decorated for the tree.
 *
 * An intersection rather than a wrapper so existing table column accessors
 * (`title`, `status`, ...) keep working unchanged on `row.original`.
 */
export type TreeBead<T> = T & {
  /** Present only when the bead has visible children. TanStack reads this. */
  subRows?: TreeBead<T>[];
  /** Depth within its lane; 0 at a lane root. */
  treeDepth: number;
  /** Matched nothing itself - kept so a matched descendant stays in place. */
  treeContext: boolean;
  /** Present only when the bead has children at all. */
  treeRollup?: TreeRollup;
  /**
   * Longest blocker chain among this bead's members, when it has any.
   *
   * The one planning number that does not improve by adding people: an epic
   * nine sequential beads deep takes nine turns however many people work it.
   */
  treeCriticalPath?: number;
  /** The chain that sets treeCriticalPath, nearest blocker first. */
  treeCriticalChain?: string[];
  /** Its parent link was dropped to break a cycle. */
  treeCycle: boolean;
};

export interface BeadTree<T> {
  /** Hierarchy roots, descendants nested. */
  roots: TreeBead<T>[];
  /** Parentless, childless work. */
  orphans: TreeBead<T>[];
  /** Beads whose parent chain loops, ids sorted. Their parent link is dropped. */
  cycleIds: string[];
  /** Every row in the tree, context rows included. */
  rowCount: number;
  /** Rows that matched the filter themselves. */
  matchedCount: number;
}

export interface BuildTreeOptions {
  /**
   * Ids passing the current filter. Omit to keep everything.
   *
   * A matched bead's ancestors are kept as context rather than the match being
   * lifted out of its hierarchy - a child found under the wrong epic is a
   * finding, and flattening it away hides it.
   */
  matched?: Iterable<string>;
}

export function buildTree<T extends { id: string }>(
  beads: readonly T[],
  graph: BeadsGraphModel | null | undefined,
  options: BuildTreeOptions = {}
): BeadTree<T> {
  const matched = options.matched ? new Set(options.matched) : null;
  const isMatch = (id: string): boolean => (matched ? matched.has(id) : true);

  if (!graph) {
    // No graph means no hierarchy is known. Every bead is its own root, rather
    // than every bead reporting as an orphan finding.
    const roots = beads
      .filter((bead) => isMatch(bead.id))
      .map((bead) => ({ ...bead, treeDepth: 0, treeContext: false, treeCycle: false }));
    return {
      roots,
      orphans: [],
      cycleIds: [],
      rowCount: roots.length,
      matchedCount: roots.length,
    };
  }

  // Only beads actually handed to the view can be rows. A parent that the graph
  // knows but this list does not - filtered out upstream, or never in the
  // payload - leaves its child parentless, and parentless is a lane, not a drop.
  const present = new Set(beads.map((bead) => bead.id));
  const parentOf = new Map<string, string>();
  for (const bead of beads) {
    const parent = graph.nodes[bead.id]?.parent;
    if (parent && parent !== bead.id && present.has(parent)) {
      parentOf.set(bead.id, parent);
    }
  }

  const cycleIds = findParentCycles(parentOf);
  // Break the loop before anything walks it. The members stay visible, at the
  // root, flagged - a cycle you can see beats a tree that never terminates.
  for (const id of cycleIds) parentOf.delete(id);
  const cycleSet = new Set(cycleIds);

  const included = collectIncluded(beads, parentOf, isMatch);
  const depthOf = computeDepths(included, parentOf);

  const rows = new Map<string, TreeBead<T>>();
  for (const bead of beads) {
    if (!included.has(bead.id)) continue;
    rows.set(bead.id, {
      ...bead,
      treeDepth: depthOf.get(bead.id) ?? 0,
      treeContext: !isMatch(bead.id),
      treeRollup: rollupFor(graph, bead.id),
      ...criticalPathFor(graph, bead.id),
      treeCycle: cycleSet.has(bead.id),
    });
  }

  const roots: TreeBead<T>[] = [];
  const orphans: TreeBead<T>[] = [];
  let matchedCount = 0;
  for (const bead of beads) {
    const row = rows.get(bead.id);
    if (!row) continue;
    if (!row.treeContext) matchedCount++;

    const parent = parentOf.get(bead.id);
    if (parent) {
      const parentRow = rows.get(parent);
      if (parentRow) {
        (parentRow.subRows ??= []).push(row);
        continue;
      }
    }
    // Having children is what makes a bead a hierarchy root. Whether those
    // children survived the filter is a display question, not a structural one.
    const hasChildren = (graph.nodes[bead.id]?.children.length ?? 0) > 0;
    (hasChildren ? roots : orphans).push(row);
  }

  return { roots, orphans, cycleIds, rowCount: rows.size, matchedCount };
}

/**
 * Beads on a parent-child loop, ids sorted.
 *
 * Each bead has at most one parent, so this is cycle detection on a functional
 * graph: walk the chain marking the path, and a node met while still on the
 * current path opens the loop. Iterative, because the chain length is the
 * backlog's, not the stack's.
 */
function findParentCycles(parentOf: Map<string, string>): string[] {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const cycle = new Set<string>();

  for (const start of parentOf.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !state.has(current)) {
      state.set(current, VISITING);
      path.push(current);
      current = parentOf.get(current);
    }
    if (current !== undefined && state.get(current) === VISITING) {
      // Met a node still on this path: everything from it onward is the loop.
      for (let i = path.indexOf(current); i < path.length; i++) cycle.add(path[i]);
    }
    for (const id of path) state.set(id, DONE);
  }

  return [...cycle].sort();
}

/** Matched beads plus every ancestor needed to keep them in place. */
function collectIncluded<T extends { id: string }>(
  beads: readonly T[],
  parentOf: Map<string, string>,
  isMatch: (id: string) => boolean
): Set<string> {
  const included = new Set<string>();
  for (const bead of beads) {
    if (!isMatch(bead.id)) continue;
    included.add(bead.id);
    // Stops at the first ancestor already present: anything already included
    // brought its own ancestors with it.
    let parent = parentOf.get(bead.id);
    while (parent !== undefined && !included.has(parent)) {
      included.add(parent);
      parent = parentOf.get(parent);
    }
  }
  return included;
}

/** Depth from the lane root, memoized along each chain walked. */
function computeDepths(included: Set<string>, parentOf: Map<string, string>): Map<string, number> {
  const depthOf = new Map<string, number>();
  for (const id of included) {
    if (depthOf.has(id)) continue;
    const path: string[] = [];
    let current: string | undefined = id;
    while (current !== undefined && !depthOf.has(current)) {
      path.push(current);
      current = parentOf.get(current);
    }
    let depth = current === undefined ? -1 : depthOf.get(current) ?? -1;
    for (let i = path.length - 1; i >= 0; i--) {
      depth += 1;
      depthOf.set(path[i], depth);
    }
  }
  return depthOf;
}

/**
 * The epic's critical path and the chain that sets it.
 *
 * Only reported for beads that actually contain members - a depth on a leaf is
 * just its own rank restated. The chain comes from the deepest member's
 * blockerChain, which is the sequence that makes the epic that deep.
 */
function criticalPathFor(
  graph: BeadsGraphModel,
  id: string
): { treeCriticalPath?: number; treeCriticalChain?: string[] } {
  const node = graph.nodes[id];
  const depth = node?.criticalPath;
  if (!node || depth === undefined || node.children.length === 0) {
    return {};
  }

  const deepest = node.children.reduce((best, child) =>
    (graph.nodes[child]?.rank ?? 0) > (graph.nodes[best]?.rank ?? 0) ? child : best
  );
  const chain = graph.nodes[deepest]?.blockerChain ?? [];

  return {
    treeCriticalPath: depth,
    treeCriticalChain: [deepest, ...chain],
  };
}

/** No children means no rollup. An epic reporting `0/0` is noise, not progress. */
function rollupFor(graph: BeadsGraphModel, id: string): TreeRollup | undefined {
  const counts = graph.nodes[id]?.childCounts;
  if (!counts || counts.total === 0) return undefined;
  return {
    closed: counts.closed,
    total: counts.total,
    percent: Math.round((counts.closed / counts.total) * 100),
    label: `${counts.closed}/${counts.total}`,
  };
}

/**
 * A stand-in project key for per-project view state.
 *
 * The webview is never told which project it is showing, but bd ids are
 * `<prefix>-<suffix>` with the prefix fixed per project, so the most common
 * prefix in the list identifies it well enough to keep one project's expanded
 * rows from being restored onto another's.
 */
export function projectKeyFor(beads: readonly { id: string }[]): string {
  const counts = new Map<string, number>();
  for (const bead of beads) {
    const dash = bead.id.lastIndexOf("-");
    if (dash <= 0) continue;
    const prefix = bead.id.slice(0, dash);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  let best = "";
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount || (count === bestCount && prefix < best)) {
      best = prefix;
      bestCount = count;
    }
  }
  return best;
}
