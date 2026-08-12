import { deriveGraph } from "../BeadsGraph";
import {
  DEFAULT_CHAIN_CAP,
  buildReadyLane,
  collectBlockers,
  mostBlocking,
  truncateChain,
} from "../readyLane";
import type { GraphInputEdge, GraphInputNode } from "../types";

const node = (id: string, over: Partial<GraphInputNode> = {}): GraphInputNode => ({
  id,
  status: "open",
  issue_type: "task",
  priority: 2,
  ...over,
});

const blocks = (from: string, to: string): GraphInputEdge => ({
  from,
  to,
  type: "blocks",
});

/** The lane only reads id and priority; titles are here to keep tests readable. */
const bead = (n: GraphInputNode) => ({ id: n.id, priority: n.priority, title: n.id });

const lane = (nodes: GraphInputNode[], edges: GraphInputEdge[] = [], chainCap?: number) =>
  buildReadyLane(deriveGraph(nodes, edges, { complete: true }), nodes.map(bead), { chainCap });

const ids = (rows: Array<{ bead: { id: string } }>) => rows.map((r) => r.bead.id);

describe("ready ordering", () => {
  it("sorts by descending leverage, then ascending priority, then id", () => {
    // `hub` releases two beads; `solo` releases none. Priority separates the
    // two zero-leverage beads, and id separates the two P1s.
    const nodes = [
      node("hub", { priority: 3 }),
      node("solo", { priority: 1 }),
      node("aaa", { priority: 1 }),
      node("zzz", { priority: 4 }),
      node("dep1"),
      node("dep2"),
    ];
    const edges = [blocks("dep1", "hub"), blocks("dep2", "hub")];

    expect(ids(lane(nodes, edges).ready)).toEqual(["hub", "aaa", "solo", "zzz"]);
  });

  it("keeps leverage ahead of priority", () => {
    // A P0 that unblocks nothing loses to a P4 that unblocks one bead: the lane
    // answers "what should I pick up", and unblocking someone else wins.
    const nodes = [node("gate", { priority: 4 }), node("urgent", { priority: 0 }), node("waiter")];

    expect(ids(lane(nodes, [blocks("waiter", "gate")]).ready)).toEqual(["gate", "urgent"]);
  });

  it("treats an unset priority as the bottom of the scale", () => {
    const nodes = [node("unset", { priority: undefined }), node("low", { priority: 3 })];

    expect(ids(lane(nodes).ready)).toEqual(["low", "unset"]);
  });

  it("reports what each ready bead unblocks", () => {
    const nodes = [node("gate"), node("a"), node("b")];
    const rows = lane(nodes, [blocks("a", "gate"), blocks("b", "a")]).ready;

    expect(rows).toHaveLength(1);
    expect(rows[0].bead.id).toBe("gate");
    expect(rows[0].unblocks).toBe(2);
  });
});

describe("blocker chains", () => {
  it("collects both blockers when a bead waits on two, ordered by rank", () => {
    // `near` sits a hop above `deep`, so it outranks both of them and reads
    // first - nearest thing in the way. `deep` and `other` are both rank 0 and
    // fall to id order, which is arbitrary but stable across refreshes.
    const nodes = [node("x"), node("near"), node("other"), node("deep")];
    const edges = [blocks("x", "near"), blocks("x", "other"), blocks("near", "deep")];
    const model = deriveGraph(nodes, edges, { complete: true });

    expect(collectBlockers(model, "x")).toEqual(["near", "deep", "other"]);
  });

  it("keeps a sibling blocker that the single-path blockerChain drops", () => {
    // Regression guard: BeadGraphNode.blockerChain follows one deepest path, so
    // closing only what it names would leave the bead still blocked.
    const nodes = [node("x"), node("near"), node("other"), node("deep")];
    const edges = [blocks("x", "near"), blocks("x", "other"), blocks("near", "deep")];
    const model = deriveGraph(nodes, edges, { complete: true });

    expect(model.nodes.x.blockerChain).not.toContain("other");
    expect(collectBlockers(model, "x")).toContain("other");
  });

  it("orders equal-rank blockers by id", () => {
    const nodes = [node("x"), node("b"), node("a")];
    const model = deriveGraph(nodes, [blocks("x", "a"), blocks("x", "b")], { complete: true });

    expect(collectBlockers(model, "x")).toEqual(["a", "b"]);
  });

  it("drops a blocker once it closes", () => {
    const nodes = [node("x"), node("done", { status: "closed" }), node("open")];
    const model = deriveGraph(nodes, [blocks("x", "done"), blocks("x", "open")], {
      complete: true,
    });

    expect(collectBlockers(model, "x")).toEqual(["open"]);
  });

  it("stops rather than hangs on a dependency cycle", () => {
    const nodes = [node("a"), node("b")];
    const model = deriveGraph(nodes, [blocks("a", "b"), blocks("b", "a")], { complete: true });

    expect(collectBlockers(model, "a").sort()).toEqual(["b"]);
  });

  it("returns an empty chain for a bead the graph has never seen", () => {
    const model = deriveGraph([node("a")], [], { complete: true });

    expect(collectBlockers(model, "ghost")).toEqual([]);
  });
});

describe("truncateChain", () => {
  it("leaves a chain at or under the cap untouched", () => {
    expect(truncateChain(["a", "b", "c"], 4)).toEqual({
      head: ["a", "b", "c"],
      hiddenCount: 0,
      tail: [],
      total: 3,
    });
  });

  it("elides the middle, keeping the first and last hop and the hidden count", () => {
    const chain = ["a", "b", "c", "d", "e", "f", "g"];

    const cut = truncateChain(chain, 4);

    expect(cut.head[0]).toBe("a");
    expect(cut.tail).toEqual(["g"]);
    expect(cut.hiddenCount).toBe(3);
    // Cap honoured exactly: three shown up front plus the last hop.
    expect(cut.head.length + cut.tail.length).toBe(4);
    expect(cut.total).toBe(7);
  });

  it("never collapses below the two hops that carry the meaning", () => {
    const cut = truncateChain(["a", "b", "c", "d"], 1);

    expect(cut.head).toEqual(["a"]);
    expect(cut.tail).toEqual(["d"]);
    expect(cut.hiddenCount).toBe(2);
  });

  it("defaults to the shared display cap", () => {
    const chain = Array.from({ length: 10 }, (_, i) => `b${i}`);

    const cut = truncateChain(chain);

    expect(cut.head.length + cut.tail.length).toBe(DEFAULT_CHAIN_CAP);
    expect(cut.hiddenCount).toBe(10 - DEFAULT_CHAIN_CAP);
  });
});

describe("grouping", () => {
  it("puts closed beads in neither group", () => {
    const nodes = [
      node("done", { status: "closed" }),
      node("ready"),
      node("waiter"),
      node("gate"),
    ];
    const model = lane(nodes, [blocks("waiter", "gate")]);

    expect(ids(model.ready)).not.toContain("done");
    expect(ids(model.blocked)).not.toContain("done");
  });

  it("groups on the graph, not on the status label", () => {
    // A bead wearing a stale `blocked` label with nothing in its way is ready;
    // an `open` bead with a live blocker is not.
    const nodes = [node("mislabelled", { status: "blocked" }), node("gate"), node("waiter")];

    const model = lane(nodes, [blocks("waiter", "gate")]);

    // `mislabelled` is not `open`, so bd's own readiness rule excludes it from
    // both queues - it is neither pickable nor blocked.
    expect(ids(model.ready)).toEqual(["gate"]);
    expect(ids(model.blocked)).toEqual(["waiter"]);
  });

  it("sorts blocked rows by shortest chain first", () => {
    const nodes = [node("shallow"), node("deep"), node("g1"), node("g2"), node("g3")];
    const edges = [
      blocks("shallow", "g1"),
      blocks("deep", "g2"),
      blocks("g2", "g3"),
    ];

    // `g2` is itself blocked by `g3`, so it joins the group at one hop and
    // leads on leverage. `deep` sinks last on its two-hop chain.
    expect(ids(lane(nodes, edges).blocked)).toEqual(["g2", "shallow", "deep"]);
  });

  it("attaches a truncated chain to each blocked row", () => {
    const nodes = [node("x"), ...["b0", "b1", "b2", "b3", "b4"].map((id) => node(id))];
    const edges = [
      blocks("x", "b0"),
      blocks("b0", "b1"),
      blocks("b1", "b2"),
      blocks("b2", "b3"),
      blocks("b3", "b4"),
    ];

    const row = lane(nodes, edges, 3).blocked.find((r) => r.bead.id === "x");

    expect(row?.chain.total).toBe(5);
    expect(row?.chain.head).toEqual(["b0", "b1"]);
    expect(row?.chain.tail).toEqual(["b4"]);
    expect(row?.chain.hiddenCount).toBe(2);
  });

  it("skips graph ids that have no bead in the payload", () => {
    const nodes = [node("a"), node("b")];
    const model = deriveGraph(nodes, [], { complete: true });

    // Only `a` was handed to the lane; `b` exists in the graph but not the list.
    const built = buildReadyLane(model, [{ id: "a", priority: 2 }]);

    expect(ids(built.ready)).toEqual(["a"]);
  });

  it("reports both groups empty on an empty project", () => {
    const built = buildReadyLane(deriveGraph([], [], { complete: true }), []);

    expect(built.ready).toEqual([]);
    expect(built.blocked).toEqual([]);
    expect(built.topBlocker).toBeNull();
    expect(built.noBeads).toBe(true);
    expect(built.degraded).toBe(false);
  });

  it("distinguishes no beads at all from nothing ready", () => {
    const nodes = [node("gate"), node("waiter")];
    const model = deriveGraph(nodes, [blocks("waiter", "gate")], { complete: true });
    // `gate` is closed, so nothing is ready but the project is not empty.
    const closedGate = deriveGraph(
      [node("gate", { status: "in_progress" }), node("waiter")],
      [blocks("waiter", "gate")],
      { complete: true }
    );

    expect(buildReadyLane(model, nodes.map(bead)).noBeads).toBe(false);
    const built = buildReadyLane(closedGate, nodes.map(bead));
    expect(built.ready).toEqual([]);
    expect(built.noBeads).toBe(false);
  });

  it("flags a partial node set as degraded", () => {
    const nodes = [node("a")];

    expect(buildReadyLane(deriveGraph(nodes, [], { complete: false }), nodes.map(bead)).degraded).toBe(
      true
    );
  });
});

describe("mostBlocking", () => {
  it("names the bead whose closure unblocks the most", () => {
    // `hub` gates three; `minor` gates one. Nothing is ready, so the lane needs
    // a next action rather than an empty list.
    const nodes = [
      node("hub", { status: "in_progress" }),
      node("minor", { status: "in_progress" }),
      node("a"),
      node("b"),
      node("c"),
      node("d"),
    ];
    const edges = [
      blocks("a", "hub"),
      blocks("b", "hub"),
      blocks("c", "hub"),
      blocks("d", "minor"),
    ];

    const built = lane(nodes, edges);

    expect(built.ready).toEqual([]);
    expect(built.topBlocker?.id).toBe("hub");
    expect(built.topBlocker?.unblocks).toBe(3);
    expect(built.topBlocker?.bead?.id).toBe("hub");
  });

  it("counts leverage transitively, so a root cause beats a nearer blocker", () => {
    const nodes = [node("root", { status: "in_progress" }), node("mid"), node("leaf")];
    const edges = [blocks("mid", "root"), blocks("leaf", "mid")];

    expect(lane(nodes, edges).topBlocker?.id).toBe("root");
  });

  it("ignores a bead that only blocks already-closed work", () => {
    const nodes = [
      node("phantom", { status: "in_progress" }),
      node("shipped", { status: "closed" }),
      node("real", { status: "in_progress" }),
      node("waiting"),
    ];
    const edges = [blocks("shipped", "phantom"), blocks("waiting", "real")];

    expect(lane(nodes, edges).topBlocker?.id).toBe("real");
  });

  it("breaks a leverage tie on priority, then id", () => {
    const nodes = [
      node("zzz", { status: "in_progress", priority: 0 }),
      node("aaa", { status: "in_progress", priority: 3 }),
      node("mmm", { status: "in_progress", priority: 0 }),
      node("w1"),
      node("w2"),
      node("w3"),
    ];
    const edges = [blocks("w1", "zzz"), blocks("w2", "aaa"), blocks("w3", "mmm")];

    // All three gate exactly one bead; P0 wins, and `mmm` sorts before `zzz`.
    expect(lane(nodes, edges).topBlocker?.id).toBe("mmm");
  });

  it("returns null when nothing is blocked", () => {
    const nodes = [node("a"), node("b")];
    const model = deriveGraph(nodes, [], { complete: true });

    expect(lane(nodes).topBlocker).toBeNull();
    expect(mostBlocking(model, new Map(nodes.map((n) => [n.id, bead(n)])))).toBeNull();
  });

  it("still names a blocker that is missing from the payload", () => {
    // The degraded case: an edge points at a bead the CLI would not list. The
    // graph counts it as open, so the lane must be able to name it without a
    // bead record to hang a title on.
    const nodes = [node("waiter")];
    const model = deriveGraph(nodes, [blocks("waiter", "hidden-gate")], { complete: false });

    const built = buildReadyLane(model, nodes.map(bead));

    expect(built.topBlocker?.id).toBe("hidden-gate");
    expect(built.topBlocker?.bead).toBeUndefined();
    expect(built.degraded).toBe(true);
  });
});
