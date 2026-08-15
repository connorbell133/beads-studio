/**
 * BeadsPlanIntakePanel - composing an epic, in an editor tab.
 *
 * The extension had no creation surface at all: every command read, navigated,
 * or focused, so a freshly initialized project rendered as a read-only empty
 * app until something else wrote the first issue. This is the first one that
 * writes.
 *
 * It is a whole epic rather than a "new issue" dialog because a dialog is the
 * one shape this does not need: the interesting authoring verb here is
 * decomposing work into a dependency-ordered epic, and the mistakes that verb
 * produces are edges pointing the wrong way. Those are invisible in a form and
 * obvious in a picture, which is why the tab is wide enough to hold one.
 *
 * No polling: the draft is client-side and nothing outside the tab can change
 * it, so a background re-read would only ever throw work away.
 */

import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { PlanDraft } from "../backend/plan-draft";
import { WebviewToExtensionMessage } from "../backend/types";
import { Logger } from "../utils/logger";
import { BeadsPanelHost, LoadReason } from "./BeadsPanelHost";

export class BeadsPlanIntakePanel extends BeadsPanelHost {
  protected readonly viewType = "beadsPlanIntake";
  protected readonly title = "New Epic";

  /** Guards against a second commit while the first batch is still running. */
  private committing = false;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("PlanIntake"));
  }

  public show(): void {
    this.reveal();
  }

  /**
   * Nothing to load.
   *
   * The composer starts empty by design - it is not editing anything that
   * exists - so the only state it needs is the project context every surface
   * already receives on ready.
   */
  protected async loadData(_reason: LoadReason = "background"): Promise<void> {
    this.setLoading(false);
  }

  protected async handleCustomMessage(message: WebviewToExtensionMessage): Promise<void> {
    if (message.type !== "commitPlanDraft") {
      await super.handleCustomMessage(message);
      return;
    }

    await this.commit(message.draft);
  }

  private async commit(draft: PlanDraft): Promise<void> {
    if (this.committing) {
      this.log.debug("Ignoring a commit while one is already in flight");
      return;
    }

    const client = this.projectManager.getClient();
    if (!client) {
      this.postMessage({
        type: "setPlanCommitState",
        state: { phase: "failed", message: "No active Beads project.", createdIds: [] },
      });
      return;
    }

    this.committing = true;
    this.postMessage({ type: "setPlanCommitState", state: { phase: "committing" } });

    try {
      const result = await client.createPlanEpic(draft);

      if (!result.ok) {
        this.log.warn(`Plan commit failed at ${result.stage}: ${result.message}`);
        this.postMessage({
          type: "setPlanCommitState",
          state: {
            phase: "failed",
            message: result.message,
            createdIds: result.createdIds,
          },
        });
        // Issues that survived a failed link step are real work the user now
        // owns; every other surface has to show them before the retry.
        if (result.createdIds.length > 0) {
          await this.projectManager.refresh();
        }
        return;
      }

      this.log.info(
        `Created epic ${result.epicId} with ${result.taskCount} tasks and ${result.edgeCount} blocking links`
      );
      this.postMessage({
        type: "setPlanCommitState",
        state: {
          phase: "committed",
          epicId: result.epicId,
          taskCount: result.taskCount,
          edgeCount: result.edgeCount,
        },
      });

      await this.projectManager.refresh();

      // Not awaited: the notification lives until the user dismisses it, and
      // holding the commit open that long would keep the composer disabled.
      void (async () => {
        const action = await vscode.window.showInformationMessage(
          `Created ${result.epicId}: ${result.taskCount} ${
            result.taskCount === 1 ? "task" : "tasks"
          }, ${result.edgeCount} blocking ${result.edgeCount === 1 ? "link" : "links"}.`,
          "Open in graph"
        );
        if (action === "Open in graph") {
          vscode.commands.executeCommand("beads.openGraph", result.epicId);
        }
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Plan commit threw: ${message}`);
      this.postMessage({
        type: "setPlanCommitState",
        state: { phase: "failed", message, createdIds: [] },
      });
    } finally {
      this.committing = false;
    }
  }
}
