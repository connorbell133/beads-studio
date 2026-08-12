import { nextIndexForKey } from "../useRovingFocus";

/**
 * The navigation logic is pure so it can be tested without a DOM - jest runs
 * this project in a node environment and matches only .test.ts.
 */

const press = (key: string, current: number, count: number, labels?: string[]) =>
  nextIndexForKey(key, current, count, labels);

describe("nextIndexForKey", () => {
  it("moves down and up through the collection", () => {
    expect(press("ArrowDown", 0, 5)).toBe(1);
    expect(press("ArrowUp", 3, 5)).toBe(2);
  });

  it("wraps at both ends", () => {
    // Reaching the end of a long backlog should not require holding a key.
    expect(press("ArrowDown", 4, 5)).toBe(0);
    expect(press("ArrowUp", 0, 5)).toBe(4);
  });

  it("jumps to the first and last items", () => {
    expect(press("Home", 3, 5)).toBe(0);
    expect(press("End", 1, 5)).toBe(4);
  });

  it("leaves focus alone for a key it does not handle", () => {
    expect(press("Enter", 2, 5)).toBeNull();
    expect(press("Escape", 2, 5)).toBeNull();
    expect(press("Tab", 2, 5)).toBeNull();
  });

  it("does nothing in an empty collection", () => {
    expect(press("ArrowDown", 0, 0)).toBeNull();
    expect(press("Home", 0, 0)).toBeNull();
  });

  it("stays put in a single-item collection", () => {
    expect(press("ArrowDown", 0, 1)).toBe(0);
    expect(press("ArrowUp", 0, 1)).toBe(0);
  });

  describe("typeahead", () => {
    const labels = ["alpha", "beta", "gamma", "beacon"];

    it("jumps to the next label starting with the typed character", () => {
      expect(press("b", 0, 4, labels)).toBe(1);
    });

    it("cycles between labels sharing a prefix", () => {
      expect(press("b", 1, 4, labels)).toBe(3);
      expect(press("b", 3, 4, labels)).toBe(1);
    });

    it("is case insensitive", () => {
      expect(press("G", 0, 4, labels)).toBe(2);
    });

    it("returns null when nothing matches", () => {
      expect(press("z", 0, 4, labels)).toBeNull();
    });

    it("ignores typeahead when no labels are supplied", () => {
      expect(press("b", 0, 4)).toBeNull();
    });

    it("does not treat a space as a typeahead character", () => {
      // Space activates the focused row; hijacking it for search would break
      // the primary action.
      expect(press(" ", 0, 4, labels)).toBeNull();
    });

    it("ignores multi-character keys that are not navigation", () => {
      expect(press("Shift", 0, 4, labels)).toBeNull();
      expect(press("PageDown", 0, 4, labels)).toBeNull();
    });
  });
});
