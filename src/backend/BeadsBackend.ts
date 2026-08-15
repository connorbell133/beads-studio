import type { BeadEdge, RawDependency } from "./types";

/**
 * Oldest bd release the extension supports.
 *
 * Floor is 1.0.5 because `bd show --json` gained --include-dependents there
 * (bd commit cfcc95799); older builds reject the flag outright, and the
 * details panel relies on it to populate the "blocks" list.
 */
export const MIN_SUPPORTED_BD_VERSION = "1.0.5";

export interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  status: string;
  priority: number;
  issue_type: string;
  /**
   * A gate's await condition: `human`, `timer`, `gh:run`, `gh:pr`, `bead`.
   *
   * Only gate beads carry it. It is what separates a gate a person has to clear
   * from one that clears itself, so the human inbox cannot be correct without
   * it - see `src/graph/human-inbox.ts`.
   */
  await_type?: string;
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
}

/**
 * One complete read of a project: every bead the backend can see, plus every
 * edge among them.
 *
 * `complete` is false when the node set is known to be partial - today only on
 * the CLI path, when the installed bd cannot be asked to include gate and infra
 * beads. A partial node set does not make readiness wrong, because an edge
 * pointing at a bead outside `nodes` is treated as an open blocker, but it does
 * make "blocked" over-report. Consumers surface that rather than hiding it.
 */
export interface BeadsGraphPayload {
  nodes: BeadsIssue[];
  edges: BeadEdge[];
  complete: boolean;
}

export interface CreateIssueArgs {
  title: string;
  issue_type?: string;
  priority?: number;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  assignee?: string;
  labels?: string[];
}

export interface UpdateIssueArgs {
  id: string;
  title?: string;
  type?: string;
  issue_type?: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  external_ref?: string;
  estimated_minutes?: number;
  estimate?: number;
  add_labels?: string[];
  remove_labels?: string[];
  set_labels?: string[];
}

export interface CloseIssueArgs {
  id: string;
  reason?: string;
}

export interface DependencyArgs {
  from_id: string;
  to_id: string;
  dep_type?: string;
}

export interface AddCommentArgs {
  id: string;
  author?: string;
  text: string;
}

/**
 * What `bd human list` reported, and whether it could be asked at all.
 *
 * bd owns the definition of "needs a human" - today, the `human` label - so its
 * answer is authoritative when available. `supported: false` means the command
 * is missing or failed, not that nothing is waiting: the caller falls back to
 * reading the label off the beads it already has and says so on screen.
 */
export interface HumanNeededPayload {
  ids: string[];
  supported: boolean;
}

export interface HumanRespondArgs {
  id: string;
  response: string;
}

export interface HumanDismissArgs {
  id: string;
  reason?: string;
}

export interface BackendCompatibility {
  supported: boolean;
  detectedVersion?: string;
  minimumVersion: string;
  message: string;
}

export interface BeadsBackend {
  dispose(): Promise<void>;
  checkCompatibility(): Promise<BackendCompatibility>;
  probeLive(): Promise<void>;
  info(): Promise<Record<string, unknown>>;
  getChangeToken(): Promise<string | null>;
  doltStatus(): Promise<string>;
  startDoltServer(): Promise<string>;
  stopDoltServer(): Promise<string>;
  list(): Promise<BeadsIssue[]>;
  /**
   * The nodes and edges of the whole project in one read.
   *
   * Separate from list() because the graph read wants every bead - including
   * the coordination types bd hides by default - while list() keeps parity with
   * `bd list` for the surfaces that display it. Callers deriving readiness must
   * use this one; filtering hidden types is a display concern.
   */
  listGraph(): Promise<BeadsGraphPayload>;
  /**
   * The ids bd itself considers to need a person, from `bd human list --json`.
   *
   * A read, not a derivation: the extension already has every label, but which
   * labels mean "a human owes an answer" is bd's call, not the extension's, and
   * pinning it here means a future `bd human` that widens the definition widens
   * this surface for free. Never throws - an older bd degrades the inbox rather
   * than blanking it.
   */
  listHumanNeeded(): Promise<HumanNeededPayload>;
  /** `bd human respond`: comments the answer and closes the bead. */
  humanRespond(args: HumanRespondArgs): Promise<void>;
  /** `bd human dismiss`: closes the bead permanently without answering. */
  humanDismiss(args: HumanDismissArgs): Promise<void>;
  show(id: string): Promise<BeadsIssue | null>;
  create(args: CreateIssueArgs): Promise<BeadsIssue>;
  update(args: UpdateIssueArgs): Promise<BeadsIssue>;
  close(args: CloseIssueArgs): Promise<BeadsIssue>;
  addDependency(args: DependencyArgs): Promise<void>;
  removeDependency(args: DependencyArgs): Promise<void>;
  listComments(id: string): Promise<Array<{ id: string; author: string; text: string; created_at: string }>>;
  addComment(args: AddCommentArgs): Promise<void>;
}
