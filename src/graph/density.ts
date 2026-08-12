/**
 * The point where the DAG stops being a picture.
 *
 * dagre will lay out five hundred nodes without complaining, and the result is
 * a grey mat with lines through it. Fitted into the canvas - `min(60vh, 640px)`
 * tall - a graph that wide draws each 208x52 node at a few pixels, well under
 * the size its own 11px id is legible at. Drawing it anyway is not neutral: it
 * costs a full dagre pass and several hundred SVG subtrees to produce something
 * nobody can read.
 *
 * So above a node count the canvas declines, collapses to the epic rollup, and
 * says so. Two rules make that honest rather than paternalistic:
 *
 *   It always says what it did and why, in the same place the user asked.
 *   A silent collapse would look like a bug in the lens.
 *
 *   The override always wins. A user who wants the hairball gets the hairball;
 *   this is a default, not a lock.
 *
 * The threshold is deliberately a plain node count. Edge density is the better
 * predictor of illegibility in theory, but the count is what the user can see
 * in the toolbar, which makes the notice explainable in one sentence.
 *
 * Pure: no DOM, no layout, no lens evaluation. Feed it a count, get a decision.
 */

import { GraphLens } from "./lens";

/**
 * Nodes the canvas will draw before it collapses.
 *
 * 150 x 208px nodes is roughly a 4,000px-wide layout at LR; fitted into a
 * 640px-tall canvas that already renders each node at about a third of its
 * design size, which is the last point the id line survives. Tunable per call
 * via `limit`.
 */
export const DENSITY_NODE_LIMIT = 150;

/** Where a collapse lands. The rollup is the only lens that is smaller by construction. */
export const DENSITY_COLLAPSE_LENS: GraphLens = "epic-rollup";

export interface DensityOptions {
  /** The lens the user asked for. */
  requested: GraphLens;
  /** How many nodes that lens would draw. */
  nodeCount: number;
  /** The user has seen the notice and asked for it anyway. */
  override?: boolean;
  /** Defaults to `DENSITY_NODE_LIMIT`. */
  limit?: number;
}

export interface DensityDecision {
  /** The lens to actually draw. */
  lens: GraphLens;
  requested: GraphLens;
  nodeCount: number;
  limit: number;
  /** Over the limit, whether or not anything could be done about it. */
  dense: boolean;
  /** True when `lens` differs from `requested` because of the limit. */
  autoCollapsed: boolean;
  /** Why the collapse happened. Present only when `autoCollapsed`. */
  reason?: "node-count";
  /** True when a collapse was available and the override defeated it. */
  overridden: boolean;
}

/**
 * Which lens to draw, given how big the requested one turned out to be.
 *
 * Three outcomes:
 *   under the limit          -> the requested lens, untouched
 *   over, collapse possible  -> the rollup, `autoCollapsed` with a reason
 *   over, already the rollup -> the rollup, `dense` but not collapsed; there is
 *                               nothing smaller to fall back to, and the view
 *                               should point at find or blast radius instead
 */
export function resolveDensity(options: DensityOptions): DensityDecision {
  const limit = options.limit ?? DENSITY_NODE_LIMIT;
  const { requested, nodeCount } = options;
  const override = options.override ?? false;

  const dense = nodeCount > limit;
  const collapsible = dense && requested !== DENSITY_COLLAPSE_LENS;

  if (!collapsible) {
    return {
      lens: requested,
      requested,
      nodeCount,
      limit,
      dense,
      autoCollapsed: false,
      overridden: false,
    };
  }

  if (override) {
    return {
      lens: requested,
      requested,
      nodeCount,
      limit,
      dense,
      autoCollapsed: false,
      overridden: true,
    };
  }

  return {
    lens: DENSITY_COLLAPSE_LENS,
    requested,
    nodeCount,
    limit,
    dense,
    autoCollapsed: true,
    reason: "node-count",
    overridden: false,
  };
}
