/**
 * BeadsDiagnostics - dependency cycles as Problems panel entries.
 *
 * A cycle used to surface as a tree that expanded forever, which reads as a UI
 * bug rather than the data defect it is. The graph model already finds them
 * (`BeadsGraphModel.cycles`, one entry per strongly connected component), so
 * this class only has to publish them somewhere a user already looks.
 *
 * Beads are not files, so there is nothing to anchor a diagnostic to in the
 * usual sense. Each finding is anchored on the project's `.beads` directory
 * with the tangled ids named in the message - the directory is the closest
 * thing the project has to a location, and the ids are the actionable part.
 */

import * as vscode from "vscode";
import { BeadsProject } from "../backend/types";
import { BeadsGraphModel } from "../graph/types";
import { Logger } from "../utils/logger";

/** Shown in the Problems panel's source column. */
export const DIAGNOSTIC_SOURCE = "beads";

/** Machine-readable tag on every cycle finding. */
export const CYCLE_DIAGNOSTIC_CODE = "dependency-cycle";

/**
 * How many ids a message names before it summarizes the rest. A tangle of
 * forty beads is a real condition; a forty-id message is not a readable one.
 */
const MAX_NAMED_MEMBERS = 10;

export class BeadsDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly log: Logger;

  /** The project the current entries belong to, so a switch can clear them. */
  private publishedFor: string | null = null;
  private disposed = false;

  constructor(logger: Logger) {
    this.log = logger.child("Diagnostics");
    this.collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  }

  /**
   * Republishes the cycle findings for `project` from `model`.
   *
   * Safe to call on every derive: it is a full replacement, not an append, so a
   * cycle that was resolved between two refreshes disappears on the second.
   */
  public update(
    model: BeadsGraphModel | null | undefined,
    project: BeadsProject | null | undefined
  ): void {
    if (this.disposed) return;

    const projectId = project ? project.id : null;
    // A switch clears first: the outgoing project's ids mean nothing under the
    // incoming one, and its `.beads` uri would otherwise linger in Problems.
    if (projectId !== this.publishedFor) {
      this.collection.clear();
      this.publishedFor = projectId;
    }

    if (!project || !model) {
      return;
    }

    const uri = this.anchorUri(project);
    if (!uri) {
      this.log.warn(`Project ${project.id} has no path to anchor diagnostics on`);
      return;
    }

    const cycles = normalizeCycles(model.cycles);
    if (cycles.length === 0) {
      this.collection.delete(uri);
      return;
    }

    this.collection.set(
      uri,
      cycles.map((members) => buildCycleDiagnostic(members))
    );
    this.log.debug(
      `Published ${cycles.length} dependency cycle${cycles.length === 1 ? "" : "s"} for ${project.id}`
    );
  }

  /** Removes every published finding. Used on teardown and no-project states. */
  public clear(): void {
    if (this.disposed) return;
    this.collection.clear();
    this.publishedFor = null;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.publishedFor = null;
    this.collection.dispose();
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
 * Sorts within and across cycles so the same tangle publishes in the same order
 * on every refresh - Tarjan emits components in traversal order, which shifts
 * as unrelated beads come and go.
 */
function normalizeCycles(cycles: string[][] | undefined): string[][] {
  if (!cycles) return [];
  return cycles
    .filter((members) => members && members.length > 0)
    .map((members) => [...members].sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function buildCycleDiagnostic(members: string[]): vscode.Diagnostic {
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
  const diagnostic = new vscode.Diagnostic(
    range,
    cycleMessage(members),
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = CYCLE_DIAGNOSTIC_CODE;
  return diagnostic;
}

/** Orientation, then consequence, then the action that resolves it. */
function cycleMessage(members: string[]): string {
  if (members.length === 1) {
    return (
      `Dependency cycle: ${members[0]} blocks itself. ` +
      `It cannot become ready until that blocks edge is removed.`
    );
  }

  const named = members.slice(0, MAX_NAMED_MEMBERS).join(", ");
  const hidden = members.length - MAX_NAMED_MEMBERS;
  const list = hidden > 0 ? `${named}, and ${hidden} more` : named;

  return (
    `Dependency cycle: ${members.length} beads block each other - ${list}. ` +
    `None of them can become ready until one of those blocks edges is removed.`
  );
}
