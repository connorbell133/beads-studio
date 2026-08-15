/**
 * Turning a UI edit into a guarded write, and a refused write into a sentence.
 *
 * Both halves are pure so the interesting decisions - which fields get a
 * precondition, and what the user is told when one fails - are pinned by tests
 * rather than only reachable through a live bd.
 */

import type { WriteConflict, WriteGuard } from "./BeadsBackend";
import { STATUS_LABELS } from "./types";

/** The values a surface saw before the user touched them. */
export interface WriteExpectation {
  status?: string;
  assignee?: string;
}

/** The subset of an update that decides which guards are worth sending. */
export interface GuardableFields {
  status?: string;
  assignee?: string;
}

/**
 * Builds the preconditions for one edit.
 *
 * Only fields the edit actually writes are guarded. Guarding a priority change
 * on status would reject writes that race nothing the user cares about, and
 * every false conflict spends the affordance's credibility - the point is to
 * catch the edit that would have clobbered an agent, not to announce that an
 * agent was busy.
 *
 * An expectation of `undefined` means the surface could not name a pre-edit
 * value, so the write goes out unguarded rather than guessing one. An empty
 * assignee is a real value ("unassigned") and is guarded normally.
 */
export function buildWriteGuard(
  updates: GuardableFields,
  expected: WriteExpectation | undefined
): WriteGuard | undefined {
  if (!expected) return undefined;

  const guard: WriteGuard = {};
  if (updates.status !== undefined && expected.status !== undefined) {
    guard.ifStatus = expected.status;
  }
  if (updates.assignee !== undefined && expected.assignee !== undefined) {
    guard.ifAssignee = expected.assignee;
  }

  return guard.ifStatus === undefined && guard.ifAssignee === undefined ? undefined : guard;
}

/**
 * Says who won the race, in the values the user recognizes.
 *
 * Names both sides whenever both are known. When the other actor already set
 * the value the user was reaching for, the write was redundant rather than
 * lost, and saying "conflict" would be a lie.
 */
export function describeWriteConflict(conflict: WriteConflict): string {
  const label = conflict.field === "status" ? "status" : "assignee";
  const actual = displayValue(conflict.field, conflict.actual);
  const attempted = displayValue(conflict.field, conflict.attempted);

  if (actual && attempted && actual === attempted) {
    return `${conflict.id} was already set to ${attempted} by someone else - your ${label} change was not needed. Showing current values.`;
  }

  const wasChangedTo = actual
    ? `someone else set ${label} to ${actual}`
    : `someone else changed ${label}`;
  const youTried = attempted ? `; you tried ${attempted}` : "";
  const from = displayValue(conflict.field, conflict.expected);
  const since = from ? ` (you were editing from ${from})` : "";

  return `${conflict.id} changed while you were editing: ${wasChangedTo}${youTried}${since}. Nothing was written - showing current values.`;
}

/** Statuses read better as their UI labels; assignees are shown verbatim. */
function displayValue(field: WriteConflict["field"], value: string | undefined): string | null {
  if (value === undefined) return null;
  if (field === "assignee") return value === "" ? "unassigned" : `"${value}"`;
  return `"${STATUS_LABELS[value] ?? value}"`;
}
