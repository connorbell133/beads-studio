/**
 * Webview-side type definitions
 *
 * These mirror the backend types but are used in the React webview.
 */

// The graph model is imported rather than mirrored. src/graph has no vscode
// dependency, so both sides can share one definition - and a mirrored copy is
// exactly how the dependency shape drifted out of sync in the first place.
import type { BeadsGraphModel } from "../graph/types";

export type { BeadsGraphModel, BeadGraphNode } from "../graph/types";
export { COORDINATION_TYPES, CONTAINER_TYPES, isContainerType } from "../graph/types";

// Re-export types that are shared between extension and webview.
//
// These are bd's seven built-in statuses. bd also allows arbitrary user-defined
// statuses via `bd config set types.custom`/`status.custom`, which arrive as
// plain strings; the extension passes those through unstyled rather than
// dropping the bead. Treat this union as "the ones we style".
export type BeadStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "deferred"
  | "closed"
  | "pinned"
  | "hooked";

// Built-in statuses in display order (used for filter lists and board columns).
export const BUILT_IN_STATUSES: BeadStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "pinned",
  "hooked",
  "closed",
];

export type BeadPriority = 0 | 1 | 2 | 3 | 4;

// Dependency relationship types
export type DependencyType = "blocks" | "parent-child" | "related" | "discovered-from";

export interface BeadComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface BeadDependency {
  id: string;
  type?: string; // issue_type for coloring
  dependencyType?: DependencyType; // relationship type: blocks, parent-child, etc.
  title?: string;
  status?: BeadStatus;
  priority?: BeadPriority;
}

export interface Bead {
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptanceCriteria?: string;
  notes?: string;
  type?: string;
  priority?: BeadPriority;
  status: BeadStatus;
  assignee?: string;
  labels?: string[];
  estimatedMinutes?: number;
  externalRef?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  dependsOn?: BeadDependency[];
  blocks?: BeadDependency[];
  comments?: BeadComment[];
  sortOrder?: number;
}

export interface BeadsProject {
  id: string;
  name: string;
  rootPath: string;
  beadsDir: string;
  source?: "workspace" | "setting" | "env";
  dbPath?: string;
  backendStatus: "running" | "stopped" | "unknown";
  backendPid?: number;
}

// readyCount and blockedCount are graph-derived, not tallies of the `open` and
// `blocked` status labels.
export interface BeadsSummary {
  total: number;
  // Keyed by string: custom statuses are unbounded. Read with `byStatus[s] ?? 0`.
  byStatus: Record<string, number>;
  byPriority: Record<BeadPriority, number>;
  readyCount: number;
  blockedCount: number;
  inProgressCount: number;
  /** The node set was partial, so blockedCount may over-report. */
  degraded: boolean;
}

export interface WebviewSettings {
  renderMarkdown: boolean;
  userId: string;
  tooltipHoverDelay: number; // 0 = disabled
}

// Messages from extension to webview
export type ExtensionMessage =
  | { type: "setViewType"; viewType: string }
  | { type: "setProject"; project: BeadsProject | null }
  | { type: "setBeads"; beads: Bead[] }
  | { type: "setBead"; bead: Bead | null }
  | { type: "setSelectedBeadId"; beadId: string | null; origin?: string }
  | { type: "focusGraphFind" }
  | { type: "toggleTreeMode" }
  | { type: "setSummary"; summary: BeadsSummary }
  | { type: "setGraph"; graph: BeadsGraphModel }
  | { type: "setProjects"; projects: BeadsProject[] }
  | { type: "setLoading"; loading: boolean }
  | { type: "setError"; error: string | null }
  | { type: "setSettings"; settings: WebviewSettings }
  | { type: "refresh" }
  | { type: "showToast"; text: string }
  | { type: "applyIssuesPreset"; presetId: string }
  | { type: "setPulse"; events: { id: string; at: number }[] };

// Messages from webview to extension
export type WebviewMessage =
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
  | { type: "openFile"; filePath: string; line?: number }
  | { type: "openIssuesPreset"; presetId: string }
  | { type: "openGraph" };

// Human-readable labels
export const PRIORITY_LABELS: Record<BeadPriority, string> = {
  0: "critical",
  1: "high",
  2: "medium",
  3: "low",
  4: "none",
};

// Indexed by string because custom statuses are unbounded; callers fall back to
// the raw status text when a status has no label here.
export const STATUS_LABELS: Record<string, string> = {
  open: "open",
  in_progress: "in progress",
  blocked: "blocked",
  deferred: "deferred",
  closed: "closed",
  pinned: "pinned",
  hooked: "hooked",
};

// ---------------------------------------------------------------------------
// Colour.
//
// Every value below is a VS Code theme token, never a literal. The palette this
// replaced was bd's dark-TUI colours applied against every theme, which left
// `pinned` and `hooked` at 1.98:1 against a white editor background.
//
// Which token is safe where was measured, not assumed - see
// theme/tokens.ts and theme/__tests__/contrast.test.ts. Text reads in a
// text-safe token; hue lives in dots, borders, icons and bars, where the 3:1
// graphic bar applies.
// ---------------------------------------------------------------------------

import { GRAPHIC_TOKENS, statusHue, typeHue } from "./theme/tokens";

export { statusHue, typeHue, priorityStyle, priorityLabel, TEXT_TOKENS, GRAPHIC_TOKENS } from "./theme/tokens";

/** Accent hue per priority. Used for bars and rails, never behind label text. */
export const PRIORITY_COLORS: Record<BeadPriority, string> = {
  0: GRAPHIC_TOKENS.danger,
  1: GRAPHIC_TOKENS.warning,
  2: GRAPHIC_TOKENS.info,
  3: GRAPHIC_TOKENS.muted,
  4: GRAPHIC_TOKENS.neutral,
};

// Colors for unknown/undefined priority (shown as "P?")
export const UNKNOWN_PRIORITY_COLOR = GRAPHIC_TOKENS.neutral;

/** Accent hue per status, resolved through the measured token mapping. */
export const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  BUILT_IN_STATUSES.map((status) => [status, statusHue(status)])
);

// Color for statuses with no entry above (user-defined via status.custom)
export const UNKNOWN_STATUS_COLOR = GRAPHIC_TOKENS.neutral;

// bd's built-in issue types (internal/types/types.go), plus `merge-request`,
// which bd demoted to a custom type but which existing databases still contain.
// Custom types are unbounded, so unknown values fall back to the UNKNOWN_TYPE_*
// styling and the notdef icon rather than being a hard error.
export type BeadType =
  | "bug"
  | "feature"
  | "task"
  | "epic"
  | "chore"
  | "decision"
  | "message"
  | "molecule"
  | "gate"
  | "spike"
  | "story"
  | "milestone"
  | "event"
  | "merge-request";

export const TYPE_LABELS: Record<string, string> = {
  bug: "bug",
  feature: "feature",
  task: "task",
  epic: "epic",
  chore: "chore",
  decision: "decision",
  message: "message",
  molecule: "molecule",
  gate: "gate",
  spike: "spike",
  story: "story",
  milestone: "milestone",
  event: "event",
  "merge-request": "merge-request",
};

export const TYPE_COLORS: Record<string, string> = Object.fromEntries(
  (Object.keys(TYPE_LABELS) as string[]).map((type) => [type, typeHue(type)])
);

// Color for unknown/undefined type (shown with question mark icon)
export const UNKNOWN_TYPE_COLOR = GRAPHIC_TOKENS.neutral;

// Sort order for type display (lower = first)
// Planning scope first (epic/milestone/story), then work items, then the
// coordination/infrastructure types bd uses internally.
export const TYPE_SORT_ORDER: Record<string, number> = {
  epic: 0,
  milestone: 1,
  story: 2,
  feature: 3,
  bug: 4,
  task: 5,
  spike: 6,
  chore: 7,
  decision: 8,
  "merge-request": 9,
  molecule: 10,
  gate: 11,
  message: 12,
  event: 13,
};

// Default sort order for unknown types (sorts after known types)
export const UNKNOWN_TYPE_SORT_ORDER = 99;

/** Get sort order for a type (handles unknown types) */
export function getTypeSortOrder(type: string | undefined): number {
  if (!type) return UNKNOWN_TYPE_SORT_ORDER;
  return TYPE_SORT_ORDER[type] ?? UNKNOWN_TYPE_SORT_ORDER;
}

/** Sort labels alphabetically (case-insensitive) */
export function sortLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  return [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// VS Code API interface for webview
declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage: (message: WebviewMessage) => void;
      getState: () => unknown;
      setState: (state: unknown) => void;
    };
  }
}

export const vscode = window.acquireVsCodeApi();
