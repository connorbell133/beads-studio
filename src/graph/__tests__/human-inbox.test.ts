import { deriveGraph } from "../BeadsGraph";
import {
  buildHumanInbox,
  hasHumanLabel,
  isHumanGate,
  partitionBlockers,
  stallCost,
  waitStartedAt,
  waitingOnHuman,
  type InboxBead,
} from "../human-inbox";
import type { GraphInputEdge, GraphInputNode } from "../types";

const NOW = Date.parse("2026-08-14T12:00:00Z");
const HOUR = 3_600_000;

const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

/** A bead in both shapes the modules need: graph input and inbox input. */
interface TestBead extends InboxBead {
  id: string;
  status: string;
  issue_type?: string;
}

const bead = (id: string, over: Partial<TestBead> = {}): TestBead => ({
  id,
  status: "open",
  type: "task",
  issue_type: "task",
  priority: 2,
  createdAt: at(HOUR),
  ...over,
});

/** A bead awaiting a person via bd's `human` label. */
const question = (id: string, over: Partial<TestBead> = {}): TestBead =>
  bead(id, { labels: ["human"], ...over });

/** A bd gate bead. Await type defaults to the human one bd itself defaults to. */
const gate = (id: string, over: Partial<TestBead> = {}): TestBead =>
  bead(id, { type: "gate", issue_type: "gate", awaitType: "human", ...over });

const blocks = (from: string, to: string): GraphInputEdge => ({ from, to, type: "blocks" });

const graphOf = (beads: TestBead[], edges: GraphInputEdge[] = []) =>
  deriveGraph(
    beads.map((b): GraphInputNode => ({
      id: b.id,
      status: b.status,
      issue_type: b.issue_type,
      priority: b.priority,
      created_at: b.createdAt,
    })),
    edges,
    { complete: true }
  );

const inbox = (
  beads: TestBead[],
  edges: GraphInputEdge[] = [],
  humanIds?: readonly string[]
) => buildHumanInbox(graphOf(beads, edges), beads, { now: NOW, humanIds });

const ids = (rows: Array<{ bead: { id: string } }>): string[] => rows.map((r) => r.bead.id);

describe("membership", () => {
  it("takes beads carrying bd's human label", () => {
    expect(ids(inbox([question("q1"), bead("work")]).rows)).toEqual(["q1"]);
  });

  it("matches the label case-insensitively and ignores surrounding space", () => {
    expect(hasHumanLabel(bead("x", { labels: [" Human "] }))).toBe(true);
    expect(hasHumanLabel(bead("x", { labels: ["humanoid"] }))).toBe(false);
  });

  it("takes open gates awaiting a manual resolve", () => {
    expect(ids(inbox([gate("g1"), bead("work")]).rows)).toEqual(["g1"]);
  });

  it("leaves out gates that resolve themselves", () => {
    // A timer gate, a PR gate and a workflow gate all clear without anyone
    // doing anything. Asking a person to action them is asking for nothing.
    for (const awaitType of ["timer", "gh:pr", "gh:run", "bead"]) {
      expect(isHumanGate(gate("g", { awaitType }))).toBe(false);
      expect(inbox([gate("g", { awaitType })]).rows).toHaveLength(0);
    }
  });

  it("treats a gate with no known await type as needing a person", () => {
    // bd's own `bd gate create` defaults to --type=human, and backends whose
    // schema predates the column report nothing. Dropping those would hide real
    // gates; including them at worst shows a self-clearing one.
    expect(isHumanGate(gate("g", { awaitType: undefined }))).toBe(true);
  });

  it("excludes closed beads however they spell closed", () => {
    for (const status of ["closed", "done", "completed"]) {
      expect(inbox([question("q", { status })]).rows).toHaveLength(0);
      expect(inbox([gate("g", { status })]).rows).toHaveLength(0);
    }
  });

  it("prefers bd's own human list over the label when it is available", () => {
    // bd owns the definition. If it says a bead needs a person, the extension
    // does not argue on the grounds that the label is missing - and vice versa.
    const beads = [bead("blessed"), question("labelled")];

    const model = inbox(beads, [], ["blessed"]);

    expect(ids(model.rows)).toEqual(["blessed"]);
    expect(model.degraded).toBe(false);
  });

  it("falls back to the label and says so when bd cannot be asked", () => {
    const model = inbox([question("q")], [], undefined);

    expect(ids(model.rows)).toEqual(["q"]);
    expect(model.degraded).toBe(true);
  });

  it("keeps gates regardless of what bd's human list says", () => {
    // Gates are not labelled `human`, so `bd human list` never returns them.
    // An authoritative list of labelled beads must not subtract them.
    expect(ids(inbox([gate("g")], [], []).rows)).toEqual(["g"]);
  });
});

describe("stall cost", () => {
  it("multiplies frozen work by hours waited", () => {
    expect(stallCost(3, 2 * HOUR)).toBeCloseTo(8); // (3 + 1) x 2
  });

  it("still charges for a question that blocks nothing", () => {
    // Otherwise every leverage-zero row scores exactly 0 and the tail of the
    // queue ties, which puts them in id order - a worse answer than age.
    expect(stallCost(0, 5 * HOUR)).toBeCloseTo(5);
    expect(stallCost(0, 1 * HOUR)).toBeLessThan(stallCost(0, 5 * HOUR));
  });

  it("never goes negative on a clock that ran backwards", () => {
    expect(stallCost(2, -HOUR)).toBe(0);
  });
});

describe("ordering", () => {
  it("ranks by cost, not by age", () => {
    // The whole premise. `old` has waited five times longer, `heavy` dams six
    // beads. FIFO answers `old`; this answers `heavy`.
    const downstream = Array.from({ length: 6 }, (_, i) => bead(`d${i}`));
    const beads = [
      question("old", { createdAt: at(50 * HOUR) }),
      question("heavy", { createdAt: at(10 * HOUR) }),
      ...downstream,
    ];
    const edges = downstream.map((d) => blocks(d.id, "heavy"));

    expect(ids(inbox(beads, edges).rows)).toEqual(["heavy", "old"]);
  });

  it("still ranks by age between decisions damming the same amount", () => {
    const beads = [question("newer", { createdAt: at(2 * HOUR) }), question("older", { createdAt: at(9 * HOUR) })];

    expect(ids(inbox(beads).rows)).toEqual(["older", "newer"]);
  });

  it("breaks an exact tie by priority, then by id, so the order is stable", () => {
    const beads = [
      question("b-low", { createdAt: at(HOUR), priority: 3 }),
      question("a-high", { createdAt: at(HOUR), priority: 0 }),
      question("c-low", { createdAt: at(HOUR), priority: 3 }),
    ];

    expect(ids(inbox(beads).rows)).toEqual(["a-high", "b-low", "c-low"]);
  });

  it("puts a cheap-but-old question below an expensive young one", () => {
    // 1 frozen x 30h = 62 against 20 frozen x 2h = 42... the point being that
    // the trade is explicit and computed, not decided by arrival order.
    const many = Array.from({ length: 20 }, (_, i) => bead(`m${i}`));
    const beads = [
      question("young-heavy", { createdAt: at(2 * HOUR) }),
      question("old-light", { createdAt: at(30 * HOUR) }),
      ...many,
    ];
    const edges = many.map((m) => blocks(m.id, "young-heavy"));

    const rows = inbox(beads, edges).rows;
    expect(rows[0].bead.id).toBe("young-heavy");
    expect(rows[0].stallCost).toBeGreaterThan(rows[1].stallCost);
  });
});

describe("frozen work", () => {
  it("counts what a decision dams, transitively", () => {
    const beads = [question("q"), bead("a"), bead("b"), bead("c")];
    const edges = [blocks("a", "q"), blocks("b", "a"), blocks("c", "b")];

    const row = inbox(beads, edges).rows[0];

    expect(row.frozen).toBe(3);
    expect(row.frozenIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("agrees with the graph's own leverage score", () => {
    // The two are the same walk over the same edges. If they ever disagree the
    // surface is ranking on a number it does not display.
    const beads = [question("q"), bead("a"), bead("b"), bead("shared"), bead("closed-one", { status: "closed" })];
    const edges = [
      blocks("a", "q"),
      blocks("b", "q"),
      blocks("shared", "a"),
      blocks("shared", "b"),
      blocks("closed-one", "q"),
    ];
    const model = graphOf(beads, edges);

    const row = buildHumanInbox(model, beads, { now: NOW }).rows[0];

    expect(row.frozen).toBe(model.nodes["q"].leverage);
    expect(row.frozenIds).not.toContain("closed-one");
  });

  it("counts beads dammed by two decisions once", () => {
    const beads = [question("q1"), question("q2"), bead("shared")];
    const edges = [blocks("shared", "q1"), blocks("shared", "q2")];

    expect(inbox(beads, edges).totalFrozen).toBe(1);
  });

  it("survives a dependency cycle behind a decision", () => {
    const beads = [question("q"), bead("a"), bead("b")];
    const edges = [blocks("a", "q"), blocks("b", "a"), blocks("a", "b")];

    expect(inbox(beads, edges).rows[0].frozen).toBe(2);
  });
});

describe("when the wait started", () => {
  it("uses creation, because that is when the question was asked", () => {
    // Not `updatedAt`: any touch would reset it, and an unanswered question
    // that someone re-prioritised would look brand new.
    const b = bead("q", { createdAt: at(8 * HOUR), updatedAt: at(HOUR) });

    expect(waitStartedAt(b, NOW)).toBe(NOW - 8 * HOUR);
    expect(inbox([question("q", { createdAt: at(8 * HOUR), updatedAt: at(HOUR) })]).rows[0].waitedMs).toBe(8 * HOUR);
  });

  it("falls back to the last update, then to now", () => {
    expect(waitStartedAt(bead("q", { createdAt: undefined, updatedAt: at(3 * HOUR) }), NOW)).toBe(NOW - 3 * HOUR);
    expect(waitStartedAt(bead("q", { createdAt: undefined, updatedAt: undefined }), NOW)).toBe(NOW);
  });

  it("ignores an unparseable timestamp rather than ranking on NaN", () => {
    expect(waitStartedAt(bead("q", { createdAt: "not a date", updatedAt: at(HOUR) }), NOW)).toBe(NOW - HOUR);
  });
});

describe("blocked on a person vs blocked on work", () => {
  it("splits a bead's blockers by who can clear them", () => {
    const beads = [gate("g"), question("q"), bead("w"), bead("blocked")];
    const waiting = waitingOnHuman(beads);

    expect(partitionBlockers(["g", "q", "w"], waiting)).toEqual({
      people: ["g", "q"],
      work: ["w"],
    });
  });

  it("calls an unknown blocker work, because nobody can be sent to clear it", () => {
    expect(partitionBlockers(["ghost"], new Set<string>())).toEqual({
      people: [],
      work: ["ghost"],
    });
  });

  it("stops calling a bead a person's problem once it closes", () => {
    expect(waitingOnHuman([question("q", { status: "closed" })]).has("q")).toBe(false);
  });

  it("does not count a self-clearing gate as a person's problem", () => {
    expect(waitingOnHuman([gate("t", { awaitType: "timer" })]).has("t")).toBe(false);
  });
});

describe("degenerate inputs", () => {
  it("returns an empty inbox with no graph rather than throwing", () => {
    const model = buildHumanInbox(null, [question("q")], { now: NOW });

    expect(ids(model.rows)).toEqual(["q"]);
    expect(model.rows[0].frozen).toBe(0);
  });

  it("returns an empty inbox for an empty project", () => {
    expect(inbox([])).toEqual({ rows: [], totalFrozen: 0, degraded: true });
  });
});
