/**
 * BeadsDiagnostics - graph and hygiene defects as Problems panel entries.
 *
 * This started as one hardcoded check. A dependency cycle used to surface as a
 * tree that expanded forever, which reads as a UI bug rather than the data
 * defect it is, so the cycles were published somewhere a user already looks.
 *
 * The panel integration turned out to be the expensive part and the cycle check
 * the cheap one, so this is now a publisher over a rule set (`src/hygiene/`)
 * rather than a cycle detector. Every rule inherits the anchoring, the
 * deterministic ordering, the project-switch invalidation, and the severity
 * mapping. Adding rule N+1 costs a function.
 *
 * Two cadences, because the rules cost different amounts:
 *
 *   `update()` runs the local rules on every graph derive. They read the model
 *   the surfaces already built, so this is the same free path the cycle check
 *   has always been on.
 *
 *   `setShellFindings()` takes the result of an explicit hygiene run. Those
 *   rules each spawn `bd`, so they are never on a repaint path.
 *
 * Both tiers publish into the same collection, so the panel shows one list.
 * Local results replace local results; a hygiene snapshot survives until the
 * next run or a project switch.
 *
 * Beads are not files, so there is nothing to anchor a diagnostic to in the
 * usual sense. Each finding is anchored on the project's `.beads` directory
 * with the ids named in the message - the directory is the closest thing the
 * project has to a location, and the ids are the actionable part.
 */

import * as vscode from "vscode";
import { BeadsProject } from "../backend/types";
import { BeadsGraphModel } from "../graph/types";
import { CYCLE_RULE_CODE, LOCAL_RULES } from "../hygiene/rules";
import {
  HygieneContext,
  HygieneFinding,
  HygieneFix,
  HygieneRule,
  HygieneSeverity,
} from "../hygiene/types";
import { Logger } from "../utils/logger";

/** Shown in the Problems panel's source column. */
export const DIAGNOSTIC_SOURCE = "beads";

/** Machine-readable tag on every cycle finding. Re-exported for callers. */
export const CYCLE_DIAGNOSTIC_CODE = CYCLE_RULE_CODE;

const SEVERITIES: Record<HygieneSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/**
 * A findings key that survives the host boundary.
 *
 * A code action cannot hold onto the `vscode.Diagnostic` instance it was built
 * from - the one handed back to `provideCodeActions` is a reconstruction, not
 * the same object - so fixes are looked up by a value both sides can compute.
 */
export function diagnosticKey(diagnostic: {
  code?: string | number | unknown;
  message: string;
}): string {
  // NUL separates, because a diagnostic message may contain anything a bead
  // title does - including whatever else would have made a plausible delimiter.
  return `${String(diagnostic.code ?? "")}\u0000${diagnostic.message}`;
}

export class BeadsDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly log: Logger;

  /** The project the current entries belong to, so a switch can clear them. */
  private publishedFor: string | null = null;
  private disposed = false;

  /** Findings from the free rules, replaced on every derive. */
  private localFindings: HygieneFinding[] = [];
  /** Findings from the last explicit hygiene run, held until the next one. */
  private shellFindings: HygieneFinding[] = [];
  /** Fixes offered by the currently published findings, by key. */
  private fixes = new Map<string, HygieneFix>();

  constructor(logger: Logger) {
    this.log = logger.child("Diagnostics");
    this.collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  }

  /**
   * Republishes the local-tier findings for `project` from `model`.
   *
   * Safe to call on every derive: it is a full replacement of the local tier,
   * not an append, so a cycle that was resolved between two refreshes
   * disappears on the second.
   */
  public update(
    model: BeadsGraphModel | null | undefined,
    project: BeadsProject | null | undefined
  ): void {
    if (this.disposed) return;

    this.retarget(project);
    if (!project || !model) return;

    // Local rules are synchronous by construction - they read the model and
    // nothing else - so this stays a synchronous publish and a derive never
    // races a repaint.
    this.localFindings = collectSync(LOCAL_RULES, model, (rule, error) => {
      this.log.warn(
        `Hygiene rule ${rule.code} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    this.publish(project);
  }

  /**
   * Replaces the shell-tier findings with the result of an explicit run.
   *
   * Separate from `update()` because these are a snapshot taken when asked, not
   * a live view: they go stale as beads change and are not silently refreshed,
   * because refreshing them means spawning `bd` again.
   */
  public setShellFindings(
    findings: HygieneFinding[],
    project: BeadsProject | null | undefined
  ): void {
    if (this.disposed) return;
    this.retarget(project);
    if (!project) return;

    this.shellFindings = findings;
    this.publish(project);
  }

  /** The fix a published finding offers, if it offers one. */
  public getFix(key: string): HygieneFix | undefined {
    return this.fixes.get(key);
  }

  /** Every fix currently on offer, for the picker path. */
  public listFixes(): HygieneFix[] {
    return [...this.fixes.values()];
  }

  /** Removes every published finding. Used on teardown and no-project states. */
  public clear(): void {
    if (this.disposed) return;
    this.collection.clear();
    this.publishedFor = null;
    this.localFindings = [];
    this.shellFindings = [];
    this.fixes.clear();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.publishedFor = null;
    this.localFindings = [];
    this.shellFindings = [];
    this.fixes.clear();
    this.collection.dispose();
  }

  /**
   * Points the collection at `project`, clearing first when it changed.
   *
   * The outgoing project's ids mean nothing under the incoming one, and its
   * `.beads` uri would otherwise linger in Problems. A hygiene snapshot is
   * dropped on the same boundary rather than being carried across.
   */
  private retarget(project: BeadsProject | null | undefined): void {
    const projectId = project ? project.id : null;
    if (projectId === this.publishedFor) return;

    this.collection.clear();
    this.localFindings = [];
    this.shellFindings = [];
    this.fixes.clear();
    this.publishedFor = projectId;
  }

  private publish(project: BeadsProject): void {
    const uri = this.anchorUri(project);
    if (!uri) {
      this.log.warn(`Project ${project.id} has no path to anchor diagnostics on`);
      return;
    }

    const findings = [...this.localFindings, ...this.shellFindings];

    this.fixes.clear();
    for (const finding of findings) {
      if (finding.fix) this.fixes.set(diagnosticKey(finding), finding.fix);
    }

    if (findings.length === 0) {
      this.collection.delete(uri);
      return;
    }

    this.collection.set(uri, findings.map(toDiagnostic));
    this.log.debug(`Published ${findings.length} hygiene finding(s) for ${project.id}`);
  }

  /**
   * `.beads` is the anchor; the project root is the fallback for the rare
   * project record that carries a root but no resolved beads directory.
   */
  private anchorUri(project: BeadsProject): vscode.Uri | null {
    const path = project.beadsDir || project.rootPath;
    return path ? vscode.Uri.file(path) : null;
  }
}

/**
 * Runs the local rules without awaiting.
 *
 * `HygieneRule.run` may return a promise for the shell tier, but every local
 * rule returns an array, and this keeps `update()` synchronous so the existing
 * derive path is unchanged.
 */
function collectSync(
  rules: readonly HygieneRule[],
  graph: BeadsGraphModel,
  onError: (rule: HygieneRule, error: unknown) => void
): HygieneFinding[] {
  const context = localContext(graph);
  const findings: HygieneFinding[] = [];

  for (const rule of rules) {
    try {
      const result = rule.run(context);
      if (Array.isArray(result)) findings.push(...result);
    } catch (error) {
      onError(rule, error);
    }
  }

  return findings;
}

/** A context a local rule can use: the graph, and nothing that costs anything. */
function localContext(graph: BeadsGraphModel): HygieneContext {
  return {
    graph,
    runBdJson: () => Promise.reject(new Error("local rules cannot shell out")),
    staleDays: 0,
    similarityThreshold: 0,
    now: Date.now(),
  };
}

function toDiagnostic(finding: HygieneFinding): vscode.Diagnostic {
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
  const diagnostic = new vscode.Diagnostic(
    range,
    finding.message,
    SEVERITIES[finding.severity]
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = finding.code;
  return diagnostic;
}
