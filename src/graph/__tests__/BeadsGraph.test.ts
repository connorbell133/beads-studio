import { deriveGraph } from "../BeadsGraph";
import type { GraphInputNode } from "../types";

// Shorthand builders. `blocks(a, b)` reads as "a is blocked by b", matching
// `bd dep add <from> <to>` and the BeadEdge direction convention.
const node = (id: string, over: Partial<GraphInputNode> = {}): GraphInputNode => ({
  id,
  status: "open",
  issue_type: "task",
  priority: 2,
  created_at: "2026-08-12T00:00:00Z",
  ...over,
});
const blocks = (from: string, to: string) => ({ from, to, type: "blocks" });

describe("deriveGraph readiness", () => {
  it("marks an unblocked open bead ready and its dependent blocked", () => {
    const g = deriveGraph([node("a"), node("b")], [blocks("b", "a")]);

    expect(g.nodes.a.ready).toBe(true);
    expect(g.nodes.b.ready).toBe(false);
    expect(g.nodes.b.blockedBy).toEqual(["a"]);
    expect(g.ready).toEqual(["a"]);
    expect(g.blocked).toEqual(["b"]);
  });

  it("stops counting a blocker once it closes", () => {
    const g = deriveGraph([node("a", { status: "closed" }), node("b")], [blocks("b", "a")]);

    expect(g.nodes.b.ready).toBe(true);
    expect(g.nodes.b.blockedBy).toEqual([]);
  });

  it("gates readiness on blocks edges only", () => {
    // Only `blocks` affects bd ready. Containment and cross-references never do.
    const edges = [
      { from: "b", to: "a", type: "parent-child" },
      { from: "b", to: "c", type: "related" },
      { from: "b", to: "d", type: "discovered-from" },
    ];
    const g = deriveGraph([node("a"), node("b"), node("c"), node("d")], edges);

    expect(g.nodes.b.ready).toBe(true);
    expect(g.nodes.b.blockedBy).toEqual([]);
  });

  it("treats a blocker outside the node set as open", () => {
    // Fail-safe: over-reporting blocked is recoverable, over-reporting ready is not.
    const g = deriveGraph([node("b")], [blocks("b", "ghost")]);

    expect(g.nodes.b.ready).toBe(false);
    expect(g.nodes.b.blockedBy).toEqual(["ghost"]);
  });

  it("counts only beads whose status is exactly open as ready", () => {
    // Verified against bd 1.2.1: `bd ready` excludes in_progress, pinned, and
    // deferred beads even when nothing blocks them.
    const nodes = [
      node("open"),
      node("wip", { status: "in_progress" }),
      node("pin", { status: "pinned" }),
      node("def", { status: "deferred" }),
      node("done", { status: "closed" }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.ready).toEqual(["open"]);
  });

  it("keeps coordination beads out of the work queues while honouring their edges", () => {
    // Verified against bd 1.2.1: an open, unblocked gate is absent from
    // `bd ready`, yet a task depending on it is absent too - the gate blocks
    // without ever being pickable itself.
    const g = deriveGraph(
      [node("gate", { issue_type: "gate" }), node("task")],
      [blocks("task", "gate")]
    );

    expect(g.ready).toEqual([]);
    expect(g.blocked).toEqual(["task"]);
    expect(g.nodes.gate).toBeDefined();
    expect(g.nodes.task.blockedBy).toEqual(["gate"]);
  });

  it("normalizes status aliases before deciding readiness", () => {
    const g = deriveGraph([node("a", { status: "done" }), node("b")], [blocks("b", "a")]);

    expect(g.nodes.b.ready).toBe(true);
  });
});

describe("deriveGraph rank and critical path", () => {
  it("ranks a sequential chain by depth", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => node(id));
    const edges = [blocks("b", "a"), blocks("c", "b"), blocks("d", "c")];
    const g = deriveGraph(nodes, edges);

    expect([g.nodes.a.rank, g.nodes.b.rank, g.nodes.c.rank, g.nodes.d.rank]).toEqual([0, 1, 2, 3]);
  });

  it("takes the longest path, not the shortest, through a diamond", () => {
    // a <- b <- d and a <- c <- d: d sits two hops out, not one.
    const nodes = ["a", "b", "c", "d"].map((id) => node(id));
    const edges = [blocks("b", "a"), blocks("c", "a"), blocks("d", "b"), blocks("d", "c")];
    const g = deriveGraph(nodes, edges);

    expect(g.nodes.d.rank).toBe(2);
  });

  it("reports an epic's critical path as its deepest member chain", () => {
    const nodes = [
      node("epic", { issue_type: "epic" }),
      ...["a", "b", "c", "d"].map((id) => node(id, { parent: "epic" })),
    ];
    const edges = [blocks("b", "a"), blocks("c", "b"), blocks("d", "c")];
    const g = deriveGraph(nodes, edges);

    expect(g.nodes.epic.criticalPath).toBe(4);
  });

  it("reports a critical path of 1 for an epic whose members never block each other", () => {
    const nodes = [
      node("epic", { issue_type: "epic" }),
      node("a", { parent: "epic" }),
      node("b", { parent: "epic" }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.epic.criticalPath).toBe(1);
  });

  it("exposes the longest open blocker chain from a bead", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => node(id));
    const edges = [blocks("b", "a"), blocks("c", "b"), blocks("d", "c")];
    const g = deriveGraph(nodes, edges);

    expect(g.nodes.d.blockerChain).toEqual(["c", "b", "a"]);
  });
});

describe("deriveGraph cycles", () => {
  it("survives a cycle, flags it, and still ranks every node", () => {
    const nodes = ["a", "b", "c"].map((id) => node(id));
    const edges = [blocks("a", "b"), blocks("b", "c"), blocks("c", "a")];
    const g = deriveGraph(nodes, edges);

    expect(g.hasCycle).toBe(true);
    expect(g.cycles).toHaveLength(1);
    expect([...g.cycles[0]].sort()).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(Number.isFinite(g.nodes[id].rank)).toBe(true);
      expect(g.nodes[id].inCycle).toBe(true);
    }
  });

  it("reports two disjoint cycles separately", () => {
    const nodes = ["a", "b", "x", "y"].map((id) => node(id));
    const edges = [blocks("a", "b"), blocks("b", "a"), blocks("x", "y"), blocks("y", "x")];
    const g = deriveGraph(nodes, edges);

    expect(g.cycles).toHaveLength(2);
    expect(g.cycles.map((c) => [...c].sort().join(",")).sort()).toEqual(["a,b", "x,y"]);
  });

  it("leaves acyclic graphs unflagged", () => {
    const g = deriveGraph([node("a"), node("b")], [blocks("b", "a")]);

    expect(g.hasCycle).toBe(false);
    expect(g.cycles).toEqual([]);
    expect(g.nodes.a.inCycle).toBe(false);
  });

  it("does not let a cycle stall the blocker chain", () => {
    const nodes = ["a", "b"].map((id) => node(id));
    const g = deriveGraph(nodes, [blocks("a", "b"), blocks("b", "a")]);

    expect(g.nodes.a.blockerChain.length).toBeLessThanOrEqual(2);
  });
});

describe("deriveGraph leverage", () => {
  it("counts the transitive set a closure would unblock", () => {
    // x blocks y and z; y blocks p; z blocks q. Closing x frees four beads.
    const nodes = ["x", "y", "z", "p", "q"].map((id) => node(id));
    const edges = [blocks("y", "x"), blocks("z", "x"), blocks("p", "y"), blocks("q", "z")];
    const g = deriveGraph(nodes, edges);

    expect(g.nodes.x.leverage).toBe(4);
  });

  it("counts a shared descendant once", () => {
    const nodes = ["x", "y", "z", "shared"].map((id) => node(id));
    const edges = [
      blocks("y", "x"),
      blocks("z", "x"),
      blocks("shared", "y"),
      blocks("shared", "z"),
    ];
    const g = deriveGraph(nodes, edges);

    expect(g.nodes.x.leverage).toBe(3);
  });

  it("reports zero leverage for a bead nothing depends on", () => {
    const g = deriveGraph([node("a"), node("b")], [blocks("a", "b")]);

    expect(g.nodes.a.leverage).toBe(0);
  });

  it("does not count an already-closed dependent", () => {
    // Regression: closing X cannot unblock D when D is already closed, but the
    // edge still existed so it inflated the number the ready lane sorts on.
    const g = deriveGraph(
      [node("x"), node("d", { status: "closed" })],
      [blocks("d", "x")]
    );

    expect(g.nodes.x.leverage).toBe(0);
  });

  it("stops the chain at a closed dependent, which no longer blocks anything", () => {
    // end depends on mid, and mid is closed - so end is already unblocked and
    // nothing x does can change that. The chain genuinely ends at a closed
    // bead, because a closed blocker stops blocking.
    const g = deriveGraph(
      [node("x"), node("mid", { status: "closed" }), node("end")],
      [blocks("mid", "x"), blocks("end", "mid")]
    );

    expect(g.nodes.x.leverage).toBe(0);
    expect(g.nodes.end.ready).toBe(true);
  });
});

describe("deriveGraph hierarchy", () => {
  it("nests children declared by the parent scalar", () => {
    const nodes = [
      node("epic", { issue_type: "epic" }),
      node("a", { parent: "epic" }),
      node("b", { parent: "epic" }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.epic.children).toEqual(["a", "b"]);
    expect(g.nodes.a.parent).toBe("epic");
  });

  it("falls back to the parent-child edge when the scalar is absent", () => {
    const nodes = [node("epic", { issue_type: "epic" }), node("a")];
    const g = deriveGraph(nodes, [{ from: "a", to: "epic", type: "parent-child" }]);

    expect(g.nodes.epic.children).toEqual(["a"]);
    expect(g.nodes.a.parent).toBe("epic");
  });

  it("rolls up child completion on an epic", () => {
    const nodes = [
      node("epic", { issue_type: "epic" }),
      node("a", { parent: "epic", status: "closed" }),
      node("b", { parent: "epic" }),
      node("c", { parent: "epic" }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.epic.childCounts).toEqual({ closed: 1, total: 3 });
  });

  it("reports no rollup for an epic with no children", () => {
    const g = deriveGraph([node("epic", { issue_type: "epic" })], []);

    expect(g.nodes.epic.childCounts).toBeUndefined();
  });

  it("collects parentless beads, including top-level epics", () => {
    const nodes = [
      node("epic", { issue_type: "epic" }),
      node("child", { parent: "epic" }),
      node("loner"),
    ];
    const g = deriveGraph(nodes, []);

    // Deliberately includes the epic: `parentless` is not "standalone work".
    // A surface wanting that sense must narrow it, as the tree view does.
    expect(g.parentless).toContain("loner");
    expect(g.parentless).toContain("epic");
    expect(g.parentless).not.toContain("child");
  });

  it("treats a bead whose declared parent is missing as parentless", () => {
    const g = deriveGraph([node("a", { parent: "missing-epic" })], []);

    expect(g.parentless).toEqual(["a"]);
    expect(g.nodes.a.parent).toBeUndefined();
  });
});

describe("deriveGraph contract", () => {
  it("carries the completeness flag through without altering derived values", () => {
    const nodes = [node("a"), node("b")];
    const edges = [blocks("b", "a")];

    const partial = deriveGraph(nodes, edges, { complete: false });
    const full = deriveGraph(nodes, edges, { complete: true });

    expect(partial.complete).toBe(false);
    expect(full.complete).toBe(true);
    expect(partial.nodes).toEqual(full.nodes);
  });

  it("is pure - two derivations over the same input are equal", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [blocks("b", "a"), blocks("c", "b")];

    expect(deriveGraph(nodes, edges)).toEqual(deriveGraph(nodes, edges));
  });

  it("produces a structurally cloneable model", () => {
    // The model crosses the extension/webview postMessage boundary, which
    // requires plain JSON - no Map, no Set, no undefined-valued cycles.
    const g = deriveGraph([node("a"), node("b")], [blocks("b", "a")]);

    expect(() => JSON.parse(JSON.stringify(g))).not.toThrow();
    expect(JSON.parse(JSON.stringify(g)).nodes.b.blockedBy).toEqual(["a"]);
  });

  it("handles an empty project", () => {
    const g = deriveGraph([], []);

    expect(g.ready).toEqual([]);
    expect(g.blocked).toEqual([]);
    expect(g.hasCycle).toBe(false);
    expect(g.nodes).toEqual({});
  });

  it("ignores an edge whose source is not in the node set", () => {
    const g = deriveGraph([node("a")], [blocks("ghost", "a")]);

    expect(g.nodes.ghost).toBeUndefined();
    expect(g.nodes.a.leverage).toBe(0);
  });

  it("derives a 2000-node graph without exhausting the stack", () => {
    // Traversal must be iterative: a 2000-deep chain would blow a recursive DFS.
    const nodes: GraphInputNode[] = [];
    const edges: Array<{ from: string; to: string; type: string }> = [];
    for (let i = 0; i < 2000; i++) {
      nodes.push(node(`n${i}`));
      if (i > 0) edges.push(blocks(`n${i}`, `n${i - 1}`));
    }
    // Fan extra edges across the chain to reach ~5000 total.
    for (let i = 0; i < 3000; i++) {
      edges.push(blocks(`n${(i * 7) % 2000}`, `n${(i * 13) % 2000}`));
    }

    const g = deriveGraph(nodes, edges);

    expect(Object.keys(g.nodes)).toHaveLength(2000);
    expect(Number.isFinite(g.nodes.n1999.rank)).toBe(true);
  });
});
