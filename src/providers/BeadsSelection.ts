/**
 * BeadsSelection - the one selected bead, shared by every surface.
 *
 * After Phase 1 the extension has six live surfaces: dashboard, issues list,
 * tree mode, ready lane, graph tab, and details. Six surfaces each holding
 * their own selection is six places to lose your place, so selection lives
 * here and is broadcast.
 *
 * Changes carry the surface that caused them. A surface that originated a
 * change already shows the bead where the user clicked; scrolling it again
 * fights the user. Only surfaces that did not originate the change reveal it.
 */

import * as vscode from "vscode";

export interface SelectionChange {
  beadId: string | null;
  /** viewType of the surface that caused this, or a command name. */
  origin: string;
}

export class BeadsSelection implements vscode.Disposable {
  private current: string | null = null;
  private readonly emitter = new vscode.EventEmitter<SelectionChange>();

  public readonly onDidChange = this.emitter.event;

  public get selected(): string | null {
    return this.current;
  }

  /**
   * Selects a bead. Re-selecting the same bead is a no-op so a refresh loop
   * cannot bounce every surface back to the top of its list.
   */
  public select(beadId: string | null, origin: string): void {
    if (this.current === beadId) {
      return;
    }
    this.current = beadId;
    this.emitter.fire({ beadId, origin });
  }

  /** Clears selection, e.g. when the active project changes. */
  public clear(origin: string): void {
    this.select(null, origin);
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}
