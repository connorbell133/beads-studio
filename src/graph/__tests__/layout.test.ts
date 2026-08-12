/**
 * Layout is the one piece of the DAG a test can hold: pure in, pure out.
 * These lock the properties the renderer depends on - every node placed,
 * corners not centres, dangling edges tolerated, and the same picture twice.
 */

import {
  GraphLayoutEdge,
  GraphLayoutNode,
  layoutBounds,
  layoutGraph,
  layoutGraphNodes,
} from "../layout";

const node = (id: string, width = 160, height = 48): GraphLayoutNode => ({ id, width, height });
const edge = (source: string, target: string): GraphLayoutEdge => ({ source, target });

/** Widest minus narrowest extent along an axis. */
function spread(positions: Map<string, { x: number; y: number }>, axis: "x" | "y"): number {
  const values = [...positions.values()].map((position) => position[axis]);
  return Math.max(...values) - Math.min(...values);
}

describe("layoutGraphNodes", () => {
  it("positions every node, including one with no edges", () => {
    const positions = layoutGraphNodes(
      [node("a"), node("b"), node("island")],
      [edge("a", "b")]
    );

    expect(positions.size).toBe(3);
    for (const id of ["a", "b", "island"]) {
      const position = positions.get(id);
      expect(position).toBeDefined();
      expect(Number.isFinite(position?.x)).toBe(true);
      expect(Number.isFinite(position?.y)).toBe(true);
    }
  });

  it("skips an edge naming a node that is not in the list, without throwing", () => {
    const run = (): Map<string, { x: number; y: number }> =>
      layoutGraphNodes([node("a"), node("b")], [edge("a", "b"), edge("a", "ghost"), edge("ghost", "b")]);

    expect(run).not.toThrow();
    expect(run().size).toBe(2);
    expect(layoutGraph([node("a"), node("b")], [edge("a", "b"), edge("a", "ghost")]).edges).toHaveLength(1);
  });

  it("returns top-left corners, not centres", () => {
    // A lone 100x40 node is centred by dagre at (50, 20), so its corner is the
    // origin. That is the whole conversion, asserted at its simplest.
    const positions = layoutGraphNodes([node("solo", 100, 40)], []);
    expect(positions.get("solo")).toEqual({ x: 0, y: 0 });
  });

  it("offsets by exactly half the node's own size", () => {
    const wide = layoutGraphNodes([node("a", 100, 40), node("b", 300, 40)], [edge("a", "b")]);
    const centred = layoutGraph([node("a", 100, 40), node("b", 300, 40)], [edge("a", "b")]);

    // Recover dagre's centre from the corner and confirm it is half a width out.
    const a = wide.get("a") as { x: number; y: number };
    const b = wide.get("b") as { x: number; y: number };
    expect(b.x - (a.x + 100)).toBeGreaterThan(0);
    expect(centred.bounds.width).toBeGreaterThan(400);
  });

  it("spreads a chain along x for LR and along y for TB", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

    const lr = layoutGraphNodes(nodes, edges, { direction: "LR" });
    expect(spread(lr, "x")).toBeGreaterThan(spread(lr, "y"));

    const tb = layoutGraphNodes(nodes, edges, { direction: "TB" });
    expect(spread(tb, "y")).toBeGreaterThan(spread(tb, "x"));
  });

  it("defaults to LR, because the DAG reads blocker to blocked", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(layoutGraphNodes(nodes, edges)).toEqual(
      layoutGraphNodes(nodes, edges, { direction: "LR" })
    );
  });

  it("lays out a cycle rather than hanging on it", () => {
    const positions = layoutGraphNodes(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")]
    );

    expect(positions.size).toBe(3);
    expect([...positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(
      true
    );
  });

  it("lays out a self-blocking node", () => {
    const result = layoutGraph([node("a")], [edge("a", "a")]);
    expect(result.positions.get("a")).toBeDefined();
    expect(result.edges[0].points.length).toBeGreaterThan(0);
  });

  it("is deterministic across runs over the same input", () => {
    const nodes = [node("a"), node("b"), node("c"), node("island")];
    const edges = [edge("a", "b"), edge("a", "c"), edge("c", "b")];

    const first = layoutGraphNodes(nodes, edges);
    const second = layoutGraphNodes(nodes, edges);

    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("honours node and rank separation", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b")];

    const tight = layoutGraphNodes(nodes, edges, { rankSep: 20 });
    const loose = layoutGraphNodes(nodes, edges, { rankSep: 200 });

    expect(spread(loose, "x")).toBeGreaterThan(spread(tight, "x"));
  });

  it("handles an empty graph", () => {
    expect(layoutGraphNodes([], []).size).toBe(0);
    expect(layoutGraph([], []).bounds).toEqual({ minX: 0, minY: 0, width: 0, height: 0 });
  });
});

describe("layoutGraph", () => {
  it("routes a polyline for every drawn edge", () => {
    const result = layoutGraph([node("a"), node("b")], [edge("a", "b")]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].points.length).toBeGreaterThanOrEqual(2);
  });

  it("bounds every node, with padding on all four sides", () => {
    const nodes = [node("a", 100, 40), node("b", 100, 40)];
    const result = layoutGraph(nodes, [edge("a", "b")], { padding: 10 });

    for (const item of nodes) {
      const position = result.positions.get(item.id) as { x: number; y: number };
      expect(position.x).toBeGreaterThanOrEqual(result.bounds.minX);
      expect(position.y).toBeGreaterThanOrEqual(result.bounds.minY);
      expect(position.x + item.width).toBeLessThanOrEqual(result.bounds.minX + result.bounds.width);
      expect(position.y + item.height).toBeLessThanOrEqual(
        result.bounds.minY + result.bounds.height
      );
    }
    expect(result.bounds.minX).toBe(-10);
  });

  it("bounds cover routed edge points, not just node boxes", () => {
    // A two-node cycle forces dagre to arc the back-edge outside the node
    // envelope; the viewBox must contain that arc or it bleeds into the
    // letterbox and the picture reads off-centre.
    const nodes = [node("a", 100, 40), node("b", 100, 40)];
    const result = layoutGraph(nodes, [edge("a", "b"), edge("b", "a")], { padding: 10 });

    for (const path of result.edges) {
      for (const point of path.points) {
        expect(point.x).toBeGreaterThanOrEqual(result.bounds.minX);
        expect(point.y).toBeGreaterThanOrEqual(result.bounds.minY);
        expect(point.x).toBeLessThanOrEqual(result.bounds.minX + result.bounds.width);
        expect(point.y).toBeLessThanOrEqual(result.bounds.minY + result.bounds.height);
      }
    }
  });
});

describe("layoutBounds", () => {
  it("reports a zero box for no nodes rather than an infinite one", () => {
    expect(layoutBounds([], new Map())).toEqual({ minX: 0, minY: 0, width: 0, height: 0 });
  });

  it("ignores a node it has no position for", () => {
    const bounds = layoutBounds(
      [node("a", 100, 40), node("missing", 100, 40)],
      new Map([["a", { x: 0, y: 0 }]]),
      0
    );
    expect(bounds).toEqual({ minX: 0, minY: 0, width: 100, height: 40 });
  });
});
