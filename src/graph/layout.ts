/**
 * Pure dagre layout for the dependency DAG.
 *
 * Free of React, of DOM, and of any renderer's node type, so it is trivially
 * testable and the SVG canvas is the only thing that has to know about pixels.
 * The shape is ported from anton's `layoutGraphNodes`
 * (src/components/epic/graph-layout.ts), which was written free of XYFlow types
 * for exactly this reuse.
 *
 * Three rules hold for every function here:
 *
 *   Positions are top-left corners. dagre centres its nodes; every renderer
 *   this feeds places rectangles by their corner, so the conversion happens
 *   once, here.
 *
 *   An edge naming a node that is not in the node list is skipped, not thrown.
 *   The lens filters nodes before layout, so dangling edges are the normal
 *   case rather than a bug to report.
 *
 *   Every input node comes back with a position, including one with no edges
 *   and one tangled in a cycle. A layout that drops nodes is worse than an ugly
 *   one - the user cannot see what is missing.
 */

import dagre from "@dagrejs/dagre";

/** Direction of rank flow. `LR` reads blocker on the left, blocked on the right. */
export type GraphLayoutDirection = "TB" | "LR";

export interface GraphLayoutNode {
  id: string;
  width: number;
  height: number;
}

/** `source` precedes `target` in rank order. For this graph: blocker -> blocked. */
export interface GraphLayoutEdge {
  source: string;
  target: string;
}

export interface GraphLayoutPosition {
  x: number;
  y: number;
}

export interface GraphLayoutOptions {
  /** Defaults to `LR`: the DAG reads blocker on the left, blocked on the right. */
  direction?: GraphLayoutDirection;
  /** Gap between nodes within a rank. */
  nodeSep?: number;
  /** Gap between ranks. */
  rankSep?: number;
  /** Padding added around the laid-out bounds. */
  padding?: number;
}

/** A laid-out edge, with the polyline dagre routed for it. */
export interface GraphLayoutEdgePath extends GraphLayoutEdge {
  points: GraphLayoutPosition[];
}

export interface GraphLayoutBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export interface GraphLayoutResult {
  positions: Map<string, GraphLayoutPosition>;
  /** Only edges whose endpoints both exist; same order as the input. */
  edges: GraphLayoutEdgePath[];
  bounds: GraphLayoutBounds;
}

const DEFAULTS = {
  direction: "LR" as GraphLayoutDirection,
  nodeSep: 24,
  rankSep: 72,
  padding: 24,
};

/**
 * Top-left position for every input node, via dagre's layered layout.
 *
 * Pure: no DOM, no side effects, and deterministic - the same input produces
 * the same map, which is what lets the canvas re-lay-out on every render
 * without the picture moving.
 */
export function layoutGraphNodes(
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  options: GraphLayoutOptions = {}
): Map<string, GraphLayoutPosition> {
  return layoutGraph(nodes, edges, options).positions;
}

/**
 * Positions, routed edge polylines, and the bounding box the canvas needs for
 * its viewBox. One dagre pass; `layoutGraphNodes` is the positions-only view of
 * the same result.
 */
export function layoutGraph(
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  options: GraphLayoutOptions = {}
): GraphLayoutResult {
  const direction = options.direction ?? DEFAULTS.direction;
  const nodeSep = options.nodeSep ?? DEFAULTS.nodeSep;
  const rankSep = options.rankSep ?? DEFAULTS.rankSep;
  const padding = options.padding ?? DEFAULTS.padding;

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, nodesep: nodeSep, ranksep: rankSep });

  for (const node of nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height });
  }

  // A cycle is data to report, not a reason to hang: dagre breaks cycles
  // internally, so a tangled graph still lays out and every node still lands.
  const known = new Set(nodes.map((node) => node.id));
  const drawn: GraphLayoutEdge[] = [];
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    graph.setEdge(edge.source, edge.target);
    drawn.push(edge);
  }

  dagre.layout(graph);

  const positions = new Map<string, GraphLayoutPosition>();
  for (const node of nodes) {
    const laidOut = graph.node(node.id) as { x?: number; y?: number } | undefined;
    positions.set(node.id, {
      x: (laidOut?.x ?? 0) - node.width / 2,
      y: (laidOut?.y ?? 0) - node.height / 2,
    });
  }

  const routed: GraphLayoutEdgePath[] = drawn.map((edge) => {
    const laidOut = graph.edge(edge.source, edge.target) as
      | { points?: GraphLayoutPosition[] }
      | undefined;
    const points = (laidOut?.points ?? []).map((point) => ({ x: point.x, y: point.y }));
    return {
      ...edge,
      // dagre drops the polyline for a self-edge; fall back to the endpoints so
      // the renderer never has to special-case an empty path.
      points: points.length > 0 ? points : endpointsOf(edge, nodes, positions),
    };
  });

  // Bounds cover the edge routes too: dagre arcs a back-edge or a containment
  // tether well outside the node envelope, and a viewBox that ignores those
  // points letterboxes the picture off-centre while the arcs bleed into it.
  return { positions, edges: routed, bounds: boundsOf(nodes, positions, padding, routed) };
}

/**
 * The box every node fits inside, padded. Callers hand this straight to an SVG
 * viewBox, so an empty graph reports a zero-origin box rather than Infinity.
 */
export function layoutBounds(
  nodes: GraphLayoutNode[],
  positions: Map<string, GraphLayoutPosition>,
  padding = DEFAULTS.padding
): GraphLayoutBounds {
  return boundsOf(nodes, positions, padding);
}

function boundsOf(
  nodes: GraphLayoutNode[],
  positions: Map<string, GraphLayoutPosition>,
  padding: number,
  edgePaths: GraphLayoutEdgePath[] = []
): GraphLayoutBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + node.width);
    maxY = Math.max(maxY, position.y + node.height);
  }

  for (const path of edgePaths) {
    for (const point of path.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 0, height: 0 };

  return {
    minX: minX - padding,
    minY: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

/** Centre-to-centre fallback for an edge dagre routed no points for. */
function endpointsOf(
  edge: GraphLayoutEdge,
  nodes: GraphLayoutNode[],
  positions: Map<string, GraphLayoutPosition>
): GraphLayoutPosition[] {
  const centre = (id: string): GraphLayoutPosition => {
    const node = nodes.find((candidate) => candidate.id === id);
    const position = positions.get(id) ?? { x: 0, y: 0 };
    return {
      x: position.x + (node?.width ?? 0) / 2,
      y: position.y + (node?.height ?? 0) / 2,
    };
  };
  return [centre(edge.source), centre(edge.target)];
}
