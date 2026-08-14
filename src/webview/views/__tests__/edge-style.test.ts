/**
 * The canvas has no render test, so the branchiest decision it makes - how a
 * single line is drawn - is pinned here instead.
 */

import { GRAPHIC_TOKENS } from "../../theme/tokens";
import { edgeStyle } from "../edge-style";

describe("edgeStyle", () => {
  it("draws a live blocker solid, with the standard head", () => {
    const style = edgeStyle({ kind: "blocks", satisfied: false });

    expect(style.strokeDasharray).toBeUndefined();
    expect(style.marker).toBe("arrow");
    expect(style.stroke).toBe(GRAPHIC_TOKENS.neutral);
    expect(style.className).not.toContain("satisfied");
  });

  it("recedes a satisfied blocker without turning it into another category", () => {
    const style = edgeStyle({ kind: "blocks", satisfied: true });

    expect(style.className).toContain("satisfied");
    expect(style.marker).toBe("arrow-satisfied");
    // Same hue as a live edge: the difference is tense, not kind.
    expect(style.stroke).toBe(GRAPHIC_TOKENS.neutral);
  });

  it("keeps all four dash patterns tellable apart", () => {
    const live = edgeStyle({ kind: "blocks" }).strokeDasharray;
    const satisfied = edgeStyle({ kind: "blocks", satisfied: true }).strokeDasharray;
    const cycle = edgeStyle({ kind: "blocks", cycle: true }).strokeDasharray;
    const contains = edgeStyle({ kind: "contains" }).strokeDasharray;

    expect(new Set([live, satisfied, cycle, contains]).size).toBe(4);
  });

  it("lets a cycle outrank satisfaction, so bad data is never hidden", () => {
    const style = edgeStyle({ kind: "blocks", satisfied: true, cycle: true });

    expect(style.className).toContain("in-cycle");
    expect(style.className).not.toContain("satisfied");
    expect(style.marker).toBe("arrow-cycle");
    expect(style.stroke).toBe(GRAPHIC_TOKENS.warning);
  });

  it("never satisfies or tangles a containment tether", () => {
    const style = edgeStyle({ kind: "contains", satisfied: true, cycle: true });

    expect(style.className).toContain("contains");
    expect(style.className).not.toContain("satisfied");
    expect(style.className).not.toContain("in-cycle");
    expect(style.marker).toBeNull();
  });

  it("carries dimming alongside whatever else the edge is", () => {
    const style = edgeStyle({ kind: "blocks", satisfied: true, dimmed: true });

    expect(style.className).toContain("satisfied");
    expect(style.className).toContain("dimmed");
  });

  it("falls back to a plain arrow when no lens edge matched the path", () => {
    const style = edgeStyle({});

    expect(style.marker).toBe("arrow");
    expect(style.className).toBe("graph-canvas-edge");
  });
});
