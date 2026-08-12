/**
 * The one rule under test: on graph surfaces, green is earned by being
 * unblocked, not granted by the raw `open` status.
 */

import { GRAPHIC_TOKENS, readinessHue, statusHue } from "../tokens";

describe("readinessHue", () => {
  it("keeps green for an open bead nothing blocks", () => {
    expect(readinessHue("open", false)).toBe(GRAPHIC_TOKENS.success);
  });

  it("moves an open-but-blocked bead off green - the bug that motivated this", () => {
    // An open bead with open blockers painted success green tells the user the
    // opposite of what the edges into it say.
    expect(readinessHue("open", true)).toBe(GRAPHIC_TOKENS.warning);
    expect(readinessHue("open", true)).not.toBe(readinessHue("open", false));
  });

  it("leaves every non-open status on its badge hue, blocked or not", () => {
    for (const status of ["in_progress", "blocked", "closed", "deferred", "pinned", "hooked"]) {
      expect(readinessHue(status, true)).toBe(statusHue(status));
      expect(readinessHue(status, false)).toBe(statusHue(status));
    }
  });

  it("falls back to neutral for a custom status, like the badge does", () => {
    expect(readinessHue("someday", true)).toBe(GRAPHIC_TOKENS.neutral);
  });
});
