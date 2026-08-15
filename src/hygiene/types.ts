/**
 * The hygiene rule contract.
 *
 * A rule takes a context and returns findings. Nothing here imports `vscode`,
 * for the same reason nothing in `src/graph/` does: jest runs this project in a
 * node environment, so logic that needs a test cannot depend on the host. The
 * translation from finding to `vscode.Diagnostic` happens in one place,
 * `BeadsDiagnostics`, and every rule inherits it.
 *
 * Adding rule N+1 is: write a `HygieneRule`, add it to `HYGIENE_RULES`. The
 * severity, the anchoring, the Problems-panel plumbing, the project-switch
 * invalidation, and the cost tiering are already paid for.
 */

import type { BeadsGraphModel } from "../graph/types";

/** Mapped onto `vscode.DiagnosticSeverity` by the publisher. */
export type HygieneSeverity = "error" | "warning" | "info";

/**
 * What a rule costs to run, which decides when it runs.
 *
 * `local` reads the graph model that every surface has already derived - no
 * process, no I/O - so it runs on every derive, exactly as the cycle check
 * always has.
 *
 * `shell` spawns `bd` once per rule. Running those on every keystroke-adjacent
 * refresh would put a process spawn on the hot path of a view that repaints
 * several times a second, so they run only when asked.
 */
export type HygieneTier = "local" | "shell";

/**
 * A fix, as data.
 *
 * Kept declarative rather than as a callback so rules stay free of the host:
 * `BeadsHygieneActions` owns the execution and the confirmation prompt, and the
 * rule only says what should happen.
 */
export type HygieneFixAction =
  /** `bd orphans --fix` - closes every issue commits already claim is done. */
  | { type: "closeCommitReferenced"; ids: string[] }
  /** One duplicate group: close the copies, link each back to the survivor. */
  | { type: "closeDuplicate"; sources: string[]; target: string };

export interface HygieneFix {
  /**
   * Stable identity for this fix.
   *
   * A code action cannot carry the finding object itself - it crosses the host
   * boundary and comes back as a plain structure - so the action carries this
   * key and the provider looks the fix back up.
   */
  key: string;
  /** Shown on the lightbulb and in the fix picker. */
  title: string;
  action: HygieneFixAction;
}

export interface HygieneFinding {
  /** The rule that produced it. Becomes the diagnostic's `code`. */
  code: string;
  severity: HygieneSeverity;
  message: string;
  /** The beads the finding is about. Drives stable ordering. */
  beadIds: string[];
  fix?: HygieneFix;
}

/** Everything a rule is allowed to read. */
export interface HygieneContext {
  /** The derived graph, when a surface has produced one. */
  graph: BeadsGraphModel | null;
  /**
   * Runs `bd <args> --json` and resolves the parsed payload.
   *
   * Rejects when bd fails. A rule does not catch that: one rule failing is not
   * a reason to lose the findings of the rules that succeeded, so the runner
   * isolates failures instead of every rule repeating the same try/catch.
   */
  runBdJson(args: string[]): Promise<unknown>;
  /** `bd stale --days`. */
  staleDays: number;
  /** `bd find-duplicates --threshold`. */
  similarityThreshold: number;
  /** Clock seam, so "not updated in N days" is testable. */
  now: number;
}

export interface HygieneRule {
  /** Machine-readable tag on every finding, and the Problems panel's code. */
  code: string;
  /** Human name, used in logs and in the run summary. */
  title: string;
  tier: HygieneTier;
  run(context: HygieneContext): HygieneFinding[] | Promise<HygieneFinding[]>;
}

/**
 * How many ids a message names before it summarizes the rest. A tangle of forty
 * beads is a real condition; a forty-id message is not a readable one.
 */
export const MAX_NAMED_MEMBERS = 10;

/**
 * How many per-bead findings one rule may publish.
 *
 * A project with six hundred beads missing an acceptance-criteria heading is
 * one finding repeated six hundred times, and six hundred Problems rows is a
 * panel nobody reads again. The overflow collapses into a single row.
 */
export const MAX_FINDINGS_PER_RULE = 20;

/** "a, b, c, and 4 more" - the readable form of an unbounded id list. */
export function nameList(ids: readonly string[], max = MAX_NAMED_MEMBERS): string {
  const named = ids.slice(0, max).join(", ");
  const hidden = ids.length - max;
  return hidden > 0 ? `${named}, and ${hidden} more` : named;
}

/** "1 bead" / "3 beads", so no message has to say "1 bead(s)". */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
