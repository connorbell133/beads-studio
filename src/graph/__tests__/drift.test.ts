/**
 * Drift tests run against JSON captured verbatim from `bd diff --json` on
 * bd 1.2.1, not against a shape invented to match the parser.
 *
 * That matters more here than usual: the whole feature rests on a claim about
 * what bd does and does not report, and a fixture written from the type
 * definition would keep passing after bd changed its mind. Every literal in
 * ADDED / MODIFIED / REMOVED / DEP_ONLY below was copied out of a real run.
 */

import {
  buildDriftReport,
  classifyDrift,
  DRIFT_KINDS,
  DRIFT_LABELS,
  DRIFT_PRESETS,
  mergeCommits,
  parseDiffEntries,
  resolveDriftRef,
  summarizeDrift,
  type RawDiffEntry,
} from "../drift";

/** A bead filed since the comparison point. `OldValue` really is null. */
const ADDED: RawDiffEntry = {
  IssueID: "probe-5e0",
  DiffType: "added",
  OldValue: null,
  NewValue: {
    id: "probe-5e0",
    title: "Gamma task",
    status: "open",
    priority: 0,
    created_at: "0001-01-01T00:00:00Z",
    updated_at: "0001-01-01T00:00:00Z",
  } as RawDiffEntry["NewValue"],
};

/** A bead closed since the comparison point. */
const CLOSED: RawDiffEntry = {
  IssueID: "probe-ed4",
  DiffType: "modified",
  OldValue: { id: "probe-ed4", title: "Alpha task", status: "open", priority: 1 },
  NewValue: { id: "probe-ed4", title: "Alpha task", status: "closed", priority: 1 },
};

/** Retitled and promoted in one go. */
const RETITLED_AND_PROMOTED: RawDiffEntry = {
  IssueID: "probe-ack",
  DiffType: "modified",
  OldValue: { id: "probe-ack", title: "Beta task", status: "open", priority: 2 },
  NewValue: { id: "probe-ack", title: "Beta task, rescoped", status: "open", priority: 0 },
};

const REMOVED: RawDiffEntry = {
  IssueID: "probe-gone",
  DiffType: "removed",
  OldValue: { id: "probe-gone", title: "Gamma task", status: "open", priority: 0 },
  NewValue: null,
};

/**
 * A dependency rewire, exactly as bd reports it: a `modified` row whose every
 * printed field is identical on both sides. This is the whole evidence base for
 * the `touched` kind - bd knows something changed and does not say what.
 */
const DEP_ONLY: RawDiffEntry = {
  IssueID: "probe-5e0",
  DiffType: "modified",
  OldValue: { id: "probe-5e0", title: "Gamma task", status: "open", priority: 0 },
  NewValue: { id: "probe-5e0", title: "Gamma task", status: "open", priority: 0 },
};

describe("reading bd diff --json", () => {
  it("takes the array bd prints on success", () => {
    expect(parseDiffEntries([ADDED, CLOSED])).toHaveLength(2);
  });

  it("raises bd's own message rather than silently reporting no drift", () => {
    // bd prints this object, not an array, when a ref does not resolve - and a
    // parser that returned [] here would render "nothing changed" over a failed
    // read, which is the one lie this feature cannot afford.
    expect(() =>
      parseDiffEntries({ error: "failed to get diff: invalid ref format: HEAD~5", schema_version: 1 })
    ).toThrow(/invalid ref format/);
  });

  it("treats anything else as an empty diff", () => {
    expect(parseDiffEntries(null)).toEqual([]);
    expect(parseDiffEntries("nope")).toEqual([]);
    expect(parseDiffEntries({ schema_version: 1 })).toEqual([]);
  });

  it("drops rows with no usable id instead of inventing a node key", () => {
    expect(classifyDrift({ DiffType: "modified" })).toBeNull();
  });
});

describe("classifying one changed bead", () => {
  it("reads an added bead", () => {
    expect(classifyDrift(ADDED)).toEqual({ id: "probe-5e0", kind: "added" });
  });

  it("reads a removed bead", () => {
    expect(classifyDrift(REMOVED)).toEqual({ id: "probe-gone", kind: "removed" });
  });

  it("reads a closure", () => {
    expect(classifyDrift(CLOSED)).toEqual({ id: "probe-ed4", kind: "closed" });
  });

  it("reads a reopen, and names the statuses either side", () => {
    const drift = classifyDrift({
      IssueID: "b",
      DiffType: "modified",
      OldValue: { status: "closed", title: "t" },
      NewValue: { status: "open", title: "t" },
    });
    expect(drift?.kind).toBe("reopened");
    expect(drift?.detail).toBe("closed → open");
  });

  it("calls a retitle a rescope, ahead of the priority move in the same row", () => {
    // Both changed. Rescoping is the drift nobody spots by eye, so it wins.
    const drift = classifyDrift(RETITLED_AND_PROMOTED);
    expect(drift?.kind).toBe("rescoped");
    expect(drift?.detail).toContain("Beta task");
  });

  it("reads a priority move, and which way it went", () => {
    const raised = classifyDrift({
      IssueID: "b",
      DiffType: "modified",
      OldValue: { title: "t", status: "open", priority: 3 },
      NewValue: { title: "t", status: "open", priority: 1 },
    });
    // P0 is critical in bd, so a smaller number is a promotion.
    expect(raised).toEqual({
      id: "b",
      kind: "reprioritized",
      detail: "P3 → P1 (raised)",
    });

    const lowered = classifyDrift({
      IssueID: "b",
      DiffType: "modified",
      OldValue: { title: "t", status: "open", priority: 1 },
      NewValue: { title: "t", status: "open", priority: 3 },
    });
    expect(lowered?.detail).toBe("P1 → P3 (lowered)");
  });

  it("calls a change with no reported field 'touched' - the dependency-rewire case", () => {
    expect(classifyDrift(DEP_ONLY)).toEqual({ id: "probe-5e0", kind: "touched" });
  });

  it("does not read reflowed whitespace as a rescope", () => {
    const drift = classifyDrift({
      IssueID: "b",
      DiffType: "modified",
      OldValue: { title: "One  two", description: "a\nb", status: "open", priority: 2 },
      NewValue: { title: "One two", description: "a b", status: "open", priority: 2 },
    });
    expect(drift?.kind).toBe("touched");
  });

  it("infers add and remove from a missing side when bd omits the marker", () => {
    expect(classifyDrift({ IssueID: "b", NewValue: { id: "b" } })?.kind).toBe("added");
    expect(classifyDrift({ IssueID: "b", OldValue: { id: "b" } })?.kind).toBe("removed");
  });

  it("reads an unusual status transition as touched, with the transition spelled out", () => {
    const drift = classifyDrift({
      IssueID: "b",
      DiffType: "modified",
      OldValue: { title: "t", status: "open", priority: 2 },
      NewValue: { title: "t", status: "in_progress", priority: 2 },
    });
    expect(drift).toEqual({ id: "b", kind: "touched", detail: "open → in_progress" });
  });
});

describe("the whole comparison", () => {
  const report = buildDriftReport([RETITLED_AND_PROMOTED, ADDED, CLOSED, REMOVED], {
    fromRef: "r899qi0oij1pe78khid56gb9av8k4v2c",
    fromLabel: "Since yesterday",
    fromAt: "2026-08-14T10:11:58.271-07:00",
  });

  it("annotates only beads the current graph still holds", () => {
    expect(Object.keys(report.kinds).sort()).toEqual(["probe-5e0", "probe-ack", "probe-ed4"]);
    // The deleted bead has no node to hang an annotation on, so it is reported
    // as text and never as a key the lens could try to draw.
    expect(report.kinds["probe-gone"]).toBeUndefined();
    expect(report.removed.map((bead) => bead.id)).toEqual(["probe-gone"]);
  });

  it("counts each kind", () => {
    expect(report.counts).toEqual({ added: 1, closed: 1, rescoped: 1, removed: 1 });
  });

  it("is id-ordered, so the same diff always reads the same way", () => {
    expect(report.beads.map((bead) => bead.id)).toEqual([
      "probe-5e0",
      "probe-ack",
      "probe-ed4",
      "probe-gone",
    ]);
  });

  it("keeps the first classification when bd repeats an id", () => {
    const doubled = buildDriftReport([CLOSED, { ...CLOSED, DiffType: "added" }], {
      fromRef: "x",
      fromLabel: "Since yesterday",
    });
    expect(doubled.beads).toHaveLength(1);
    expect(doubled.beads[0].kind).toBe("closed");
  });

  it("carries the resolved commit and its moment, not the phrase alone", () => {
    expect(report.fromRef).toBe("r899qi0oij1pe78khid56gb9av8k4v2c");
    expect(report.fromAt).toBe("2026-08-14T10:11:58.271-07:00");
  });

  it("summarizes in one line, and says so when nothing moved", () => {
    expect(summarizeDrift(report)).toBe("1 new · 1 deleted · 1 closed · 1 rescoped");
    expect(
      summarizeDrift(buildDriftReport([], { fromRef: "x", fromLabel: "Since yesterday" }))
    ).toBe("No changes since then");
  });
});

describe("picking a comparison point without knowing a commit hash", () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.parse("2026-08-14T12:00:00Z");
  const commits = [
    { hash: "newest", at: "2026-08-14T11:00:00Z" },
    { hash: "overnight", at: "2026-08-14T02:00:00Z" },
    { hash: "monday", at: "2026-08-10T09:00:00Z" },
  ];

  it("takes the newest commit at or before the cutoff", () => {
    expect(resolveDriftRef(commits, now - 24 * HOUR)).toEqual({
      hash: "monday",
      at: "2026-08-10T09:00:00Z",
      clamped: false,
    });
  });

  it("prefers a later commit when the window is short", () => {
    expect(resolveDriftRef(commits, now - 2 * HOUR)?.hash).toBe("overnight");
  });

  it("clamps to the oldest commit rather than refusing, and says it clamped", () => {
    // Nothing goes back a year. Comparing against the oldest commit known is
    // more useful than an error, provided the caller can tell the user that is
    // what happened - which `clamped` is for.
    const resolved = resolveDriftRef(commits, now - 24 * 365 * HOUR);
    expect(resolved).toEqual({ hash: "monday", at: "2026-08-10T09:00:00Z", clamped: true });
  });

  it("has nothing to offer on a project with no history", () => {
    expect(resolveDriftRef([], now)).toBeNull();
  });

  it("ignores commits with an unparseable timestamp", () => {
    expect(resolveDriftRef([{ hash: "junk", at: "not a date" }], now)).toBeNull();
  });

  it("resolves every preset against a real history", () => {
    for (const preset of DRIFT_PRESETS) {
      expect(resolveDriftRef(commits, now - preset.hours * HOUR)).not.toBeNull();
    }
  });
});

describe("assembling a commit listing from per-bead histories", () => {
  it("deduplicates the commits two beads share and sorts newest first", () => {
    const merged = mergeCommits([
      [
        { hash: "b", at: "2026-08-14T02:00:00Z" },
        { hash: "a", at: "2026-08-10T09:00:00Z" },
      ],
      [
        { hash: "c", at: "2026-08-14T11:00:00Z" },
        { hash: "b", at: "2026-08-14T02:00:00Z" },
      ],
    ]);
    expect(merged.map((commit) => commit.hash)).toEqual(["c", "b", "a"]);
  });

  it("survives a bead whose history came back empty", () => {
    expect(mergeCommits([[], [{ hash: "a", at: "2026-08-10T09:00:00Z" }]])).toHaveLength(1);
  });
});

describe("the drift vocabulary", () => {
  it("labels every kind, short enough to sit inside a node", () => {
    for (const kind of DRIFT_KINDS) {
      expect(DRIFT_LABELS[kind]).toBeTruthy();
      // The node is 208px wide and the badge shares its line with the title;
      // see DRIFT_BADGE_WIDTH in GraphCanvas.
      expect(DRIFT_LABELS[kind].length).toBeLessThanOrEqual(9);
    }
  });
});
