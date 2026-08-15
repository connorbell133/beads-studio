/**
 * NeedsYouViewProvider - the human inbox.
 *
 * The queue in front of the person, ordered by what leaving it queued costs.
 * Every other surface in this extension answers "what can an agent pick up";
 * this one answers "what can only you unblock, and which one first".
 *
 * It is the only surface that reads coordination beads, so it is also the only
 * one that needs a second backend call: `bd human list` owns the definition of
 * "needs a human", and the graph read owns everything else.
 */

import * as vscode from "vscode";
import { BaseViewProvider } from "./BaseViewProvider";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { WebviewToExtensionMessage } from "../backend/types";
import { buildHumanInbox } from "../graph/human-inbox";
import { Logger } from "../utils/logger";
import type { LoadReason } from "./BeadsWebviewHost";

export class NeedsYouViewProvider extends BaseViewProvider {
  protected readonly viewType = "beadsNeedsYou";
  private loadSequence = 0;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("NeedsYou"));
  }

  protected async loadData(reason: LoadReason = "background"): Promise<void> {
    const thisRequest = ++this.loadSequence;
    const client = this.projectManager.getClient();
    if (!client) {
      this.postMessage({ type: "setBeads", beads: [] });
      this.postMessage({ type: "setHumanNeeded", humanNeeded: { ids: [], supported: true } });
      this.setBadge(0);
      this.setLoading(false);
      return;
    }

    const showLoading = reason !== "background";
    if (showLoading) {
      this.setLoading(true);
    }
    this.setError(null);

    try {
      // Both reads together: the inbox is wrong if the ids and the graph they
      // are scored against come from different moments.
      const [loaded, humanNeeded] = await Promise.all([
        this.loadGraph(),
        client.listHumanNeeded(),
      ]);
      if (thisRequest !== this.loadSequence || !loaded) {
        return;
      }

      this.postMessage({ type: "setBeads", beads: loaded.beads });
      this.postMessage({ type: "setGraph", graph: loaded.model });
      this.postMessage({ type: "setHumanNeeded", humanNeeded });
      this.setBadge(
        buildHumanInbox(loaded.model, loaded.beads, {
          now: Date.now(),
          humanIds: humanNeeded.supported ? humanNeeded.ids : undefined,
        }).rows.length
      );
      this.setLoading(false);
    } catch (err) {
      if (thisRequest !== this.loadSequence) {
        return;
      }
      this.setError(String(err));
      this.handleBackendError("Failed to load the human inbox", err);
    } finally {
      if (thisRequest === this.loadSequence) {
        this.setLoading(false);
      }
    }
  }

  /**
   * The count on the view's own header.
   *
   * This is the whole of the surface's ambition to be noticed: a number where
   * the view already lives, updated when the view refreshes. Notifications and
   * paging are deliberately out of scope - a queue that interrupts you is a
   * different product from a queue you consult.
   *
   * Zero clears the badge rather than showing "0", which would read as an alert
   * for the state of having nothing to do.
   */
  private setBadge(count: number): void {
    if (!this._view) return;
    this._view.badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} ${count === 1 ? "decision needs" : "decisions need"} you`,
          }
        : undefined;
  }

  protected async handleCustomMessage(message: WebviewToExtensionMessage): Promise<void> {
    const client = this.projectManager.getClient();
    if (!client) {
      return;
    }

    switch (message.type) {
      case "humanRespond":
        try {
          await client.humanRespond({ id: message.beadId, response: message.text });
          this.postMessage({ type: "showToast", text: `Responded to ${message.beadId}` });
          await this.projectManager.refresh();
          await this.loadData("manualRefresh");
        } catch (err) {
          // Surfaced as a notification rather than swallowed into the view: the
          // row disappears on success, so a silent failure looks like success.
          await this.log.errorNotify(
            `Failed to respond to ${message.beadId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        break;

      case "humanDismiss":
        try {
          await client.humanDismiss({ id: message.beadId, reason: message.reason });
          this.postMessage({ type: "showToast", text: `Dismissed ${message.beadId}` });
          await this.projectManager.refresh();
          await this.loadData("manualRefresh");
        } catch (err) {
          await this.log.errorNotify(
            `Failed to dismiss ${message.beadId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        break;
    }
  }
}
