import { deriveGraph } from "../BeadsGraph";
import { countBlockingLinks, deriveSummary } from "../summary";
import type { GraphInputNode } from "../types";

const node = (id: string, over: Partial<GraphInputNode> = {}): GraphInputNode => ({
  id,
  status: "open",
  issue_type: "task",
  priority: 2,
  ...over,
});
const blocks = (from: string, to: string) => ({ from, to, type: "blocks" });
const BUILT_INS = ["open", "in_progress", "blocked", "deferred", "pinned", "hooked", "closed"];

describe("deriveSummary", () => {
  it("counts readiness from the graph, not from the open label", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const g = deriveGraph(nodes, [blocks("c", "a")]);

    const summary = deriveSummary(nodes, g, BUILT_INS);

    expect(summary.readyCount).toBe(2);
    expect(summary.blockedCount).toBe(1);
    // All three still wear the `open` label; only two are actually pickable.
    expect(summary.byStatus.open).toBe(3);
  });

  it("counts a bead labelled blocked as ready when nothing blocks it", () => {
    // Regression: blockedCount used to be a tally of the `blocked` status, so a
    // stale label counted as blockage and a real blocker did not.
    const nodes = [node("a", { status: "blocked" })];
    const g = deriveGraph(nodes, []);

    const summary = deriveSummary(nodes, g, BUILT_INS);

    expect(summary.blockedCount).toBe(0);
    expect(summary.byStatus.blocked).toBe(1);
  });

  it("seeds the built-in statuses so they report zero rather than undefined", () => {
    const summary = deriveSummary([], deriveGraph([], []), BUILT_INS);

    for (const status of BUILT_INS) {
      expect(summary.byStatus[status]).toBe(0);
    }
    expect(summary.total).toBe(0);
    expect(summary.readyCount).toBe(0);
  });

  it("still tallies custom statuses bd allows", () => {
    const nodes = [node("a", { status: "awaiting_review" })];

    const summary = deriveSummary(nodes, deriveGraph(nodes, []), BUILT_INS);

    expect(summary.byStatus.awaiting_review).toBe(1);
  });

  it("reports in progress from the status tally", () => {
    const nodes = [node("a", { status: "in_progress" }), node("b")];

    const summary = deriveSummary(nodes, deriveGraph(nodes, []), BUILT_INS);

    expect(summary.inProgressCount).toBe(1);
    expect(summary.readyCount).toBe(1);
  });

  it("marks the summary degraded when the node set was partial", () => {
    const nodes = [node("a")];

    expect(deriveSummary(nodes, deriveGraph(nodes, [], { complete: false })).degraded).toBe(true);
    expect(deriveSummary(nodes, deriveGraph(nodes, [], { complete: true })).degraded).toBe(false);
  });

  it("excludes coordination beads from readiness but counts them in totals", () => {
    const nodes = [node("gate", { issue_type: "gate" }), node("task")];

    const summary = deriveSummary(nodes, deriveGraph(nodes, []), BUILT_INS);

    expect(summary.readyCount).toBe(1);
    expect(summary.total).toBe(2);
  });

  it("tallies priorities and ignores out-of-range values", () => {
    const nodes = [node("a", { priority: 0 }), node("b", { priority: 2 }), node("c", { priority: 9 })];

    const summary = deriveSummary(nodes, deriveGraph(nodes, []), BUILT_INS);

    expect(summary.byPriority[0]).toBe(1);
    expect(summary.byPriority[2]).toBe(1);
    expect(summary.total).toBe(3);
  });
});

describe("countBlockingLinks", () => {
  it("counts an open blocker as live", () => {
    const g = deriveGraph([node("a"), node("b")], [blocks("b", "a")]);

    expect(countBlockingLinks(g)).toEqual({ live: 1, satisfied: 0 });
  });

  it("counts a closed blocker as satisfied rather than dropping it", () => {
    const g = deriveGraph([node("a", { status: "closed" }), node("b")], [blocks("b", "a")]);

    expect(countBlockingLinks(g)).toEqual({ live: 0, satisfied: 1 });
  });

  it("keeps the total steady as work closes", () => {
    // The header must not appear to lose links just because they were met.
    const edges = [blocks("b", "a"), blocks("c", "b")];
    const before = countBlockingLinks(deriveGraph([node("a"), node("b"), node("c")], edges));
    const after = countBlockingLinks(
      deriveGraph([node("a", { status: "closed" }), node("b"), node("c")], edges)
    );

    expect(before.live + before.satisfied).toBe(after.live + after.satisfied);
    expect(after).toEqual({ live: 1, satisfied: 1 });
  });

  it("reports zero for a graph with no blocking edges", () => {
    expect(countBlockingLinks(deriveGraph([node("a"), node("b")], []))).toEqual({
      live: 0,
      satisfied: 0,
    });
  });

  it("counts a duplicated pair once", () => {
    const g = deriveGraph([node("a"), node("b")], [blocks("b", "a"), blocks("b", "a")]);

    expect(countBlockingLinks(g)).toEqual({ live: 1, satisfied: 0 });
  });
});
