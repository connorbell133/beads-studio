import type { BeadsGraphModel } from "../graph/types";

/**
 * Beads - TypeScript Data Models
 *
 * These types mirror the Beads issue schema as exposed by `bd list --json` and `bd show --json`.
 * The extension normalizes CLI output into these internal types.
 *
 * Status Mapping (beads canonical statuses):
 * - "open" -> "open"
 * - "in_progress" / "in-progress" / "active" -> "in_progress"
 * - "blocked" -> "blocked"
 * - "deferred" / "pinned" / "hooked" -> passed through unchanged
 * - "closed" / "done" / "completed" / "cancelled" -> "closed"
 * - anything else -> passed through unchanged (bd supports user-defined
 *   statuses via `bd config set status.custom`, so this set is open-ended)
 *
 * Priority Mapping:
 * - Beads uses 0-4 where 0 is highest priority (P0/Critical)
 * - 0: Critical/P0, 1: High/P1, 2: Medium/P2, 3: Low/P3, 4: None/P4
 */

// Bead status values used in the UI.
//
// These are bd's seven built-in statuses (internal/types/types.go). bd also
// allows arbitrary user-defined statuses via `bd config set status.custom`,
// which arrive as plain strings and are passed through by normalizeStatus.
// Treat this union as "the ones we style", not "the only legal values".
export type BeadStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "deferred"
  | "closed"
  | "pinned"
  | "hooked";

// The built-in statuses, in display order.
export const BUILT_IN_STATUSES: BeadStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "pinned",
  "hooked",
  "closed",
];

// Priority levels (0 = highest/critical, 4 = lowest/none)
export type BeadPriority = 0 | 1 | 2 | 3 | 4;

// Human-readable priority labels
export const PRIORITY_LABELS: Record<BeadPriority, string> = {
  0: "Critical",
  1: "High",
  2: "Medium",
  3: "Low",
  4: "None",
};

// Status display labels for the UI.
// Indexed by string because custom statuses are unbounded; callers fall back
// to the raw status text when a status has no label here.
export const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  blocked: "Blocked",
  deferred: "Deferred",
  closed: "Closed",
  pinned: "Pinned",
  hooked: "Hooked",
};

// Core Bead interface representing a single issue
export interface Bead {
  id: string; // e.g., "bd-a1b2", including dotted child IDs
  title: string;
  description?: string;
  design?: string; // Design notes
  acceptanceCriteria?: string; // Acceptance criteria
  notes?: string; // Working notes
  type?: string; // Beads issue_type: bug, feature, task, epic, chore
  priority?: BeadPriority;
  status: BeadStatus;
  assignee?: string;
  labels?: string[];
  estimatedMinutes?: number; // Time estimate
  externalRef?: string; // External reference e.g., "gh-9", "jira-ABC"
  createdAt?: string; // ISO/RFC3339 timestamps
  updatedAt?: string;
  closedAt?: string;

  // Dependency relationships (with type for coloring)
  dependsOn?: BeadDependency[]; // Issues this bead depends on
  blocks?: BeadDependency[]; // Issues that depend on this bead

  // Comments
  comments?: BeadComment[];

  // UI-specific fields (not from CLI)
  sortOrder?: number;
  statusColumn?: string;
}

// Comment on a bead
export interface BeadComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

// Dependency relationship types
export type DependencyType = "blocks" | "parent-child" | "related" | "discovered-from";

// Dependency reference with summary info for display
export interface BeadDependency {
  id: string;
  type?: string; // issue_type: bug, feature, task, epic, chore
  dependencyType?: DependencyType; // relationship type: blocks, parent-child, etc.
  title?: string;
  status?: BeadStatus;
  priority?: BeadPriority;
}

// Backend dependency format (before normalization)
export interface BackendBeadDependency {
  id: string;
  dependency_type: string; // relationship: blocks, related, parent-child, etc.
  issue_type?: string;     // bead type: bug, feature, task, epic, chore
  title?: string;
  status?: string;
  priority?: number;
}

/**
 * A dependency entry as it arrives on the wire, in either shape.
 *
 * `bd show --json` emits BackendBeadDependency: the far endpoint plus enough
 * metadata to render it. `bd list --json` emits ListWireDependency: both
 * endpoints and nothing else. Typing these as the same thing is what let the
 * list payload's edges silently normalize to `{ id: undefined }`.
 */
export type RawDependency = BackendBeadDependency | ListWireDependency;

/** The `bd list --json` dependency shape. Both endpoints, no display metadata. */
export interface ListWireDependency {
  issue_id: string;
  depends_on_id: string;
  type?: string;
  created_at?: string;
  created_by?: string;
  metadata?: string;
}

/**
 * A dependency edge between two beads, normalized from either wire shape.
 *
 * Direction is fixed once here and inherited by every consumer:
 * `from` is the dependent side, `to` is the thing it depends on. That matches
 * `bd dep add <from_id> <to_id>`, so a `blocks` edge reads as "from is blocked
 * by to". See docs/reference/beads-dependency-model.md.
 *
 * Unlike BeadDependency this carries no title/status/priority - the bulk edge
 * set names endpoints only, and consumers look the endpoints up in the node set.
 */
export interface BeadEdge {
  from: string;
  to: string;
  /** blocks | parent-child | related | discovered-from, or a bd custom type. */
  type: string;
}

/**
 * Which array a `bd show` dependency entry came from. That shape names only the
 * far end of the edge, so the array it sat in supplies the direction. The
 * `bd list` shape carries both endpoints and ignores this.
 */
export type EdgeDirection = "dependency" | "dependent";

/**
 * A `blocks` edge is the fail-safe default for an entry with no type.
 *
 * Readiness may over-report blocked but must never over-report ready, so an
 * untyped edge is treated as a blocker rather than dropped or downgraded to a
 * non-gating type. bd always emits a type in practice; this covers the case
 * where a future wire change or a hand-edited payload does not.
 */
const DEFAULT_EDGE_TYPE = "blocks";

function edgeType(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || DEFAULT_EDGE_TYPE;
}

function edgeEndpoint(raw: unknown): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

/**
 * Normalizes one raw dependency entry into a BeadEdge.
 *
 * Two wire shapes reach this function and they disagree about everything except
 * the concept:
 *
 *   `bd list --json` -> { issue_id, depends_on_id, type }  both endpoints named
 *   `bd show --json` -> { id, dependency_type }            only the far end
 *
 * The list shape wins when present because it is self-describing. Otherwise
 * `ownerId` supplies the near end and `direction` orients the edge.
 *
 * Returns null when an endpoint is missing. A half-edge is worse than no edge:
 * it cannot be resolved against the node set, so it would silently become an
 * unknown blocker on every derivation.
 */
export function normalizeEdge(
  ownerId: string,
  raw: unknown,
  direction: EdgeDirection = "dependency"
): BeadEdge | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as Record<string, unknown>;

  // `bd list` shape: both endpoints are explicit, so direction is irrelevant.
  const listFrom = edgeEndpoint(entry.issue_id);
  const listTo = edgeEndpoint(entry.depends_on_id);
  if (listFrom && listTo) {
    return { from: listFrom, to: listTo, type: edgeType(entry.type ?? entry.dependency_type) };
  }

  // `bd show` shape: the entry names the far end, the owner is the near end.
  const farEnd = edgeEndpoint(entry.id);
  const nearEnd = edgeEndpoint(ownerId);
  if (!farEnd || !nearEnd) {
    return null;
  }
  const type = edgeType(entry.dependency_type ?? entry.type);
  return direction === "dependency"
    ? { from: nearEnd, to: farEnd, type }
    : { from: farEnd, to: nearEnd, type };
}

/** Every edge carried inline on one raw issue, from both dependency arrays. */
export function edgesFromIssue(raw: {
  id?: string;
  dependencies?: unknown[];
  dependents?: unknown[];
}): BeadEdge[] {
  const ownerId = typeof raw.id === "string" ? raw.id : "";
  const edges: BeadEdge[] = [];
  for (const entry of raw.dependencies ?? []) {
    const edge = normalizeEdge(ownerId, entry, "dependency");
    if (edge) edges.push(edge);
  }
  for (const entry of raw.dependents ?? []) {
    const edge = normalizeEdge(ownerId, entry, "dependent");
    if (edge) edges.push(edge);
  }
  return edges;
}

/**
 * The deduplicated edge set across a whole list payload.
 *
 * Deduplication matters because `bd show` payloads name the same edge from both
 * ends, and because a complete list read reaches a shared blocker from every
 * bead that depends on it.
 */
export function edgesFromIssues(
  issues: Array<{ id?: string; dependencies?: unknown[]; dependents?: unknown[] }>
): BeadEdge[] {
  const seen = new Map<string, BeadEdge>();
  for (const issue of issues) {
    for (const edge of edgesFromIssue(issue)) {
      seen.set(`${edge.from}\u0000${edge.to}\u0000${edge.type}`, edge);
    }
  }
  return [...seen.values()];
}

// Represents a Beads project (database/workspace)
export interface BeadsProject {
  id: string; // Stable ID (hash of db path or root path)
  name: string; // Human-friendly label (folder name or config display name)
  rootPath: string; // Project root (VS Code workspace folder)
  beadsDir: string; // Path to .beads directory
  source?: "workspace" | "setting" | "env";
  dbPath?: string; // Path to beads.db (if discovered)
  backendStatus: "running" | "stopped" | "unknown";
  backendPid?: number;
}

// Result from `bd info --json`
export interface BeadsInfo {
  version?: string;
  database?: string;
  issue_count?: number;
  [key: string]: unknown;
}

// Legacy backend process info
export interface BackendProcessInfo {
  pid: number;
  database: string;
  working_dir?: string;
  status?: string;
  started_at?: string;
  [key: string]: unknown;
}

// Summary statistics for dashboard.
//
// readyCount and blockedCount are graph-derived (see src/graph/summary.ts), not
// tallies of the `open` and `blocked` status labels. In beads, ready means open
// AND free of open blockers - that is the entire purpose of the blocks edge.
export interface BeadsSummary {
  total: number;
  // Keyed by string: custom statuses are unbounded, so this is not a total map
  // over BeadStatus. Read with `byStatus[s] ?? 0`.
  byStatus: Record<string, number>;
  byPriority: Record<BeadPriority, number>;
  readyCount: number;
  blockedCount: number;
  inProgressCount: number;
  /** The node set was partial, so blockedCount may over-report. */
  degraded: boolean;
}

// Settings that can be passed to webview
export interface WebviewSettings {
  renderMarkdown: boolean;
  userId: string;
  tooltipHoverDelay: number; // 0 = disabled
}


// Messages sent from extension to webview
export type ExtensionToWebviewMessage =
  | { type: "setViewType"; viewType: string }
  | { type: "setProject"; project: BeadsProject | null }
  | { type: "setBeads"; beads: Bead[] }
  | { type: "setBead"; bead: Bead | null }
  | { type: "setSelectedBeadId"; beadId: string | null }
  | { type: "setSummary"; summary: BeadsSummary | null }
  | { type: "setGraph"; graph: BeadsGraphModel }
  | { type: "setProjects"; projects: BeadsProject[] }
  | { type: "setLoading"; loading: boolean }
  | { type: "setError"; error: string | null }
  | { type: "setSettings"; settings: WebviewSettings }
  | { type: "refresh" };

// Messages sent from webview to extension
export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "selectProject"; projectId: string; projectRootPath?: string }
  | { type: "showProjectMenu"; projectId: string }
  | { type: "showDoltStatus" }
  | { type: "startDoltServer" }
  | { type: "stopDoltServer" }
  | { type: "openDoltLog" }
  | { type: "openProjectFolder" }
  | { type: "selectBead"; beadId: string }
  | { type: "updateBead"; beadId: string; updates: Partial<Bead> }
  | { type: "deleteBead"; beadId: string }
  | { type: "addDependency"; beadId: string; targetId: string; dependencyType: DependencyType; reverse: boolean }
  | { type: "removeDependency"; beadId: string; dependsOnId: string }
  | { type: "addComment"; beadId: string; text: string }
  | { type: "openBeadDetails"; beadId: string }
  | { type: "viewInGraph"; beadId: string }
  | { type: "copyBeadId"; beadId: string }
  | { type: "openFile"; filePath: string; line?: number };

// CLI command result
export interface CommandResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  stderr?: string;
}

// Filter options for bead listing
export interface BeadFilters {
  status?: BeadStatus[];
  priority?: BeadPriority[];
  labels?: string[];
  type?: string[];
  assignee?: string[];
  search?: string;
}

// Sort options for bead listing
export interface BeadSort {
  field: "status" | "priority" | "updatedAt" | "createdAt" | "title";
  direction: "asc" | "desc";
}

/**
 * Normalizes a status string from Beads CLI to internal BeadStatus
 */
// Track warned statuses to avoid spam
const warnedStatuses = new Set<string>();

export function normalizeStatus(status: string | undefined): BeadStatus | null {
  if (!status || !status.trim()) {
    if (!warnedStatuses.has("__missing__")) {
      warnedStatuses.add("__missing__");
      console.warn("[vscode-beads] Bead missing status field - skipping");
    }
    return null;
  }
  const normalized = status.toLowerCase().replace(/-/g, "_");
  switch (normalized) {
    case "open":
      return "open";
    case "in_progress":
    case "active":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "deferred":
      return "deferred";
    case "pinned":
      return "pinned";
    case "hooked":
      return "hooked";
    case "closed":
    case "done":
    case "completed":
    case "cancelled":
    case "canceled":
      return "closed";
    default:
      // bd supports user-defined statuses (`bd config set status.custom`), so an
      // unrecognized value is legal data, not corruption. Pass it through rather
      // than dropping the bead - an unstyled badge beats an invisible issue.
      // The original casing/punctuation is preserved so filters and writes still
      // round-trip to bd.
      if (!warnedStatuses.has(status)) {
        warnedStatuses.add(status);
        console.warn(`[vscode-beads] Unrecognized bead status "${status}" - passing through unstyled`);
      }
      return status as BeadStatus;
  }
}

/**
 * Normalizes a priority value from Beads CLI to internal BeadPriority
 */
export function normalizePriority(
  priority: number | string | undefined
): BeadPriority {
  if (priority === undefined || priority === null) {
    return 4; // Default to "None"
  }
  const num =
    typeof priority === "string" ? parseInt(priority, 10) : priority;
  if (isNaN(num) || num < 0) {
    return 4;
  }
  if (num > 4) {
    return 4;
  }
  return num as BeadPriority;
}

/**
 * The display-ready subset of a raw dependency array.
 *
 * Only the `bd show` shape carries the title/status/priority the details panel
 * renders; the `bd list` shape names endpoints and nothing else. Entries without
 * a usable `id` are dropped rather than rendered as blank rows - before this
 * filter, every list-shaped entry produced a `{ id: undefined }` dependency.
 * The relationship itself is not lost: bulk edges come from edgesFromIssues.
 */
function hydrateDependencies(raw: RawDependency[] | undefined): BeadDependency[] | undefined {
  if (!raw) return undefined;
  const hydrated: BeadDependency[] = [];
  for (const entry of raw) {
    const d = entry as BackendBeadDependency;
    if (typeof d.id !== "string" || !d.id) continue;
    hydrated.push({
      id: d.id,
      type: d.issue_type,
      dependencyType: d.dependency_type as DependencyType | undefined,
      title: d.title,
      status: d.status ? normalizeStatus(d.status) ?? undefined : undefined,
      priority: d.priority !== undefined ? normalizePriority(d.priority) : undefined,
    });
  }
  return hydrated;
}

/**
 * Converts a backend issue to webview Bead format.
 * Returns null if status is invalid (bead will be skipped).
 */
export function issueToWebviewBead(issue: {
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  status: string;
  priority: number;
  issue_type: string;
  assignee?: string;
  labels?: string[];
  estimated_minutes?: number;
  external_ref?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  dependencies?: RawDependency[];
  dependents?: RawDependency[];
  comments?: Array<{ id: string; author: string; text: string; created_at: string }>;
}): Bead | null {
  const status = normalizeStatus(issue.status);
  if (status === null) {
    return null;
  }
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    design: issue.design,
    acceptanceCriteria: issue.acceptance_criteria,
    notes: issue.notes,
    type: issue.issue_type,
    priority: normalizePriority(issue.priority),
    status,
    assignee: issue.assignee,
    labels: issue.labels,
    estimatedMinutes: issue.estimated_minutes,
    externalRef: issue.external_ref,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    dependsOn: hydrateDependencies(issue.dependencies),
    blocks: hydrateDependencies(issue.dependents),
    comments: issue.comments?.map((c) => ({
      id: c.id,
      author: c.author,
      text: c.text,
      createdAt: c.created_at,
    })),
  };
}
