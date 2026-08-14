/**
 * The derived graph model.
 *
 * Every shape here crosses the extension/webview postMessage boundary, so it is
 * plain JSON throughout - no Map, no Set. That constraint is load-bearing, not
 * stylistic: a Map arrives in the webview as an empty object.
 */

/** The bd types that coordinate work without being work. */
export const COORDINATION_TYPES = ["gate", "agent", "role", "message"] as const;

/** The subset of a bead the derivation reads. Satisfied by BeadsIssue. */
export interface GraphInputNode {
  id: string;
  status: string;
  issue_type?: string;
  priority?: number;
  created_at?: string;
  /** `bd list --json` emits this scalar alongside the parent-child edge. */
  parent?: string;
  parent_id?: string;
}

/** An edge as normalized by the backend: `from` depends on `to`. */
export interface GraphInputEdge {
  from: string;
  to: string;
  type: string;
}

export interface BeadGraphNode {
  id: string;
  /** Ids of blockers that have not closed yet. Empty means nothing is in the way. */
  blockedBy: string[];
  /**
   * Every recorded blocker, closed or not.
   *
   * `blockedBy` answers "what is still in my way" and shrinks as work lands.
   * This answers "what was this ever sequenced behind", which does not change
   * when a blocker closes. Drawing surfaces read this so the picture of an epic
   * holds still while it is worked; readiness reads `blockedBy` so a satisfied
   * dependency never keeps a bead looking stuck.
   */
  dependsOn: string[];
  /** Status is exactly open, nothing blocks it, and it is real work. */
  ready: boolean;
  /** Longest-path depth over open blockers. 0 means no blockers. */
  rank: number;
  /**
   * Longest-path depth over `dependsOn`. The layout counterpart to `rank`:
   * stable for the life of the graph, because closing a blocker does not
   * remove the edge it is computed from.
   */
  layoutRank: number;
  /** How many beads this bead's closure would unblock, transitively. */
  leverage: number;
  /** The deepest open blocker path out of this bead, nearest blocker first. */
  blockerChain: string[];
  /** Resolved parent id, present only when the parent is in the node set. */
  parent?: string;
  children: string[];
  /** Present only when the bead has children. */
  childCounts?: { closed: number; total: number };
  /** Longest member chain, on epics with children. */
  criticalPath?: number;
  inCycle: boolean;
}

export interface BeadsGraphModel {
  nodes: Record<string, BeadGraphNode>;
  /** Ready work, id-ordered. Sorting for display belongs to the consumer. */
  ready: string[];
  /** Open work with at least one open blocker, id-ordered. */
  blocked: string[];
  /**
   * Beads with no resolvable parent - which includes every top-level epic, not
   * only standalone work. A surface wanting "orphans" in the colloquial sense
   * (parentless AND childless) must narrow this; see tree.ts.
   */
  parentless: string[];
  /** Each dependency cycle, as the ids tangled in it. */
  cycles: string[][];
  hasCycle: boolean;
  /**
   * False when the node set is known to be partial. Readiness stays correct -
   * an unresolvable blocker counts as open - but `blocked` may over-report.
   */
  complete: boolean;
}

export interface DeriveGraphOptions {
  complete?: boolean;
  /**
   * Types kept out of the ready and blocked queues while still participating
   * as graph nodes and blockers. Defaults to COORDINATION_TYPES.
   */
  coordinationTypes?: readonly string[];
}
