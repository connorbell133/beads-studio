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

  private panel?: vscode.WebviewPanel;

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
      }
    });

    // Drop the reference so a later reveal builds a fresh panel rather than
    // posting into a disposed one.
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  public isOpen(): boolean {
    return this.panel !== undefined;
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
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
    this.loadData(reason);
  }
}
