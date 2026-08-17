/**
 * BeadsPanelHost - the editor-tab half of BeadsWebviewHost.
 *
 * A DAG, a board with swimlanes, a full-page bead editor: none of them fit in a
 * 300px sidebar, and that constraint has quietly shaped the whole extension.
 * This gives any view an editor tab to live in, with the same messages, HTML,
 * and graph read the sidebar views use.
 *
 * Single-instance by design: opening an already-open panel reveals it rather
 * than stacking a second copy of the same view.
 */

import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { WebviewToExtensionMessage } from "../backend/types";
import { Logger } from "../utils/logger";
import { BeadsWebviewHost, LoadReason } from "./BeadsWebviewHost";

export type { LoadReason };

export abstract class BeadsPanelHost extends BeadsWebviewHost {
  /** Tab title. */
  protected abstract readonly title: string;

  /**
   * How often, in ms, to re-read while this panel is on screen and nothing is
   * telling it about changes. `0` disables it, which is the default: only
   * surfaces that show work changing outside the editor - `bd` in a terminal, an
   * agent closing beads - earn the extra reads.
   */
  protected readonly pollIntervalMs: number = 0;

  /**
   * The interval to use instead once the events journal is pushing mutations to
   * us. `0` means "no different", which is the default.
   *
   * This is a safety net, not a poll: it exists only for the writes the journal
   * cannot see - raw `bd sql` DML, and rows that arrive by `bd dolt pull` or a
   * merge rather than by a local mutation. Both are rare and neither is urgent,
   * so the right value here is far longer than pollIntervalMs.
   */
  protected readonly livePollIntervalMs: number = 0;

  private panel?: vscode.WebviewPanel;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollInFlight = false;
  private pollTimerIntervalMs = 0;
  private feedSubscription?: vscode.Disposable;

  protected get webview(): vscode.Webview | undefined {
    return this.panel?.webview;
  }

  protected get isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger);
  }

  /**
   * Opens the panel, or brings the existing one forward.
   *
   * `preserveFocus` is false on reveal because opening this is an explicit
   * navigation - the user asked to look at the graph, so put them in it.
   */
  public reveal(column: vscode.ViewColumn = vscode.ViewColumn.Active): void {
    if (this.panel) {
      this.panel.reveal(column);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(this.viewType, this.title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.localResourceRoots(),
    });

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      await this.handleMessage(message);
    });

    this.panel.onDidChangeViewState(() => {
      if (this.panel?.visible) {
        this.loadData("background");
        this.startPolling();
      } else {
        // A tab in the background is a tab nobody is reading. Stop paying for
        // it; becoming visible again loads once and resumes the timer.
        this.stopPolling();
      }
    });

    // Drop the reference so a later reveal builds a fresh panel rather than
    // posting into a disposed one.
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.stopPolling();
      this.unsubscribeFromChangeFeed();
    });

    this.subscribeToChangeFeed();
    this.startPolling();
  }

  /**
   * Retunes the timer when the live feed comes up or goes down.
   *
   * The feed probes asynchronously and can drop out later - a dead `bd events`
   * process, a project switch - so the interval cannot be decided once at
   * reveal. Falling back is meant to be invisible: the timer simply speeds back
   * up.
   */
  private subscribeToChangeFeed(): void {
    if (this.feedSubscription || this.livePollIntervalMs <= 0) return;
    const subscribe = this.projectManager.onChangeFeedStateChanged;
    if (typeof subscribe !== "function") return;

    this.feedSubscription = subscribe((live: boolean) => {
      this.log.debug(
        live
          ? "Live change feed is up; slowing this tab's poll to the safety-net interval"
          : "Live change feed is down; restoring this tab's normal poll"
      );
      this.retunePolling();
    });
  }

  private unsubscribeFromChangeFeed(): void {
    this.feedSubscription?.dispose();
    this.feedSubscription = undefined;
  }

  /**
   * The interval this panel should currently be running at.
   *
   * Never returns 0 while polling is wanted: even a live feed keeps a slow read
   * going, because the journal does not carry `bd sql` writes or merged-in rows.
   */
  private currentPollIntervalMs(): number {
    if (this.pollIntervalMs <= 0) return 0;
    if (this.livePollIntervalMs <= 0) return this.pollIntervalMs;

    const isLive =
      typeof this.projectManager.isLiveChangeFeedActive === "function" &&
      this.projectManager.isLiveChangeFeedActive();
    return isLive ? this.livePollIntervalMs : this.pollIntervalMs;
  }

  private retunePolling(): void {
    if (this.currentPollIntervalMs() === this.pollTimerIntervalMs) return;
    this.stopPolling();
    this.startPolling();
  }

  public isOpen(): boolean {
    return this.panel !== undefined;
  }

  public dispose(): void {
    this.stopPolling();
    this.unsubscribeFromChangeFeed();
    this.panel?.dispose();
    this.panel = undefined;
  }

  /**
   * Keeps the panel current while it is on screen.
   *
   * The poll reads as "background", so it never raises the loading state: the
   * picture the user is reading is replaced only once the new one has arrived,
   * and a poll that returns an unchanged graph is invisible.
   */
  private startPolling(): void {
    const intervalMs = this.currentPollIntervalMs();
    if (this.pollTimer || intervalMs <= 0 || !this.panel?.visible) {
      return;
    }
    this.pollTimerIntervalMs = intervalMs;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, intervalMs);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.pollTimerIntervalMs = 0;
  }

  private async poll(): Promise<void> {
    // A read slower than the interval must not stack reads on top of each
    // other; skip the tick instead and let the one in flight finish.
    if (this.pollInFlight || !this.panel?.visible) {
      return;
    }
    this.pollInFlight = true;
    try {
      await this.loadData("background");
    } catch (error) {
      // loadData owns its own error surface; a poll must never bubble into an
      // unhandled rejection in the timer.
      this.log.debug(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Refresh entry points, mirroring the sidebar providers. */
  public refresh(): void {
    this.reload("background");
  }

  public hardRefresh(): void {
    this.reload("manualRefresh");
  }

  public refreshForProjectChange(): void {
    this.reload("projectChange");
  }

  private reload(reason: LoadReason): void {
    if (!this.panel) {
      return;
    }
    this.postMessage({ type: "setProject", project: this.projectManager.getActiveProject() });
    this.postMessage({ type: "setProjects", projects: this.projectManager.getProjects() });
    // A background refresh of a tab nobody is looking at is a read nobody
    // reads. It matters more now that mutations push refreshes rather than a
    // timer pulling them; becoming visible again loads once, as it always did.
    if (reason === "background" && !this.panel.visible) {
      return;
    }
    this.loadData(reason);
  }
}
