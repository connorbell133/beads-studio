/**
 * DashboardViewProvider - Provides the Dashboard summary view
 *
 * Features:
 * - Summary cards with counts by status
 * - Priority breakdown
 * - Ready/blocked/in-progress sections
 * - Quick access to important beads
 */

import * as vscode from "vscode";
import { BaseViewProvider } from "./BaseViewProvider";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { BeadsSummary, BUILT_IN_STATUSES } from "../backend/types";
import { deriveSummary } from "../graph/summary";
import { BecameReadyEvent, diffReady, pruneEvents } from "../graph/pulse";
import { Logger } from "../utils/logger";

export class DashboardViewProvider extends BaseViewProvider {
  protected readonly viewType = "beadsDashboard";
  private static readonly MIN_LOADING_MS = 500;
  private loadSequence = 0;
  /** Ready ids at the previous load; null until a baseline exists. */
  private prevReady: Set<string> | null = null;
  private becameReady: BecameReadyEvent[] = [];

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("Dashboard"));
  }

  protected async loadData(reason: "initial" | "projectChange" | "manualRefresh" | "background" = "background"): Promise<void> {
    const thisRequest = ++this.loadSequence;
    if (reason === "projectChange") {
      // Another project's ready set is not a baseline for this one.
      this.prevReady = null;
      this.becameReady = [];
    }
    const client = this.projectManager.getClient();
    if (!client) {
      this.postMessage({
        type: "setSummary",
        summary: {
          total: 0,
          byStatus: Object.fromEntries(BUILT_IN_STATUSES.map((s) => [s, 0])),
          byPriority: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
          readyCount: 0,
          blockedCount: 0,
          inProgressCount: 0,
          degraded: false,
        },
      });
      // No project/backend: clear loading so the webview shows the empty state
      // instead of spinning forever (#76)
      this.postMessage({ type: "setBeads", beads: [] });
      this.setLoading(false);
      return;
    }

    const showLoading = reason === "initial" || reason === "projectChange" || reason === "manualRefresh";
    const loadingStartedAt = showLoading ? Date.now() : 0;
    if (showLoading) {
      this.postMessage({ type: "setSummary", summary: null });
      this.postMessage({ type: "setBeads", beads: [] });
      this.setLoading(true);
    }
    this.setError(null);

    try {
      const loaded = await this.loadGraph();
      if (showLoading) {
        await this.waitForMinimumLoading(loadingStartedAt);
      }
      if (thisRequest !== this.loadSequence || !loaded) {
        return;
      }

      const { beads, model } = loaded;
      const summary = deriveSummary(beads, model, BUILT_IN_STATUSES) as BeadsSummary;

      this.postMessage({ type: "setSummary", summary });
      this.postMessage({ type: "setGraph", graph: model });

      // The full set, not a highlight subset: the pulse needs closed beads
      // and honest label counts, and the webview derives its own slices.
      this.postMessage({ type: "setBeads", beads });

      // The one fact only this process can know: which ids became ready
      // between two loads. The webview turns it into "newly ready" via
      // computePulse; the first load is baseline only.
      const readyNow = new Set(model.ready);
      const at = Date.now();
      if (this.prevReady) {
        this.becameReady = pruneEvents(
          [...this.becameReady, ...diffReady(this.prevReady, model.ready, at)],
          at
        );
      }
      this.prevReady = readyNow;
      this.postMessage({ type: "setPulse", events: this.becameReady });
      this.setLoading(false);
    } catch (err) {
      if (showLoading) {
        await this.waitForMinimumLoading(loadingStartedAt);
      }
      if (thisRequest !== this.loadSequence) {
        return;
      }
      this.setError(String(err));
      this.handleBackendError("Failed to load dashboard", err);
    } finally {
      if (thisRequest === this.loadSequence) {
        this.setLoading(false);
      }
    }
  }

  private async waitForMinimumLoading(startedAt: number): Promise<void> {
    const remaining = DashboardViewProvider.MIN_LOADING_MS - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
}
