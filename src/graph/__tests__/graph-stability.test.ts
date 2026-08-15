/**
 * The regression this whole change exists to prevent: an epic re-flowing on the
 * canvas while an agent works through it.
 *
 * Runs the real pipeline - derive, lens, dagre - rather than asserting on an
 * intermediate, because every previous layer looked correct in isolation while
 * the picture still moved. Positions are the only honest evidence.
 */

import { deriveGraph } from "../BeadsGraph";
import { applyLens, LensBead, listContainers } from "../lens";
import { layoutGraph } from "../layout";
import { buildTree } from "../tree";
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
 * The same five beads with the container typed something else.
 *
 * Rollup used to be an epic-only thing, so "does a milestone behave exactly as
 * an epic did" is a question with a single honest answer: lay both out and
 * compare pixels.
 */
const withContainerType = (type: string): GraphInputNode[] =>
  EPIC.map((node) => (node.id === "e1" ? { ...node, issue_type: type } : node));

/** Lay the container out with `closedIds` finished, exactly as the canvas would. */
function layoutWith(
  closedIds: string[],
  source: GraphInputNode[] = EPIC
): Map<string, { x: number; y: number }> {
  const nodes = source.map((node) =>
    closedIds.includes(node.id) ? { ...node, status: "closed" } : node
  );
  const model = deriveGraph(nodes, CHAIN, { complete: true });
  const beads: LensBead[] = nodes.map((node) => ({
    id: node.id,
    title: `Bead ${node.id}`,
    type: node.issue_type,
    status: node.status,
  }));

  const result = applyLens(model, beads, { lens: "epic", containerId: "e1" });
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
      return applyLens(model, beads, { lens: "epic", containerId: "e1" }).edges.filter(
        (e) => e.kind === "blocks"
      ).length;
    };

    expect(edgeCount([])).toBe(3);
    expect(edgeCount(["t1", "t2", "t3", "t4"])).toBe(3);
  });
});

/**
 * Rollup went polymorphic. These pin down the half of that change that could
 * only ever be proved by comparison: a milestone is not "also supported", it is
 * the identical picture, and the epic that worked before still does.
 */
describe("a milestone in the container lens", () => {
  const MILESTONE = withContainerType("milestone");

  it("draws exactly the picture an epic of the same shape draws", () => {
    expect(layoutWith([], MILESTONE)).toEqual(layoutWith([], EPIC));
  });

  it("never moves a bead as its blockers close, same as an epic", () => {
    const start = layoutWith([], MILESTONE);

    for (const done of [["t1"], ["t1", "t2"], ["t1", "t2", "t3"], ["t1", "t2", "t3", "t4"]]) {
      expect(layoutWith(done, MILESTONE)).toEqual(start);
    }
  });

  it("is offered by the picker with the same progress an epic would report", () => {
    const read = (source: GraphInputNode[]) => {
      const model = deriveGraph(source, CHAIN, { complete: true });
      const beads: LensBead[] = source.map((node) => ({
        id: node.id,
        title: `Bead ${node.id}`,
        type: node.issue_type,
        status: node.status,
      }));
      return listContainers(model, beads);
    };

    expect(read(MILESTONE)).toEqual(read(EPIC));
    expect(read(MILESTONE)).toEqual([
      { id: "e1", label: "Bead e1", total: 4, closed: 0, complete: false },
    ]);
  });

  it("heads its own group before it holds anything, same as an empty epic", () => {
    // The regression fixed in "head an epic's own group before it has any
    // tasks", now asked of the type that never got the fix.
    const lone = (type: string) => {
      const nodes: GraphInputNode[] = [raw("c1", { issue_type: type }), raw("loner")];
      const graph = deriveGraph(nodes, [], { complete: true });
      const tree = buildTree(
        nodes.map((n) => ({ id: n.id })),
        graph,
        { containers: ["c1"] }
      );
      return { roots: tree.roots.map((r) => r.id), orphans: tree.orphans.map((r) => r.id) };
    };

    expect(lone("milestone")).toEqual({ roots: ["c1"], orphans: ["loner"] });
    expect(lone("milestone")).toEqual(lone("epic"));
  });
});

describe("member estimates", () => {
  /** The chain again, with an estimate on every task. */
  const ESTIMATED = EPIC.map((node) =>
    node.id === "e1" ? node : { ...node, estimated_minutes: 30 }
  );

  it("does not move a single bead", () => {
    // Summing a number nobody had summed before must stay invisible to layout.
    // The epic's own card is the only thing that grew, and it grows on
    // `progress`, which this change did not touch.
    expect(layoutWith([], ESTIMATED)).toEqual(layoutWith([], EPIC));
  });

  it("does not change which containers the picker offers", () => {
    const read = (source: GraphInputNode[]) => {
      const model = deriveGraph(source, CHAIN, { complete: true });
      const beads: LensBead[] = source.map((node) => ({
        id: node.id,
        title: `Bead ${node.id}`,
        type: node.issue_type,
        status: node.status,
      }));
      return listContainers(model, beads);
    };

    expect(read(ESTIMATED)).toEqual(read(EPIC));
  });

  it("reaches the container from four tasks down a chain", () => {
    const model = deriveGraph(ESTIMATED, CHAIN, { complete: true });

    expect(model.nodes.e1.memberEstimate).toEqual({ minutes: 120, counted: 4, total: 4 });
  });
});
