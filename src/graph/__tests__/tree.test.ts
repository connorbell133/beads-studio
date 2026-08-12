import { deriveGraph } from "../BeadsGraph";
import { buildTree, projectKeyFor, TreeBead } from "../tree";
import type { GraphInputEdge, GraphInputNode } from "../types";

/**
 * The tree is built over the derived graph rather than over raw beads, so these
 * go through `deriveGraph` on the way in. That is deliberate: the two ways bd
 * expresses parentage - the `parent` scalar and the `parent-child` edge - are
 * reconciled there, and a tree test that skipped it would not be testing the
 * shape the view actually receives.
 */
const node = (id: string, over: Partial<GraphInputNode> = {}): GraphInputNode => ({
  id,
  status: "open",
  issue_type: "task",
  ...over,
});

const epic = (id: string, over: Partial<GraphInputNode> = {}): GraphInputNode =>
  node(id, { issue_type: "epic", ...over });

const parentEdge = (child: string, parent: string): GraphInputEdge => ({
  from: child,
  to: parent,
  type: "parent-child",
});

const ids = <T extends { id: string }>(rows: TreeBead<T>[]): string[] => rows.map((r) => r.id);
const childIds = <T extends { id: string }>(row: TreeBead<T>): string[] =>
  (row.subRows ?? []).map((r) => r.id);

describe("buildTree", () => {
  it("nests tasks under the epic named by their parent scalar", () => {
    const nodes = [
      epic("e1"),
      node("t1", { parent: "e1" }),
      node("t2", { parent: "e1" }),
      node("t3", { parent: "e1" }),
    ];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(ids(tree.roots)).toEqual(["e1"]);
    expect(childIds(tree.roots[0])).toEqual(["t1", "t2", "t3"]);
    expect(tree.orphans).toEqual([]);
    expect(tree.rowCount).toBe(4);
  });

  it("nests a task whose parentage arrives only as a parent-child edge", () => {
    const nodes = [epic("e1"), node("t1")];

    const tree = buildTree(nodes, deriveGraph(nodes, [parentEdge("t1", "e1")]));

    expect(ids(tree.roots)).toEqual(["e1"]);
    expect(childIds(tree.roots[0])).toEqual(["t1"]);
  });

  it("agrees with itself when bd emits both the scalar and the edge", () => {
    // bd 1.2.1 emits both for the same fact; the child must appear once.
    const nodes = [epic("e1"), node("t1", { parent: "e1" })];

    const tree = buildTree(nodes, deriveGraph(nodes, [parentEdge("t1", "e1")]));

    expect(childIds(tree.roots[0])).toEqual(["t1"]);
    expect(tree.rowCount).toBe(2);
  });

  it("lands a task whose parent is missing from the node set in orphans", () => {
    const nodes = [node("t1", { parent: "gone" })];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(ids(tree.orphans)).toEqual(["t1"]);
    expect(tree.roots).toEqual([]);
    expect(tree.rowCount).toBe(1);
  });

  it("lands a task whose parent was filtered out of this list in orphans", () => {
    // The epic exists in the graph but not in the beads handed to the view -
    // hidden by a type filter upstream. The child must still be reachable.
    const nodes = [epic("e1"), node("t1", { parent: "e1" })];
    const graph = deriveGraph(nodes, []);

    const tree = buildTree([nodes[1]], graph);

    expect(ids(tree.orphans)).toEqual(["t1"]);
    expect(tree.rowCount).toBe(1);
  });

  it("separates hierarchy roots from parentless standalone work", () => {
    const nodes = [epic("e1"), node("t1", { parent: "e1" }), node("loner")];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(ids(tree.roots)).toEqual(["e1"]);
    expect(ids(tree.orphans)).toEqual(["loner"]);
  });

  it("nests three levels deep and reports depth on each row", () => {
    const nodes = [
      epic("e1"),
      node("s1", { parent: "e1", issue_type: "story" }),
      node("t1", { parent: "s1" }),
    ];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    const story = tree.roots[0].subRows![0];
    expect(tree.roots[0].treeDepth).toBe(0);
    expect(story.treeDepth).toBe(1);
    expect(story.subRows![0].treeDepth).toBe(2);
  });

  it("nests a child listed before its parent", () => {
    const nodes = [node("t1", { parent: "e1" }), epic("e1")];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(ids(tree.roots)).toEqual(["e1"]);
    expect(childIds(tree.roots[0])).toEqual(["t1"]);
  });

  it("terminates on a parent-child cycle and reports the ids caught in it", () => {
    const nodes = [node("a", { parent: "b" }), node("b", { parent: "a" }), node("c")];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(tree.cycleIds).toEqual(["a", "b"]);
    // Both members surface at the root, flagged, and neither nests the other.
    expect(tree.roots.every((row) => row.subRows === undefined)).toBe(true);
    expect(tree.rowCount).toBe(3);
    const flagged = [...tree.roots, ...tree.orphans].filter((row) => row.treeCycle);
    expect(ids(flagged).sort()).toEqual(["a", "b"]);
  });

  it("keeps a bead hanging off a cycle out of the loop", () => {
    // c -> b -> a -> b. Only a and b are on the loop; c hangs from it.
    const nodes = [
      node("a", { parent: "b" }),
      node("b", { parent: "a" }),
      node("c", { parent: "b" }),
    ];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(tree.cycleIds).toEqual(["a", "b"]);
    const b = [...tree.roots, ...tree.orphans].find((row) => row.id === "b")!;
    expect(childIds(b)).toEqual(["c"]);
    expect(tree.rowCount).toBe(3);
  });

  it("ignores a bead that claims itself as its parent", () => {
    const nodes = [node("a", { parent: "a" })];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(tree.cycleIds).toEqual([]);
    expect(ids(tree.orphans)).toEqual(["a"]);
  });
});

describe("rollup", () => {
  const twelveChildren = (closed: number): GraphInputNode[] => [
    epic("e1"),
    ...Array.from({ length: 12 }, (_, i) =>
      node(`t${String(i).padStart(2, "0")}`, {
        parent: "e1",
        status: i < closed ? "closed" : "open",
      })
    ),
  ];

  it("reports 7/12 on an epic with seven of twelve children closed", () => {
    const nodes = twelveChildren(7);

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(tree.roots[0].treeRollup).toEqual({
      closed: 7,
      total: 12,
      percent: 58,
      label: "7/12",
    });
  });

  it("reports no rollup at all on an epic with no children", () => {
    const nodes = [epic("e1")];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    // An epic with nothing under it reads `0/0` only if we let it. It has no
    // progress to report, so it reports none.
    expect(tree.orphans[0].treeRollup).toBeUndefined();
  });

  it("counts every child, not just the ones that survived the filter", () => {
    // The default "Not Closed" preset hides closed children. Completion is a
    // fact about the epic, so it must not move when a filter changes.
    const nodes = twelveChildren(7);
    const graph = deriveGraph(nodes, []);
    const open = nodes.filter((n) => n.status !== "closed");

    const tree = buildTree(open, graph, { matched: open.map((n) => n.id) });

    expect(tree.roots[0].treeRollup?.label).toBe("7/12");
    expect(childIds(tree.roots[0])).toHaveLength(5);
  });

  it("rounds percent without ever claiming a partly-done epic is finished", () => {
    const nodes = [
      epic("e1"),
      ...Array.from({ length: 3 }, (_, i) =>
        node(`t${i}`, { parent: "e1", status: i < 1 ? "closed" : "open" })
      ),
    ];

    const tree = buildTree(nodes, deriveGraph(nodes, []));

    expect(tree.roots[0].treeRollup).toMatchObject({ percent: 33, label: "1/3" });
  });
});

describe("filtering", () => {
  const project = (): GraphInputNode[] => [
    epic("e1"),
    node("t1", { parent: "e1", status: "in_progress" }),
    node("t2", { parent: "e1" }),
    epic("e2"),
    node("t3", { parent: "e2" }),
    node("loner"),
  ];

  it("keeps the parent of a matched child visible as context", () => {
    const nodes = project();

    const tree = buildTree(nodes, deriveGraph(nodes, []), { matched: ["t1"] });

    expect(ids(tree.roots)).toEqual(["e1"]);
    expect(tree.roots[0].treeContext).toBe(true);
    expect(childIds(tree.roots[0])).toEqual(["t1"]);
    expect(tree.roots[0].subRows![0].treeContext).toBe(false);
    expect(tree.matchedCount).toBe(1);
    expect(tree.rowCount).toBe(2);
  });

  it("drops a branch nothing in it matched", () => {
    const nodes = project();

    const tree = buildTree(nodes, deriveGraph(nodes, []), { matched: ["t1"] });

    expect(ids(tree.roots)).not.toContain("e2");
    expect(tree.orphans).toEqual([]);
  });

  it("keeps a matched parent even when no child matched", () => {
    const nodes = project();

    const tree = buildTree(nodes, deriveGraph(nodes, []), { matched: ["e1"] });

    expect(ids(tree.roots)).toEqual(["e1"]);
    expect(tree.roots[0].subRows).toBeUndefined();
    expect(tree.roots[0].treeContext).toBe(false);
  });

  it("keeps every ancestor of a deep match, not just the nearest", () => {
    const nodes = [
      epic("e1"),
      node("s1", { parent: "e1", issue_type: "story" }),
      node("t1", { parent: "s1" }),
    ];

    const tree = buildTree(nodes, deriveGraph(nodes, []), { matched: ["t1"] });

    expect(ids(tree.roots)).toEqual(["e1"]);
    expect(tree.roots[0].subRows![0].id).toBe("s1");
    expect(tree.roots[0].subRows![0].subRows![0].id).toBe("t1");
    expect(tree.rowCount).toBe(3);
    expect(tree.matchedCount).toBe(1);
  });

  it("accounts for every matched bead across both lanes", () => {
    // The verification for this unit: tree mode shows the same bead count as
    // list mode, plus the orphans lane.
    const nodes = project();
    const matched = nodes.map((n) => n.id);

    const tree = buildTree(nodes, deriveGraph(nodes, []), { matched });

    const walk = (rows: TreeBead<GraphInputNode>[]): string[] =>
      rows.flatMap((row) => [row.id, ...walk(row.subRows ?? [])]);
    expect([...walk(tree.roots), ...walk(tree.orphans)].sort()).toEqual([...matched].sort());
    expect(tree.matchedCount).toBe(nodes.length);
  });

  it("returns empty lanes when nothing matched", () => {
    const nodes = project();

    const tree = buildTree(nodes, deriveGraph(nodes, []), { matched: [] });

    expect(tree.roots).toEqual([]);
    expect(tree.orphans).toEqual([]);
    expect(tree.rowCount).toBe(0);
  });
});

describe("degraded input", () => {
  it("falls back to a flat root list when there is no graph", () => {
    const nodes = [epic("e1"), node("t1", { parent: "e1" })];

    const tree = buildTree(nodes, null);

    expect(ids(tree.roots)).toEqual(["e1", "t1"]);
    expect(tree.roots.every((row) => row.subRows === undefined)).toBe(true);
    expect(tree.orphans).toEqual([]);
  });

  it("still honours the filter with no graph", () => {
    const nodes = [epic("e1"), node("t1", { parent: "e1" })];

    const tree = buildTree(nodes, undefined, { matched: ["t1"] });

    expect(ids(tree.roots)).toEqual(["t1"]);
  });

  it("handles an empty backlog", () => {
    const tree = buildTree([], deriveGraph([], []));

    expect(tree).toMatchObject({ roots: [], orphans: [], cycleIds: [], rowCount: 0 });
  });
});

describe("projectKeyFor", () => {
  it("reads the project from the bead id prefix", () => {
    expect(projectKeyFor([{ id: "vsbeads-4e7" }, { id: "vsbeads-bxnb" }])).toBe("vsbeads");
  });

  it("picks the prefix most of the beads share", () => {
    const beads = [{ id: "core-1" }, { id: "core-2" }, { id: "vendored-9" }];

    expect(projectKeyFor(beads)).toBe("core");
  });

  it("keeps a multi-segment prefix intact", () => {
    expect(projectKeyFor([{ id: "my-proj-a1" }, { id: "my-proj-b2" }])).toBe("my-proj");
  });

  it("returns an empty key rather than throwing on ids it cannot parse", () => {
    expect(projectKeyFor([])).toBe("");
    expect(projectKeyFor([{ id: "nodash" }])).toBe("");
  });
});
