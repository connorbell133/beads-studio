import {
  BecameReadyEvent,
  computePulse,
  diffReady,
  pruneEvents,
  PULSE_WINDOW_MS,
  STALE_CLAIM_MS,
} from "../pulse";

const NOW = Date.parse("2026-08-12T12:00:00Z");
const minsAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

interface TestBead {
  id: string;
  status: string;
  assignee?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
}

const bead = (partial: Partial<TestBead> & { id: string }): TestBead => ({
  status: "open",
  ...partial,
});

describe("computePulse", () => {
  it("counts closes and files inside the window, newest first", () => {
    const pulse = computePulse(
      [
        bead({ id: "a", status: "closed", closedAt: minsAgo(50) }),
        bead({ id: "b", status: "closed", closedAt: minsAgo(10) }),
        bead({ id: "old", status: "closed", closedAt: minsAgo(90) }),
        bead({ id: "new1", createdAt: minsAgo(30) }),
        bead({ id: "ancient", createdAt: minsAgo(600) }),
      ],
      [],
      { now: NOW }
    );

    expect(pulse.closed.map((b) => b.id)).toEqual(["b", "a"]);
    expect(pulse.filed.map((b) => b.id)).toEqual(["new1"]);
    expect(pulse.quiet).toBe(false);
  });

  it("ignores missing or malformed timestamps rather than guessing", () => {
    const pulse = computePulse(
      [
        bead({ id: "a", status: "closed" }),
        bead({ id: "b", status: "closed", closedAt: "not a date" }),
      ],
      [],
      { now: NOW }
    );
    expect(pulse.closed).toEqual([]);
    expect(pulse.quiet).toBe(true);
  });

  it("keeps newly-ready only while the bead is still open", () => {
    const events: BecameReadyEvent[] = [
      { id: "stillOpen", at: NOW - 10 * 60_000 },
      { id: "sinceClaimed", at: NOW - 10 * 60_000 },
      { id: "sinceClosed", at: NOW - 10 * 60_000 },
      { id: "tooOld", at: NOW - PULSE_WINDOW_MS - 60_000 },
      { id: "unknown", at: NOW - 10 * 60_000 },
    ];
    const pulse = computePulse(
      [
        bead({ id: "stillOpen" }),
        bead({ id: "sinceClaimed", status: "in_progress", updatedAt: minsAgo(5) }),
        bead({ id: "sinceClosed", status: "closed", closedAt: minsAgo(5) }),
        bead({ id: "tooOld" }),
      ],
      events,
      { now: NOW }
    );
    expect(pulse.newlyReady.map((b) => b.id)).toEqual(["stillOpen"]);
  });

  it("flags claims with no movement past the threshold, longest-held first", () => {
    const pulse = computePulse(
      [
        bead({ id: "wedged", status: "in_progress", updatedAt: minsAgo(200), assignee: "agent-a" }),
        bead({ id: "worse", status: "in_progress", updatedAt: minsAgo(400) }),
        bead({ id: "active", status: "in_progress", updatedAt: minsAgo(5) }),
        bead({ id: "untimed", status: "in_progress" }),
        bead({ id: "notClaimed", status: "open", updatedAt: minsAgo(400) }),
      ],
      [],
      { now: NOW }
    );
    expect(pulse.staleClaims.map((s) => s.bead.id)).toEqual(["worse", "wedged"]);
    expect(pulse.staleClaims[1].heldMs).toBe(200 * 60_000);
  });

  it("honours a custom stale threshold", () => {
    const pulse = computePulse(
      [bead({ id: "a", status: "in_progress", updatedAt: minsAgo(30) })],
      [],
      { now: NOW, staleMs: 20 * 60_000 }
    );
    expect(pulse.staleClaims.map((s) => s.bead.id)).toEqual(["a"]);
    expect(STALE_CLAIM_MS).toBeGreaterThan(20 * 60_000);
  });

  it("lists recent activity newest first, capped, regardless of the window", () => {
    const beads = ["a", "b", "c", "d", "e", "f"].map((id, i) =>
      bead({ id, updatedAt: minsAgo((i + 1) * 100) })
    );
    const pulse = computePulse([...beads, bead({ id: "untimed" })], [], {
      now: NOW,
      activityCap: 3,
    });
    expect(pulse.activity.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("diffReady", () => {
  it("reports only ids that were not ready before", () => {
    const events = diffReady(new Set(["kept"]), ["kept", "fresh"], NOW);
    expect(events).toEqual([{ id: "fresh", at: NOW }]);
  });
});

describe("pruneEvents", () => {
  it("drops events past the keep horizon and keeps the rest", () => {
    const kept = { id: "kept", at: NOW - PULSE_WINDOW_MS + 60_000 };
    const dropped = { id: "dropped", at: NOW - PULSE_WINDOW_MS - 60_000 };
    expect(pruneEvents([kept, dropped], NOW)).toEqual([kept]);
  });
});
