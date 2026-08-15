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

/**
 * Preconditions attached to a write so a concurrent actor's edit is not
 * clobbered.
 *
 * The extension computes every write from a snapshot that can be seconds old
 * (graph poll plus list cache), and agents write to the same rows. Without a
 * precondition the operator's stale value silently overwrites whatever landed
 * in between. bd checks these server-side and writes nothing on a mismatch.
 *
 * Values must be exactly what bd stores: `--if-status` rejects the aliases
 * `--status` accepts (verified on bd 1.2.1 - `--if-status in-progress` exits 1
 * as an invalid value). normalizeStatus already canonicalizes to bd's built-in
 * names and passes custom statuses through untouched, so a normalized status is
 * a safe guard value.
 */
export interface WriteGuard {
  /** Apply only if the stored status still equals this. */
  ifStatus?: string;
  /** Apply only if the stored assignee still equals this ("" means unassigned). */
  ifAssignee?: string;
}

/** Which precondition bd rejected, and the values on both sides of it. */
export interface WriteConflict {
  id: string;
  field: "status" | "assignee";
  /** What the UI believed when it built the write. */
  expected?: string;
  /** What bd reports the value actually is now, when it can be recovered. */
  actual?: string;
  /** What the user was trying to set, when the conflicting field was being written. */
  attempted?: string;
}

/**
 * The outcome of a guarded write.
 *
 * A rejected precondition is an ordinary outcome, not a failure: bd wrote
 * nothing and the caller has to show the user current truth. Modelling it as a
 * result rather than an exception keeps it distinguishable from the thrown
 * errors that mean "the command actually broke".
 */
export type UpdateOutcome =
  | { ok: true; issue: BeadsIssue }
  | { ok: false; conflict: WriteConflict };

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
  /** Preconditions; omitted means an unconditional write, as before. */
  guard?: WriteGuard;
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
  show(id: string): Promise<BeadsIssue | null>;
  create(args: CreateIssueArgs): Promise<BeadsIssue>;
  /**
   * Applies a field update, optionally guarded by `args.guard`.
   *
   * Resolves to `{ ok: false }` when bd refused because a precondition no
   * longer held. An unguarded call can only resolve `{ ok: true }` or throw.
   */
  update(args: UpdateIssueArgs): Promise<UpdateOutcome>;
  /**
   * Closes an issue.
   *
   * Unguarded: bd 1.2.1's `close` has no `--if-status`/`--if-assignee` (only
   * `update` does), so there is no precondition to send. Every close the UI
   * performs today goes through `update --status closed`, which is guarded.
   */
  close(args: CloseIssueArgs): Promise<BeadsIssue>;
  addDependency(args: DependencyArgs): Promise<void>;
  removeDependency(args: DependencyArgs): Promise<void>;
  listComments(id: string): Promise<Array<{ id: string; author: string; text: string; created_at: string }>>;
  addComment(args: AddCommentArgs): Promise<void>;
}
