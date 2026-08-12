import * as vscode from "vscode";

// Read the recorder through the same specifier the code under test uses.
// Importing "../../__mocks__/vscode" directly can resolve to a second module
// instance - jest only dedupes the two specifiers when another suite happened
// to instantiate the module first in the same worker, which made these tests
// pass or fail depending on worker assignment.
const { createdPanels } = vscode as unknown as {
  createdPanels: Array<{
    viewType: string;
    posted: unknown[];
    revealCount: number;
    webview: { html: string };
    fireDispose: () => void;
  }>;
};
import { BeadsPanelHost, LoadReason } from "../BeadsPanelHost";
import { BeadsProjectManager } from "../../backend/BeadsProjectManager";
import { Logger } from "../../utils/logger";

class TestPanel extends BeadsPanelHost {
  protected readonly viewType = "beadsTestPanel";
  protected readonly title = "Test Panel";
  public loadCalls: Array<LoadReason | undefined> = [];

  protected async loadData(reason?: LoadReason): Promise<void> {
    this.loadCalls.push(reason);
  }

  public post(message: Parameters<TestPanel["publicPost"]>[0]): void {
    this.publicPost(message);
  }

  private publicPost(message: Parameters<BeadsPanelHost["postMessage"]>[0]): void {
    (this as unknown as { postMessage: (m: unknown) => void }).postMessage(message);
  }
}

function createPanel() {
  const projectManager = {
    getClient: () => null,
    getActiveProject: () => ({ id: "p1", rootPath: "/repo", name: "repo" }),
    getProjects: () => [{ id: "p1", rootPath: "/repo", name: "repo" }],
  } as unknown as BeadsProjectManager;

  const logger = new Logger(
    vscode.window.createOutputChannel() as unknown as vscode.LogOutputChannel
  );
  return new TestPanel({ fsPath: "/ext" } as vscode.Uri, projectManager, logger);
}

describe("BeadsPanelHost", () => {
  beforeEach(() => {
    createdPanels.length = 0;
  });

  it("creates a panel on first reveal and renders the webview html", () => {
    const panel = createPanel();

    panel.reveal();

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].viewType).toBe("beadsTestPanel");
    expect(createdPanels[0].webview.html).toContain("<div id=\"root\"></div>");
  });

  it("reveals the existing panel rather than opening a second copy", () => {
    const panel = createPanel();

    panel.reveal();
    panel.reveal();
    panel.reveal();

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].revealCount).toBe(2);
  });

  it("builds a fresh panel after the previous one is disposed", () => {
    const panel = createPanel();

    panel.reveal();
    createdPanels[0].fireDispose();
    panel.reveal();

    expect(createdPanels).toHaveLength(2);
    expect(panel.isOpen()).toBe(true);
  });

  it("reports closed before opening and after disposal", () => {
    const panel = createPanel();
    expect(panel.isOpen()).toBe(false);

    panel.reveal();
    expect(panel.isOpen()).toBe(true);

    panel.dispose();
    expect(panel.isOpen()).toBe(false);
  });

  it("does not throw when a message arrives after disposal", () => {
    const panel = createPanel();
    panel.reveal();
    panel.dispose();

    expect(() => panel.post({ type: "setLoading", loading: true })).not.toThrow();
  });

  it("does not throw when refreshed before ever being opened", () => {
    const panel = createPanel();

    expect(() => panel.refresh()).not.toThrow();
    expect(panel.loadCalls).toEqual([]);
  });

  it("sends project context alongside each refresh", () => {
    const panel = createPanel();
    panel.reveal();

    panel.refresh();

    const types = createdPanels[0].posted.map((m) => (m as { type: string }).type);
    expect(types).toContain("setProject");
    expect(types).toContain("setProjects");
    expect(panel.loadCalls).toEqual(["background"]);
  });

  it("distinguishes the three refresh reasons", () => {
    const panel = createPanel();
    panel.reveal();

    panel.refresh();
    panel.hardRefresh();
    panel.refreshForProjectChange();

    expect(panel.loadCalls).toEqual(["background", "manualRefresh", "projectChange"]);
  });
});
