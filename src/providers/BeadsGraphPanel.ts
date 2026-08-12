/**
 * BeadsGraphPanel - the dependency graph in an editor tab.
 *
 * "View in graph" has existed as a button since before there was a graph view
 * to open; two call sites ran `beadsGraph.focus` against a view that was never
 * registered. This is the surface those buttons were always pointing at.
 */

import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { Logger } from "../utils/logger";
import { BeadsPanelHost, LoadReason } from "./BeadsPanelHost";

export class BeadsGraphPanel extends BeadsPanelHost {
  protected readonly viewType = "beadsGraph";
  protected readonly title = "Beads Graph";

  private focusBeadId: string | null = null;
  private loadSequence = 0;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("Graph"));
  }

  /** Opens the graph, optionally centred on a bead. */
  public show(beadId?: string): void {
    this.focusBeadId = beadId ?? null;
    const alreadyOpen = this.isOpen();
    this.reveal();
    // A fresh panel loads via its ready message; an open one needs telling that
    // the focus target moved.
    if (alreadyOpen) {
      this.postMessage({ type: "setSelectedBeadId", beadId: this.focusBeadId });
      this.loadData("manualRefresh");
    }
  }

  /**
   * Asks the graph surface to open its find affordance.
   *
   * The command palette is where VS Code users already look for an accelerator,
   * so "find in graph" is a command rather than only a button in the tab.
   */
  public requestFind(): void {
    this.postMessage({ type: "focusGraphFind" });
  }

  protected async loadData(reason: LoadReason = "background"): Promise<void> {
    const thisRequest = ++this.loadSequence;
    const showLoading = reason !== "background";

    if (showLoading) {
      this.setLoading(true);
    }
    this.setError(null);

    try {
      const loaded = await this.loadGraph();
      if (thisRequest !== this.loadSequence) {
        return;
      }
      if (!loaded) {
        this.postMessage({ type: "setBeads", beads: [] });
        this.setLoading(false);
        return;
      }

      this.postMessage({ type: "setBeads", beads: loaded.beads });
      this.postMessage({ type: "setGraph", graph: loaded.model });
      this.postMessage({ type: "setSelectedBeadId", beadId: this.focusBeadId });
      this.setLoading(false);
    } catch (err) {
      if (thisRequest !== this.loadSequence) {
        return;
      }
      this.setError(String(err));
      this.handleBackendError("Failed to load graph", err);
    } finally {
      if (thisRequest === this.loadSequence) {
        this.setLoading(false);
      }
    }
  }
}
