import { deriveGraph } from "../BeadsGraph";
import { deriveSummary } from "../summary";
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
