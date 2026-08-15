/**
 * The human inbox: which beads are waiting on a person, and what that wait is
 * costing.
 *
 * Pure and free of React or vscode, for the same reason `readyLane.ts` is - the
 * ranking is the whole idea, and a ranking that lives inside a component is a
 * ranking with no test.
 *
 * The premise. In a swarm the agents are parallel and the human is not, so the
 * queue in front of the human is where the DAG pools. A chronological inbox
 * makes that person answer the *oldest* question; this one makes them answer
 * the *most expensive* one. Those are rarely the same question, and the gap
 * between them is the entire value of the surface.
 *
 * Stall cost. `frozen x waitHours`, where `frozen` is how many beads sit behind
 * this one transitively - the graph's `leverage`, already computed - and
 * `waitHours` is how long it has been waiting. Neither factor alone works: a
 * question nobody is behind is cheap however long it sits, and a question that
 * dams half the backlog is cheap for its first minute.
 *
 * Nothing here re-derives readiness or leverage. `BeadsGraphModel` settled
 * those; this module decides which beads belong in the inbox and what order
 * they read in.
 */

import { BeadGraphNode, BeadsGraphModel } from "./types";

/** The label bd's `human` command selects on. See `bd human list --help`. */
export const HUMAN_LABEL = "human";

/** The bd issue type for an async wait condition. See `bd gate --help`. */
export const GATE_TYPE = "gate";

/**
 * Gate await types that a person has to clear by hand.
 *
 * bd's other gate types - `timer`, `gh:run`, `gh:pr`, `bead` - resolve
 * themselves when the world changes, so they are blocked on *work*, not on a
 * person, and putting them in a human inbox would be asking someone to do
 * something they cannot do. A gate whose await type is unknown is treated as
 * human because that is bd's own default for `bd gate create`.
 */
export const HUMAN_AWAIT_TYPES = ["human"] as const;

/** Where an inbox row came from. The two have different verbs available. */
export type InboxSource = "gate" | "labeled";

/** The subset of a bead the inbox reads. Satisfied by the webview `Bead`. */
export interface InboxBead {
  id: string;
  title?: string;
  type?: string;
  status: string;
  priority?: number;
  labels?: string[];
  createdAt?: string;
  updatedAt?: string;
  /** A gate's await condition (`human`, `timer`, `gh:pr`, ...), when known. */
  awaitType?: string;
}

/** One waiting decision, with the cost of leaving it waiting. */
export interface InboxRow<T extends InboxBead> {
  bead: T;
  /** Absent when the bead is outside the graph payload. */
  node?: BeadGraphNode;
  /** Open beads dammed behind this one, transitively. */
  frozen: number;
  /** Those beads, deepest first. Same set `frozen` counts. */
  frozenIds: string[];
  /** How long it has been waiting, in milliseconds. Never negative. */
  waitedMs: number;
  /** `(frozen + 1) x waitHours`. Higher means more expensive to keep waiting. */
  stallCost: number;
  source: InboxSource;
}

export interface HumanInboxModel<T extends InboxBead> {
  /** Every waiting decision, most expensive first. */
  rows: InboxRow<T>[];
  /** Beads frozen behind the whole queue, deduplicated across rows. */
  totalFrozen: number;
  /**
   * bd could not be asked for its own human list, so membership was inferred
   * from labels. The set is the same in practice; the caveat is surfaced rather
   * than hidden.
   */
  degraded: boolean;
}

export interface HumanInboxOptions {
  /** Evaluation time. Injected so the ranking is testable. */
  now: number;
  /**
   * Ids from `bd human list --json`, when that command could be run.
   *
   * bd owns the definition of "needs a human", so when it answers, its answer
   * is authoritative for the labeled half of the inbox. When it cannot answer
   * (`undefined`), the `human` label on each bead is used instead and the model
   * reports `degraded`.
   */
  humanIds?: readonly string[];
}

const HOUR_MS = 3_600_000;

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const UNSET_PRIORITY = 4;

function isClosed(bead: InboxBead): boolean {
  const status = bead.status?.toLowerCase().replace(/-/g, "_");
  return status === "closed" || status === "done" || status === "completed";
}

/** True when the bead carries bd's `human` label, in any casing. */
export function hasHumanLabel(bead: InboxBead): boolean {
  return (bead.labels ?? []).some((label) => label.trim().toLowerCase() === HUMAN_LABEL);
}

/**
 * True when the bead is a gate a person has to clear by hand.
 *
 * An unknown await type counts as human: `bd gate create` defaults to
 * `--type=human`, and on backends that cannot read the column back the
 * alternative is dropping real gates out of the inbox silently.
 */
export function isHumanGate(bead: InboxBead): boolean {
  if (bead.type !== GATE_TYPE) return false;
  const awaitType = bead.awaitType?.trim().toLowerCase();
  if (!awaitType) return true;
  return (HUMAN_AWAIT_TYPES as readonly string[]).includes(awaitType);
}

/**
 * The ids of every open bead currently waiting on a person.
 *
 * Used by surfaces that only need the membership test - the blocker chips on
 * the issues list, say - and by the inbox itself when bd's own list is
 * unavailable.
 */
export function waitingOnHuman(beads: readonly InboxBead[]): Set<string> {
  const waiting = new Set<string>();
  for (const bead of beads) {
    if (isClosed(bead)) continue;
    if (isHumanGate(bead) || hasHumanLabel(bead)) waiting.add(bead.id);
  }
  return waiting;
}

/**
 * Splits a bead's blockers into the ones a person clears and the ones work
 * clears.
 *
 * The two have opposite implications and the same red pill today: a blocker
 * that is a question answers itself the moment someone looks at it, and a
 * blocker that is work waits for however long the work takes. Ids not in
 * `waiting` fall to `work`, which is the safe default - mislabeling work as a
 * person's problem sends someone to a bead they cannot clear.
 */
export function partitionBlockers(
  ids: readonly string[],
  waiting: ReadonlySet<string>
): { people: string[]; work: string[] } {
  const people: string[] = [];
  const work: string[] = [];
  for (const id of ids) {
    (waiting.has(id) ? people : work).push(id);
  }
  return { people, work };
}

/**
 * When the wait started.
 *
 * `createdAt` rather than `updatedAt`, because the beads in this queue are
 * filed at the moment the question arises - an agent hits a decision it cannot
 * make and files it, and `bd gate create` runs when the step needs the gate. So
 * creation *is* the start of the wait, while `updatedAt` resets every time
 * anyone touches the bead, which would let an unanswered question look fresh
 * forever. Falls back to `updatedAt`, then to `now`, so a bead with no
 * timestamps ranks last rather than first.
 */
export function waitStartedAt(bead: InboxBead, now: number): number {
  for (const raw of [bead.createdAt, bead.updatedAt]) {
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now;
}

/**
 * What it costs to leave a decision waiting: frozen work times hours waited.
 *
 * `frozen + 1` counts the waiting bead itself, so a question that dams nothing
 * still accrues cost - it is a real answer someone owes - just an order of
 * magnitude below one damming six. Without the `+ 1` every leverage-zero
 * question scores exactly 0 and the queue's whole tail ties.
 *
 * Hours rather than milliseconds keeps the numbers legible in a debugger; the
 * unit cancels out of the ordering either way.
 */
export function stallCost(frozen: number, waitedMs: number): number {
  return (Math.max(0, frozen) + 1) * (Math.max(0, waitedMs) / HOUR_MS);
}

/**
 * Every open bead dammed behind `id`, transitively, deepest first.
 *
 * Walks the inverted open-blocker graph, which is the same edge set
 * `BeadGraphNode.leverage` is counted over - so `frozenIds.length` equals
 * `leverage` for any id inside the payload, and `graph/__tests__` holds that
 * equality down. Closed dependents are traversed but not collected: they can
 * lead on to open work, but nothing about them is frozen.
 *
 * Iterative with a visited guard, so a dependency cycle terminates the walk
 * instead of hanging it.
 */
export function frozenBehind(
  model: BeadsGraphModel,
  dependents: ReadonlyMap<string, string[]>,
  closed: (id: string) => boolean,
  id: string
): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];
  const queue = [...(dependents.get(id) ?? [])];
  let head = 0;

  while (head < queue.length) {
    const next = queue[head++];
    if (next === id || seen.has(next)) continue;
    seen.add(next);
    if (!closed(next)) collected.push(next);
    for (const onward of dependents.get(next) ?? []) {
      if (!seen.has(onward)) queue.push(onward);
    }
  }

  return collected.sort(
    (a, b) => (model.nodes[b]?.rank ?? 0) - (model.nodes[a]?.rank ?? 0) || compareId(a, b)
  );
}

/**
 * Who waits on whom, inverted from each node's open blockers.
 *
 * The graph model ships the forward direction only, and every consumer that
 * wants the reverse has been inverting it by hand. Exported so the inbox and
 * the issues list share one inversion rather than two that can drift.
 */
export function invertBlockers(model: BeadsGraphModel): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const [id, node] of Object.entries(model.nodes)) {
    for (const blocker of node.blockedBy) {
      const list = dependents.get(blocker);
      if (list) list.push(id);
      else dependents.set(blocker, [id]);
    }
  }
  return dependents;
}

/**
 * Inbox order: stall cost first, then frozen count, then wait, then priority,
 * then id.
 *
 * Cost leads because that is the claim the surface makes. The tiebreakers are
 * deliberately *not* "oldest first" all the way down: between two equally
 * expensive rows the one damming more work is the one whose answer releases
 * more, and only after that does age decide. Id last, so the order is stable
 * across refreshes - a queue that reshuffles on every poll is unusable however
 * well it is sorted.
 */
export function compareStallCost<T extends InboxBead>(a: InboxRow<T>, b: InboxRow<T>): number {
  if (a.stallCost !== b.stallCost) return b.stallCost - a.stallCost;
  if (a.frozen !== b.frozen) return b.frozen - a.frozen;
  if (a.waitedMs !== b.waitedMs) return b.waitedMs - a.waitedMs;
  const pa = a.bead.priority ?? UNSET_PRIORITY;
  const pb = b.bead.priority ?? UNSET_PRIORITY;
  if (pa !== pb) return pa - pb;
  return compareId(a.bead.id, b.bead.id);
}

/**
 * The whole inbox in one pass: membership, cost, and order.
 *
 * Membership is the union of two sources that mean the same thing to a person
 * and different things to bd: open `gate` beads awaiting a manual resolve, and
 * beads carrying the `human` label. Closed beads are excluded here rather than
 * left to the caller - `bd human list` already hides them, and an inbox that
 * shows answered questions is not an inbox.
 */
export function buildHumanInbox<T extends InboxBead>(
  model: BeadsGraphModel | null,
  beads: readonly T[],
  options: HumanInboxOptions
): HumanInboxModel<T> {
  const { now, humanIds } = options;
  const explicit = humanIds ? new Set(humanIds) : null;

  const rows: InboxRow<T>[] = [];
  const empty: BeadsGraphModel = { nodes: {}, ready: [], blocked: [], parentless: [], cycles: [], hasCycle: false, complete: false };
  const graph = model ?? empty;
  const dependents = invertBlockers(graph);
  const byId = new Map(beads.map((bead) => [bead.id, bead]));
  const closed = (id: string): boolean => {
    const bead = byId.get(id);
    // A bead outside the payload counts as open, matching how the graph model
    // treats an unresolvable blocker: over-reporting frozen work is recoverable.
    return bead ? isClosed(bead) : false;
  };

  for (const bead of beads) {
    if (isClosed(bead)) continue;

    const gate = isHumanGate(bead);
    const labeled = explicit ? explicit.has(bead.id) : hasHumanLabel(bead);
    if (!gate && !labeled) continue;

    const frozenIds = frozenBehind(graph, dependents, closed, bead.id);
    const waitedMs = Math.max(0, now - waitStartedAt(bead, now));
    rows.push({
      bead,
      node: graph.nodes[bead.id],
      frozen: frozenIds.length,
      frozenIds,
      waitedMs,
      stallCost: stallCost(frozenIds.length, waitedMs),
      // A gate is the stronger statement: it names an explicit wait condition,
      // and its verb set differs from a labeled bead's.
      source: gate ? "gate" : "labeled",
    });
  }

  rows.sort(compareStallCost);

  // A union rather than a sum: two decisions gating the same epic are holding
  // up one epic, not two, and a header that adds them up overstates the queue.
  const frozenUnion = new Set<string>();
  for (const row of rows) {
    for (const id of row.frozenIds) frozenUnion.add(id);
  }

  return {
    rows,
    totalFrozen: frozenUnion.size,
    degraded: explicit === null,
  };
}
