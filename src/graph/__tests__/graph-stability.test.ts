/**
 * The regression this whole change exists to prevent: an epic re-flowing on the
 * canvas while an agent works through it.
 *
 * Runs the real pipeline - derive, lens, dagre - rather than asserting on an
 * intermediate, because every previous layer looked correct in isolation while
 * the picture still moved. Positions are the only honest evidence.
 */

import { deriveGraph } from "../BeadsGraph";
import type { DriftKind } from "../drift";
import { applyLens, LensBead } from "../lens";
import { layoutGraph } from "../layout";
import type { GraphInputEdge, GraphInputNode } from "../types";

const raw = (id: string, over: Partial<GraphInputNode> = {}): GraphInputNode => ({
  id,
  status: "open",
  issue_type: "task",
  priority: 2,
  created_at: "2026-08-12T00:00:00Z",
  ...over,
});

/** A five-bead epic in a blocking chain: t1 -> t2 -> t3 -> t4. */
const EPIC: GraphInputNode[] = [
  raw("e1", { issue_type: "epic" }),
  raw("t1", { parent: "e1" }),
  raw("t2", { parent: "e1" }),
  raw("t3", { parent: "e1" }),
  raw("t4", { parent: "e1" }),
];
const CHAIN: GraphInputEdge[] = [
  { from: "t2", to: "t1", type: "blocks" },
  { from: "t3", to: "t2", type: "blocks" },
  { from: "t4", to: "t3", type: "blocks" },
];

/**
 * Lay the epic out with `closedIds` finished, exactly as the canvas would.
 *
 * `drift` is the plan-drift annotation the canvas would be passing at the same
 * time. It is threaded through here rather than tested separately because the
 * claim being made is about the real pipeline: an annotation that reached
 * dagre through node order, node size, or the edge set would show up as moved
 * positions and nowhere else.
 */
function layoutWith(
  closedIds: string[],
  drift?: Record<string, DriftKind>
): Map<string, { x: number; y: number }> {
  const nodes = EPIC.map((node) =>
    closedIds.includes(node.id) ? { ...node, status: "closed" } : node
  );
  const model = deriveGraph(nodes, CHAIN, { complete: true });
  const beads: LensBead[] = nodes.map((node) => ({
    id: node.id,
    title: `Bead ${node.id}`,
    type: node.issue_type,
    status: node.status,
  }));

  const result = applyLens(model, beads, { lens: "epic", epicId: "e1", drift });
  const laidOut = layoutGraph(
    result.nodes.map((node) => ({ id: node.id, width: 208, height: node.progress ? 68 : 52 })),
    result.edges.map((edge) => ({ source: edge.blocker, target: edge.blocked })),
    { direction: "LR" }
  );

  return new Map(
    [...laidOut.positions].map(([id, pos]) => [id, { x: pos.x, y: pos.y }])
  );
}

describe("an epic worked through from start to finish", () => {
  it("never moves a bead as its blockers close", () => {
    const start = layoutWith([]);

    // Work the chain in order, the way an agent would.
    for (const done of [["t1"], ["t1", "t2"], ["t1", "t2", "t3"], ["t1", "t2", "t3", "t4"]]) {
      expect(layoutWith(done)).toEqual(start);
    }
  });

  it("keeps every arrow for the whole run", () => {
    const edgeCount = (closed: string[]) => {
      const nodes = EPIC.map((n) => (closed.includes(n.id) ? { ...n, status: "closed" } : n));
      const model = deriveGraph(nodes, CHAIN, { complete: true });
      const beads: LensBead[] = nodes.map((n) => ({
        id: n.id,
        title: n.id,
        type: n.issue_type,
        status: n.status,
      }));
      return applyLens(model, beads, { lens: "epic", epicId: "e1" }).edges.filter(
        (e) => e.kind === "blocks"
      ).length;
    };

    expect(edgeCount([])).toBe(3);
    expect(edgeCount(["t1", "t2", "t3", "t4"])).toBe(3);
  });
});

/**
 * The same regression, one layer out: a diff overlay is exactly the kind of
 * feature that reintroduces churn, because the obvious implementations - size
 * the node to fit a badge, sort changed beads to the front, drop the unchanged
 * ones - all feed dagre.
 */
describe("a plan-drift comparison switched on over an epic being read", () => {
  const CLEAN = layoutWith([]);

  it("moves nothing when the comparison point is set", () => {
    expect(layoutWith([], { t2: "closed", t3: "rescoped" })).toEqual(CLEAN);
  });

  it("moves nothing as the comparison changes to a different point", () => {
    // Every bead annotated, then a different subset, then none: the picture is
    // identical throughout, because drift is decoration and nothing else.
    const all = layoutWith([], {
      e1: "touched",
      t1: "added",
      t2: "closed",
      t3: "reprioritized",
      t4: "reopened",
    });
    const some = layoutWith([], { t4: "added" });

    expect(all).toEqual(CLEAN);
    expect(some).toEqual(CLEAN);
  });

  it("moves nothing when work closes underneath a running comparison", () => {
    // The two mechanisms that could each move the graph, together: an agent
    // closing beads while a comparison is pinned.
    for (const done of [["t1"], ["t1", "t2"], ["t1", "t2", "t3"]]) {
      expect(layoutWith(done, { t1: "closed", t2: "touched" })).toEqual(CLEAN);
    }
  });

  it("names a drifted bead that a deleted one cannot displace", () => {
    // A removed bead has no node. Passing one must not add a phantom to the
    // layout - which would move everything after it.
    expect(layoutWith([], { t2: "closed", "deleted-bead": "removed" })).toEqual(CLEAN);
  });
});
