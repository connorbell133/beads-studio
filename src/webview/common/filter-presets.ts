/**
 * Status filter presets, shared by the Issues list and the dependency graph
 * so the two surfaces offer the same vocabulary and cannot drift.
 */

import { BeadPriority, BeadStatus } from "../types";

export interface FilterPreset {
  id: string;
  label: string;
  /** Statuses the preset keeps. Empty means everything. */
  statuses: BeadStatus[];
}

export const FILTER_PRESETS: FilterPreset[] = [
  { id: "all", label: "All", statuses: [] },
  { id: "not-closed", label: "Not Closed", statuses: ["open", "in_progress", "blocked", "deferred", "pinned", "hooked"] },
  { id: "active", label: "Active", statuses: ["in_progress", "blocked", "hooked"] },
  { id: "blocked", label: "Blocked", statuses: ["blocked"] },
  { id: "closed", label: "Closed", statuses: ["closed"] },
];

export const presetStatuses = (id: string): BeadStatus[] =>
  FILTER_PRESETS.find((p) => p.id === id)?.statuses ?? [];

/** Sentinel meaning "beads with no assignee" in an assignee filter. */
export const UNASSIGNED = "__unassigned__";
/** Sentinel meaning "beads with no labels" in a label filter. */
export const UNLABELED = "__unlabeled__";

/**
 * The full filter state a surface can apply to beads. `presetId` names the
 * preset the statuses came from, "" once the user has hand-picked statuses.
 */
export interface BeadFilters {
  presetId: string;
  statuses: BeadStatus[];
  priorities: BeadPriority[];
  types: string[];
  assignees: string[];
  labels: string[];
}

export function defaultBeadFilters(presetId: string): BeadFilters {
  return {
    presetId,
    statuses: presetStatuses(presetId),
    priorities: [],
    types: [],
    assignees: [],
    labels: [],
  };
}

/** One predicate for every surface, so a filter means the same thing everywhere. */
export function beadMatchesFilters(
  bead: {
    status: BeadStatus;
    priority?: BeadPriority;
    type?: string;
    assignee?: string;
    labels?: string[];
  },
  filters: BeadFilters
): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(bead.status)) return false;
  if (
    filters.priorities.length > 0 &&
    (bead.priority === undefined || !filters.priorities.includes(bead.priority))
  ) {
    return false;
  }
  if (filters.types.length > 0 && (!bead.type || !filters.types.includes(bead.type))) return false;
  if (filters.assignees.length > 0) {
    const unassignedOk = filters.assignees.includes(UNASSIGNED) && !bead.assignee;
    const named = bead.assignee !== undefined && filters.assignees.includes(bead.assignee);
    if (!unassignedOk && !named) return false;
  }
  if (filters.labels.length > 0) {
    const labels = bead.labels ?? [];
    if (labels.length === 0) {
      if (!filters.labels.includes(UNLABELED)) return false;
    } else if (!labels.some((label) => filters.labels.includes(label))) {
      return false;
    }
  }
  return true;
}
