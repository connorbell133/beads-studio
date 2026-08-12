/**
 * BaseViewProvider - the sidebar half of BeadsWebviewHost.
 *
 * Owns the WebviewView lifecycle: resolution, visibility-driven reload, and the
 * refresh entry points the extension calls when project state changes.
 * Everything else - HTML, messages, loading state, the graph read - lives in
 * BeadsWebviewHost so the editor-tab surfaces inherit exactly the same
 * behaviour.
 */

import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { WebviewToExtensionMessage } from "../backend/types";
import { Logger } from "../utils/logger";
import { BeadsWebviewHost } from "./BeadsWebviewHost";

export abstract class BaseViewProvider
  extends BeadsWebviewHost
  implements vscode.WebviewViewProvider
{
  protected _view?: vscode.WebviewView;

  protected get webview(): vscode.Webview | undefined {
    return this._view?.webview;
  }

  protected get isVisible(): boolean {
    return this._view?.visible ?? false;
  }

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.localResourceRoots(),
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      await this.handleMessage(message);
    });

    // Refresh data when the view becomes visible again (e.g., after being hidden)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.initializeView();
      }
    });

    // Note: We don't call initializeView() here because the webview's React app
    // hasn't loaded yet. Instead, we wait for the "ready" message from the webview
    // (handled in handleMessage) which indicates the app is ready to receive data.
  }

  /** Triggers a background refresh of the view. */
  public refresh(): void {
    this.reloadWithProjectContext("background");
  }

  public hardRefresh(): void {
    this.reloadWithProjectContext("manualRefresh");
  }

  /** Refresh intended for active project switches. */
  public refreshForProjectChange(): void {
    this.reloadWithProjectContext("projectChange");
  }

  private reloadWithProjectContext(
    reason: "background" | "manualRefresh" | "projectChange"
  ): void {
    if (!this.isVisible) {
      return;
    }

    // Project state travels with every refresh so the dropdown's status
    // indicators stay current even when the data itself has not changed.
    this.postMessage({ type: "setProject", project: this.projectManager.getActiveProject() });
    this.postMessage({ type: "setProjects", projects: this.projectManager.getProjects() });

    this.loadData(reason);
  }
}
