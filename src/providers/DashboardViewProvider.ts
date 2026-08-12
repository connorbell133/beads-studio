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
import { Logger } from "../utils/logger";

export class DashboardViewProvider extends BaseViewProvider {
  protected readonly viewType = "beadsDashboard";
  private static readonly MIN_LOADING_MS = 500;
  private loadSequence = 0;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("Dashboard"));
  }

  protected async loadData(reason: "initial" | "projectChange" | "manualRefresh" | "background" = "background"): Promise<void> {
    const thisRequest = ++this.loadSequence;
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

      // The highlight lists now follow the graph too: "ready" is what a person
      // can actually pick up, not everything wearing the `open` label, and
      // "blocked" is derived from open blockers rather than a status someone
      // remembered to set.
      const byId = new Map(beads.map((bead) => [bead.id, bead]));
      const pick = (ids: string[]) =>
        ids
          .map((id) => byId.get(id))
          .filter((bead): bead is (typeof beads)[number] => Boolean(bead))
          .slice(0, 5);
      const inProgressBeads = beads.filter((b) => b.status === "in_progress").slice(0, 5);

      this.postMessage({
        type: "setBeads",
        beads: [...pick(model.ready), ...pick(model.blocked), ...inProgressBeads],
      });
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
