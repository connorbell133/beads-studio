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

describe("deriveGraph structural blocking graph", () => {
  it("keeps a recorded blocker in dependsOn after it closes", () => {
    const g = deriveGraph([node("a", { status: "closed" }), node("b")], [blocks("b", "a")]);

    expect(g.nodes.b.dependsOn).toEqual(["a"]);
    expect(g.nodes.b.blockedBy).toEqual([]);
  });

  it("holds layoutRank still when a blocker closes, while rank drops", () => {
    // The whole point: rank moves as work lands, so anything laid out from it
    // reshuffles. layoutRank is what the picture is allowed to move with.
    const edges = [blocks("b", "a")];
    const open = deriveGraph([node("a"), node("b")], edges);
    const closed = deriveGraph([node("a", { status: "closed" }), node("b")], edges);

    expect(open.nodes.b.layoutRank).toBe(1);
    expect(closed.nodes.b.layoutRank).toBe(1);

    expect(open.nodes.b.rank).toBe(1);
    expect(closed.nodes.b.rank).toBe(0);
  });

  it("holds layoutRank still further down a chain", () => {
    const edges = [blocks("b", "a"), blocks("c", "b")];
    const before = deriveGraph([node("a"), node("b"), node("c")], edges);
    const after = deriveGraph([node("a", { status: "closed" }), node("b"), node("c")], edges);

    expect(before.nodes.c.layoutRank).toBe(2);
    expect(after.nodes.c.layoutRank).toBe(2);
  });

  it("leaves leverage on the open graph, so a closed bead unblocks nothing", () => {
    const g = deriveGraph([node("a", { status: "closed" }), node("b")], [blocks("b", "a")]);

    expect(g.nodes.a.leverage).toBe(0);
  });

  it("does not resurrect a cycle a closed bead had broken", () => {
    // Structurally a -> b -> a is still a loop, but b is done, so nothing is
    // actually tangled. The header must not warn about it.
    const g = deriveGraph(
      [node("a"), node("b", { status: "closed" })],
      [blocks("a", "b"), blocks("b", "a")]
    );

    expect(g.cycles).toEqual([]);
    expect(g.hasCycle).toBe(false);
  });

  it("still ranks every node when the structural graph is cyclic", () => {
    // The trap: findCycles runs on the open graph, so its tangled set does not
    // name these ids. Without its own detection the Kahn walk stalls and both
    // nodes silently keep layoutRank 0.
    const g = deriveGraph(
      [node("a", { priority: 0 }), node("b", { status: "closed", priority: 1 })],
      [blocks("a", "b"), blocks("b", "a")]
    );

    expect(g.nodes.a.layoutRank).not.toBe(g.nodes.b.layoutRank);
    expect(Number.isFinite(g.nodes.a.layoutRank)).toBe(true);
    expect(Number.isFinite(g.nodes.b.layoutRank)).toBe(true);
  });

  it("empties blockerChain once the only blocker closes", () => {
    const g = deriveGraph([node("a", { status: "closed" }), node("b")], [blocks("b", "a")]);

    expect(g.nodes.b.blockerChain).toEqual([]);
    expect(g.nodes.b.ready).toBe(true);
  });

  it("records a blocker outside the node set in both views", () => {
    const g = deriveGraph([node("b")], [blocks("b", "ghost")]);

    expect(g.nodes.b.dependsOn).toEqual(["ghost"]);
    expect(g.nodes.b.blockedBy).toEqual(["ghost"]);
  });

  it("ignores non-blocking edges in dependsOn", () => {
    const g = deriveGraph(
      [node("a"), node("b")],
      [{ from: "b", to: "a", type: "parent-child" }]
    );

    expect(g.nodes.b.dependsOn).toEqual([]);
  });
});

describe("container types", () => {
  it("gives an empty milestone its own depth, as it always did for an epic", () => {
    const g = deriveGraph(
      [node("m", { issue_type: "milestone" }), node("e", { issue_type: "epic" })],
      []
    );

    expect(g.nodes.m.criticalPath).toBe(1);
    expect(g.nodes.e.criticalPath).toBe(1);
  });

  it("gives a childless leaf no critical path at all", () => {
    // Containment is what earns a depth. A task with nothing under it has none.
    const g = deriveGraph([node("t")], []);

    expect(g.nodes.t.criticalPath).toBeUndefined();
  });

  it("reports a milestone's critical path from its members, same as an epic", () => {
    const nodes = [
      node("m", { issue_type: "milestone" }),
      ...["a", "b", "c"].map((id) => node(id, { parent: "m" })),
    ];
    const g = deriveGraph(nodes, [blocks("b", "a"), blocks("c", "b")]);

    expect(g.nodes.m.criticalPath).toBe(3);
  });
});

describe("deriveGraph member estimates", () => {
  it("sums the estimates of a container's members", () => {
    const nodes = [
      node("e", { issue_type: "epic" }),
      node("a", { parent: "e", estimated_minutes: 30 }),
      node("b", { parent: "e", estimated_minutes: 90 }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.e.memberEstimate).toEqual({ minutes: 120, counted: 2, total: 2 });
  });

  it("reaches through the whole subtree, not just the direct children", () => {
    // A milestone holds epics; epics hold the tasks that carry the estimates.
    // A direct-children sum would report nothing at the level that matters.
    const nodes = [
      node("m", { issue_type: "milestone" }),
      node("e", { issue_type: "epic", parent: "m" }),
      node("a", { parent: "e", estimated_minutes: 60 }),
      node("b", { parent: "e", estimated_minutes: 60 }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.m.memberEstimate).toEqual({ minutes: 120, counted: 2, total: 3 });
    expect(g.nodes.e.memberEstimate).toEqual({ minutes: 120, counted: 2, total: 2 });
  });

  it("counts members without an estimate so the total reads as a floor", () => {
    const nodes = [
      node("e", { issue_type: "epic" }),
      node("a", { parent: "e", estimated_minutes: 45 }),
      node("b", { parent: "e" }),
      node("c", { parent: "e" }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.e.memberEstimate).toEqual({ minutes: 45, counted: 1, total: 3 });
  });

  it("reports nothing when no member carries an estimate", () => {
    // `0m` would be a claim about the work; absence is a gap in the data.
    const nodes = [node("e", { issue_type: "epic" }), node("a", { parent: "e" })];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.e.memberEstimate).toBeUndefined();
  });

  it("treats a recorded zero the same as no estimate at all", () => {
    const nodes = [
      node("e", { issue_type: "epic" }),
      node("a", { parent: "e", estimated_minutes: 0 }),
      node("b", { parent: "e", estimated_minutes: 20 }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.e.memberEstimate).toEqual({ minutes: 20, counted: 1, total: 2 });
  });

  it("reports nothing on a bead with no members", () => {
    const g = deriveGraph([node("t", { estimated_minutes: 60 })], []);

    expect(g.nodes.t.memberEstimate).toBeUndefined();
  });

  it("does not count a bead's own estimate towards its own total", () => {
    const nodes = [
      node("e", { issue_type: "epic", estimated_minutes: 500 }),
      node("a", { parent: "e", estimated_minutes: 10 }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.e.memberEstimate).toEqual({ minutes: 10, counted: 1, total: 1 });
  });

  it("follows parentage that arrives only as a parent-child edge", () => {
    const nodes = [node("e", { issue_type: "epic" }), node("a", { estimated_minutes: 25 })];
    const g = deriveGraph(nodes, [{ from: "a", to: "e", type: "parent-child" }]);

    expect(g.nodes.e.memberEstimate).toEqual({ minutes: 25, counted: 1, total: 1 });
  });

  it("terminates on a parent-child loop instead of summing forever", () => {
    const nodes = [
      node("a", { parent: "b", estimated_minutes: 10 }),
      node("b", { parent: "a", estimated_minutes: 10 }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.a.memberEstimate).toEqual({ minutes: 10, counted: 1, total: 1 });
    expect(g.nodes.b.memberEstimate).toEqual({ minutes: 10, counted: 1, total: 1 });
  });

  it("keeps counting a member after it closes", () => {
    // The estimate is what the work was sized at, not what is left to do.
    // Netting closed members out would make this a forecast, which it is not.
    const nodes = [
      node("e", { issue_type: "epic" }),
      node("a", { parent: "e", estimated_minutes: 60, status: "closed" }),
      node("b", { parent: "e", estimated_minutes: 60 }),
    ];
    const g = deriveGraph(nodes, []);

    expect(g.nodes.e.memberEstimate).toEqual({ minutes: 120, counted: 2, total: 2 });
  });
});
