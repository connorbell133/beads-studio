/**
 * BeadsWebviewHost - everything a Beads webview does regardless of where it lives.
 *
 * HTML generation, message routing, loading/error state, and the shared
 * load-and-derive path are identical whether the surface is a 300px sidebar view
 * or a full editor tab. Only the lifecycle differs, so only the lifecycle is
 * subclassed: BaseViewProvider owns the WebviewView side, BeadsPanelHost owns
 * the WebviewPanel side.
 */

import * as path from "path";
import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import {
  Bead,
  BeadsProject,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  issueToWebviewBead,
} from "../backend/types";
import { deriveGraph } from "../graph/BeadsGraph";
import { BeadsGraphModel } from "../graph/types";
import { Logger } from "../utils/logger";
import { resolveEnvVariables } from "../utils/resolve-env-variables";

export type LoadReason = "initial" | "projectChange" | "manualRefresh" | "background";

export abstract class BeadsWebviewHost {
  /**
   * Observers notified whenever any surface derives a fresh graph.
   *
   * Static because the consumers are extension-global - there is one Problems
   * collection for the workspace, not one per view - and because every surface
   * already derives on its own refresh, so hanging the notification off the
   * derive avoids a second read just to feed them.
   */
  private static readonly graphObservers: Array<
    (model: BeadsGraphModel, project: BeadsProject | null) => void
  > = [];

  public static observeGraph(
    observer: (model: BeadsGraphModel, project: BeadsProject | null) => void
  ): vscode.Disposable {
    BeadsWebviewHost.graphObservers.push(observer);
    return {
      dispose: () => {
        const index = BeadsWebviewHost.graphObservers.indexOf(observer);
        if (index >= 0) BeadsWebviewHost.graphObservers.splice(index, 1);
      },
    };
  }

  protected readonly extensionUri: vscode.Uri;
  protected readonly projectManager: BeadsProjectManager;
  protected readonly log: Logger;
  protected abstract readonly viewType: string;

  /** The live webview, when this host currently has a surface. */
  protected abstract get webview(): vscode.Webview | undefined;

  /** Whether that surface is on screen. Hidden surfaces skip loading. */
  protected abstract get isVisible(): boolean;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    this.extensionUri = extensionUri;
    this.projectManager = projectManager;
    this.log = logger;
  }

  /** Loads surface-specific data. Override in subclasses. */
  protected abstract loadData(reason?: LoadReason): Promise<void>;

  /**
   * One complete read plus one derivation, shared by every surface.
   *
   * Every view goes through here so the CLI and Dolt paths cannot drift and no
   * view recomputes readiness its own way. Returns null when there is no
   * backend client - the caller decides which empty state to show.
   */
  protected async loadGraph(): Promise<{ beads: Bead[]; model: BeadsGraphModel } | null> {
    const client = this.projectManager.getClient();
    if (!client) return null;

    const payload = await client.listGraph();
    const beads = payload.nodes
      .map(issueToWebviewBead)
      .filter((bead): bead is Bead => bead !== null);
    const model = deriveGraph(payload.nodes, payload.edges, { complete: payload.complete });

    const project = this.projectManager.getActiveProject();
    for (const observer of BeadsWebviewHost.graphObservers) {
      try {
        observer(model, project);
      } catch (error) {
        // An observer must never take down a view's data load.
        this.log.debug(`Graph observer failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { beads, model };
  }

  /** Sends the context every surface needs, then loads if it is on screen. */
  protected async initializeView(): Promise<void> {
    if (!this.webview) {
      return;
    }

    this.postMessage({ type: "setViewType", viewType: this.viewType });
    this.postMessage({ type: "setProject", project: this.projectManager.getActiveProject() });
    this.postMessage({ type: "setProjects", projects: this.projectManager.getProjects() });

    const config = vscode.workspace.getConfiguration("beads");
    // User ID: prefer setting, fallback to $USER, then "unknown"
    const rawUserId = config.get<string>("userId", "");
    const userId =
      resolveEnvVariables(rawUserId || "") ||
      process.env.USER ||
      process.env.USERNAME ||
      "unknown";
    this.postMessage({
      type: "setSettings",
      settings: {
        renderMarkdown: config.get<boolean>("renderMarkdown", true),
        userId,
        tooltipHoverDelay: config.get<number>("tooltipHoverDelay", 1000),
      },
    });

    if (this.isVisible) {
      await this.loadData("initial");
    }
  }

  /** Handles messages from the webview. Override handleCustomMessage to extend. */
  protected async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.initializeView();
        break;

      case "refresh":
        await this.loadData("manualRefresh");
        break;

      case "selectProject": {
        let switched = await this.projectManager.setActiveProject(message.projectId);
        if (!switched && message.projectRootPath) {
          const fallback = this.projectManager
            .getProjects()
            .find((project) => project.rootPath === message.projectRootPath);
          if (fallback) {
            switched = await this.projectManager.setActiveProject(fallback.id);
          }
        }
        break;
      }

      case "selectBead":
        vscode.commands.executeCommand("beads.openBeadDetails", message.beadId);
        break;

      case "showDoltStatus":
        vscode.commands.executeCommand("beads.showDoltStatus");
        break;

      case "startDoltServer":
        vscode.commands.executeCommand("beads.startDoltServer");
        break;

      case "stopDoltServer":
        vscode.commands.executeCommand("beads.stopDoltServer");
        break;

      case "openDoltLog":
        vscode.commands.executeCommand("beads.openDoltLog");
        break;

      case "openProjectFolder": {
        const project = this.projectManager.getActiveProject();
        if (project) {
          await vscode.commands.executeCommand(
            "revealInExplorer",
            vscode.Uri.file(project.rootPath)
          );
        }
        break;
      }

      case "openBeadDetails":
        vscode.commands.executeCommand("beads.openBeadDetails", message.beadId);
        break;

      case "viewInGraph":
        vscode.commands.executeCommand("beads.openGraph", message.beadId);
        break;

      case "copyBeadId":
        if (message.beadId) {
          await vscode.env.clipboard.writeText(message.beadId);
          vscode.window.setStatusBarMessage(`$(check) Copied: ${message.beadId}`, 2000);
        }
        break;

      case "openFile":
        await this.handleOpenFile(message.filePath, message.line);
        break;

      case "openIssuesPreset":
        vscode.commands.executeCommand("beads.openIssuesWithPreset", message.presetId);
        break;

      case "openGraph":
        vscode.commands.executeCommand("beads.openGraph");
        break;

      default:
        await this.handleCustomMessage(message);
    }
  }

  /** Override in subclasses to handle surface-specific messages. */
  protected async handleCustomMessage(_message: WebviewToExtensionMessage): Promise<void> {
    // Default: do nothing
  }

  /** Opens a file in the editor, optionally at a specific line. */
  private async handleOpenFile(filePath: string, line?: number): Promise<void> {
    const project = this.projectManager.getActiveProject();
    if (!project) {
      vscode.window.showWarningMessage("No active project");
      return;
    }

    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : vscode.Uri.joinPath(vscode.Uri.file(project.rootPath), filePath).fsPath;

    const fileUri = vscode.Uri.file(resolvedPath);

    try {
      await vscode.workspace.fs.stat(fileUri);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc);

      if (line !== undefined && line > 0) {
        const lineIndex = line - 1; // VS Code uses 0-based line numbers
        const position = new vscode.Position(lineIndex, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
    }
  }

  /**
   * Reflects a selection change made anywhere in the extension.
   *
   * `origin` names the surface that caused it, so a surface that already shows
   * the bead where the user clicked can skip revealing it again.
   */
  public applySelection(beadId: string | null, origin: string): void {
    this.postMessage({ type: "setSelectedBeadId", beadId, origin });
  }

  /** Sends a message to the webview. A disposed surface silently drops it. */
  protected postMessage(message: ExtensionToWebviewMessage): void {
    this.webview?.postMessage(message);
  }

  protected setLoading(loading: boolean): void {
    this.postMessage({ type: "setLoading", loading });
  }

  protected setError(error: string | null): void {
    this.postMessage({ type: "setError", error });
  }

  /**
   * Logs a backend failure and lets ProjectManager own the notification.
   * Surfaces show their own error state; the notification is centralized.
   */
  protected handleBackendError(message: string, err: unknown): void {
    this.log.error(`${message}: ${err}`);
    this.projectManager.notifyBackendError(err);
  }

  protected getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js")
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css")
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>Beads</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  protected localResourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, "dist"),
      vscode.Uri.joinPath(this.extensionUri, "resources"),
    ];
  }

  private getNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
