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

/**
 * The graph is usually open beside a terminal running `bd`, and for a long time
 * nothing told it that a dependency was added or a bead closed - the CLI backend
 * had no change token to watch. Five seconds was short enough that the picture
 * tracked the work, long enough that it cost one read per tab per five seconds.
 *
 * This is now the fallback rather than the mechanism. Where the project has its
 * events journal switched on, `bd events tail --follow` pushes each mutation and
 * the graph redraws on the change instead of on the clock; this interval is what
 * it drops back to when there is no journal to subscribe to.
 */
const GRAPH_POLL_INTERVAL_MS = 5000;

/**
 * What the poll becomes once the feed is live.
 *
 * Not zero, and deliberately so: raw `bd sql` writes never enter the journal,
 * and rows that arrive by `bd dolt pull` or a merge were not mutated on this
 * replica so they are not journaled here either. A minute is slow enough to be
 * free and fast enough that a synced workspace still converges without anyone
 * hitting refresh.
 */
const GRAPH_LIVE_POLL_INTERVAL_MS = 60000;

export class BeadsGraphPanel extends BeadsPanelHost {
  protected readonly viewType = "beadsGraph";
  protected readonly title = "Beads Graph";
  protected readonly pollIntervalMs = GRAPH_POLL_INTERVAL_MS;
  protected readonly livePollIntervalMs = GRAPH_LIVE_POLL_INTERVAL_MS;

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
