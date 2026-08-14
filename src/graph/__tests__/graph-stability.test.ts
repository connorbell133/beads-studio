/**
 * The regression this whole change exists to prevent: an epic re-flowing on the
 * canvas while an agent works through it.
 *
 * Runs the real pipeline - derive, lens, dagre - rather than asserting on an
 * intermediate, because every previous layer looked correct in isolation while
 * the picture still moved. Positions are the only honest evidence.
 */

import { deriveGraph } from "../BeadsGraph";
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

/** Lay the epic out with `closedIds` finished, exactly as the canvas would. */
function layoutWith(closedIds: string[]): Map<string, { x: number; y: number }> {
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

  const result = applyLens(model, beads, { lens: "epic", epicId: "e1" });
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
