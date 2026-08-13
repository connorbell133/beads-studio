import { restoreFilterState } from "../filter-state";

/**
 * Restoring filters is what keeps a hand-picked filter alive across Refresh:
 * a manual refresh empties the bead list, the panel falls back to <Loading />,
 * and the Issues view unmounts (vsbeads-fvl). The rule is pure so it can be
 * tested without a DOM - jest runs this project in a node environment.
 */

const DEFAULTS = {
  columnFilters: [{ id: "status", value: ["open", "in_progress"] }],
  activePreset: "not-closed",
};

describe("restoreFilterState", () => {
  it("falls back to the defaults on a first run with nothing stored", () => {
    expect(restoreFilterState(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("keeps a hand-picked label filter instead of resetting to the preset", () => {
    const stored = {
      columnFilters: [{ id: "labels", value: ["ui-ux-cleanup"] }],
      activePreset: "",
    };

    expect(restoreFilterState(stored, DEFAULTS)).toEqual(stored);
  });

  it("restores the preset caption alongside the filters it produced", () => {
    const stored = {
      columnFilters: [{ id: "status", value: ["closed"] }],
      activePreset: "closed",
    };

    expect(restoreFilterState(stored, DEFAULTS).activePreset).toBe("closed");
  });

  it("treats stored filters with no preset as hand-picked, not as the default preset", () => {
    // The empty caption is meaningful: it drives the "Custom" label and opens
    // the chip row. Falling back to the default preset here would show
    // "Not Closed" above filters that are not the preset's.
    const restored = restoreFilterState(
      { columnFilters: [{ id: "priority", value: [0] }] },
      DEFAULTS
    );

    expect(restored.activePreset).toBe("");
    expect(restored.columnFilters).toEqual([{ id: "priority", value: [0] }]);
  });

  it("honours a stored empty filter set rather than re-applying defaults", () => {
    // "Clear all" writes []. Treating that as absent would make the cleared
    // state impossible to keep across a refresh.
    expect(restoreFilterState({ columnFilters: [], activePreset: "" }, DEFAULTS)).toEqual({
      columnFilters: [],
      activePreset: "",
    });
  });
});
