import { BeadsSelection, SelectionChange } from "../BeadsSelection";

describe("BeadsSelection", () => {
  function collect() {
    const selection = new BeadsSelection();
    const changes: SelectionChange[] = [];
    selection.onDidChange((change) => changes.push(change));
    return { selection, changes };
  }

  it("starts with nothing selected", () => {
    expect(new BeadsSelection().selected).toBeNull();
  });

  it("broadcasts a change once, carrying its origin", () => {
    const { selection, changes } = collect();

    selection.select("bd-1", "beadsPanel");

    expect(selection.selected).toBe("bd-1");
    expect(changes).toEqual([{ beadId: "bd-1", origin: "beadsPanel" }]);
  });

  it("does not re-broadcast the same bead", () => {
    // A refresh loop that re-announced the current selection would bounce every
    // surface back to the same row on every poll.
    const { selection, changes } = collect();

    selection.select("bd-1", "beadsPanel");
    selection.select("bd-1", "beadsGraph");

    expect(changes).toHaveLength(1);
  });

  it("broadcasts when the selection actually moves", () => {
    const { selection, changes } = collect();

    selection.select("bd-1", "beadsPanel");
    selection.select("bd-2", "beadsGraph");

    expect(changes.map((c) => c.beadId)).toEqual(["bd-1", "bd-2"]);
    expect(changes[1].origin).toBe("beadsGraph");
  });

  it("clears selection and says who cleared it", () => {
    const { selection, changes } = collect();
    selection.select("bd-1", "beadsPanel");

    selection.clear("projectChange");

    expect(selection.selected).toBeNull();
    expect(changes[1]).toEqual({ beadId: null, origin: "projectChange" });
  });

  it("does not broadcast a clear when nothing was selected", () => {
    const { selection, changes } = collect();

    selection.clear("projectChange");

    expect(changes).toEqual([]);
  });

  it("supports several listeners, which is the point of a shared selection", () => {
    const selection = new BeadsSelection();
    const seen: string[] = [];
    selection.onDidChange(() => seen.push("dashboard"));
    selection.onDidChange(() => seen.push("panel"));
    selection.onDidChange(() => seen.push("graph"));

    selection.select("bd-1", "details");

    expect(seen).toEqual(["dashboard", "panel", "graph"]);
  });

  it("stops notifying after disposal", () => {
    const { selection, changes } = collect();

    selection.dispose();
    selection.select("bd-1", "beadsPanel");

    expect(changes).toEqual([]);
  });
});
