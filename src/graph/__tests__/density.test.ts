/**
 * The auto-collapse threshold. The rules under test are that the collapse is
 * never silent (it always carries a reason), and that the override always wins.
 */

import {
  DENSITY_COLLAPSE_LENS,
  DENSITY_NODE_LIMIT,
  resolveDensity,
} from "../density";

describe("resolveDensity", () => {
  it("returns the requested lens below the threshold", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: DENSITY_NODE_LIMIT - 1 });

    expect(decision.lens).toBe("full");
    expect(decision.dense).toBe(false);
    expect(decision.autoCollapsed).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  it("returns the requested lens exactly at the threshold", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: DENSITY_NODE_LIMIT });

    expect(decision.lens).toBe("full");
    expect(decision.dense).toBe(false);
    expect(decision.autoCollapsed).toBe(false);
  });

  it("collapses to the rollup above the threshold, with a reason", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: DENSITY_NODE_LIMIT + 1 });

    expect(decision.lens).toBe(DENSITY_COLLAPSE_LENS);
    expect(decision.lens).toBe("epic-rollup");
    expect(decision.dense).toBe(true);
    expect(decision.autoCollapsed).toBe(true);
    expect(decision.reason).toBe("node-count");
    expect(decision.requested).toBe("full");
  });

  it("collapses the blast radius too when it comes back huge", () => {
    const decision = resolveDensity({ requested: "blast-radius", nodeCount: 500 });

    expect(decision.lens).toBe("epic-rollup");
    expect(decision.autoCollapsed).toBe(true);
  });

  it("lets the override defeat the threshold", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: 500, override: true });

    expect(decision.lens).toBe("full");
    expect(decision.autoCollapsed).toBe(false);
    expect(decision.overridden).toBe(true);
    expect(decision.dense).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("does not claim an override when there was nothing to override", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: 10, override: true });

    expect(decision.overridden).toBe(false);
    expect(decision.lens).toBe("full");
  });

  it("has nothing to collapse to when the rollup itself is over the limit", () => {
    const decision = resolveDensity({ requested: "epic-rollup", nodeCount: 480 });

    expect(decision.lens).toBe("epic-rollup");
    expect(decision.dense).toBe(true);
    expect(decision.autoCollapsed).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  it("honours a caller-supplied limit", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: 11, limit: 10 });

    expect(decision.limit).toBe(10);
    expect(decision.autoCollapsed).toBe(true);
  });

  it("reports the count it decided on, so the notice can name it", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: 512 });

    expect(decision.nodeCount).toBe(512);
    expect(decision.limit).toBe(DENSITY_NODE_LIMIT);
  });

  it("draws an empty graph without complaint", () => {
    const decision = resolveDensity({ requested: "full", nodeCount: 0 });

    expect(decision.lens).toBe("full");
    expect(decision.dense).toBe(false);
  });
});
