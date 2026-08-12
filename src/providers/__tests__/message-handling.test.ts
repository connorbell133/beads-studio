import * as vscode from "vscode";
import { BaseViewProvider } from "../BaseViewProvider";
import { BeadsProjectManager } from "../../backend/BeadsProjectManager";
import {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from "../../backend/types";
import { Logger } from "../../utils/logger";

/**
 * Characterization coverage for the shared webview message switch.
 *
 * BaseViewProvider is the spine of every sidebar view and had no coverage of
 * its message routing. These tests pin the behaviour so the panel-host
 * extraction is verifiably behaviour-preserving.
 */

class TestProvider extends BaseViewProvider {
  protected readonly viewType = "beadsTest";
  public loadDataCalls: Array<string | undefined> = [];
  public initializeCalls = 0;

  protected async loadData(reason?: string): Promise<void> {
    this.loadDataCalls.push(reason);
  }

  protected async initializeView(): Promise<void> {
    this.initializeCalls++;
  }

  public handle(message: WebviewToExtensionMessage): Promise<void> {
    return (
      this as unknown as {
        handleMessage: (m: WebviewToExtensionMessage) => Promise<void>;
      }
    ).handleMessage(message);
  }
}

function createProvider() {
  const posted: ExtensionToWebviewMessage[] = [];
  const setActiveProject = jest.fn().mockResolvedValue(true);

  const projectManager = {
    getClient: () => null,
    getActiveProject: () => ({ id: "p1", rootPath: "/repo", name: "repo" }),
    getProjects: () => [{ id: "p1", rootPath: "/repo", name: "repo" }],
    setActiveProject,
  } as unknown as BeadsProjectManager;

  const logger = new Logger(
    vscode.window.createOutputChannel() as unknown as vscode.LogOutputChannel
  );
  const provider = new TestProvider({} as vscode.Uri, projectManager, logger);
  (provider as unknown as { _view: unknown })._view = {
    visible: true,
    webview: { postMessage: (m: ExtensionToWebviewMessage) => posted.push(m) },
  };

  return { provider, posted, setActiveProject };
}

describe("webview message handling", () => {
  let executeCommand: jest.SpyInstance;

  beforeEach(() => {
    executeCommand = jest
      .spyOn(vscode.commands, "executeCommand")
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("initializes the view when the webview reports ready", async () => {
    const { provider } = createProvider();

    await provider.handle({ type: "ready" });

    expect(provider.initializeCalls).toBe(1);
  });

  it("treats an explicit refresh as a manual one", async () => {
    const { provider } = createProvider();

    await provider.handle({ type: "refresh" });

    expect(provider.loadDataCalls).toEqual(["manualRefresh"]);
  });

  it.each([
    ["selectBead", { type: "selectBead", beadId: "bd-1" }, "beads.openBeadDetails", "bd-1"],
    [
      "openBeadDetails",
      { type: "openBeadDetails", beadId: "bd-2" },
      "beads.openBeadDetails",
      "bd-2",
    ],
  ])("routes %s to the details command", async (_name, message, command, arg) => {
    const { provider } = createProvider();

    await provider.handle(message as WebviewToExtensionMessage);

    expect(executeCommand).toHaveBeenCalledWith(command, arg);
  });

  it.each([
    ["showDoltStatus", "beads.showDoltStatus"],
    ["startDoltServer", "beads.startDoltServer"],
    ["stopDoltServer", "beads.stopDoltServer"],
    ["openDoltLog", "beads.openDoltLog"],
  ])("forwards %s to its command", async (type, command) => {
    const { provider } = createProvider();

    await provider.handle({ type } as WebviewToExtensionMessage);

    expect(executeCommand).toHaveBeenCalledWith(command);
  });

  it("switches the active project", async () => {
    const { provider, setActiveProject } = createProvider();

    await provider.handle({ type: "selectProject", projectId: "p1" });

    expect(setActiveProject).toHaveBeenCalledWith("p1");
  });

  it("falls back to matching a project by root path when the id misses", async () => {
    const { provider, setActiveProject } = createProvider();
    setActiveProject.mockResolvedValueOnce(false);

    await provider.handle({
      type: "selectProject",
      projectId: "stale-id",
      projectRootPath: "/repo",
    });

    expect(setActiveProject).toHaveBeenLastCalledWith("p1");
  });

  it("copies a bead id to the clipboard", async () => {
    const { provider } = createProvider();
    const writeText = jest.spyOn(vscode.env.clipboard, "writeText");

    await provider.handle({ type: "copyBeadId", beadId: "bd-9" });

    expect(writeText).toHaveBeenCalledWith("bd-9");
  });

  it("reveals the project folder", async () => {
    const { provider } = createProvider();

    await provider.handle({ type: "openProjectFolder" });

    expect(executeCommand).toHaveBeenCalledWith("revealInExplorer", expect.anything());
  });

  it("posts loading and error state to the webview", () => {
    const { provider, posted } = createProvider();
    const p = provider as unknown as {
      setLoading: (v: boolean) => void;
      setError: (v: string | null) => void;
    };

    p.setLoading(true);
    p.setError("boom");

    expect(posted).toContainEqual({ type: "setLoading", loading: true });
    expect(posted).toContainEqual({ type: "setError", error: "boom" });
  });

  it("opens the graph panel on the originating bead", async () => {
    // Regression: this used to run `beadsGraph.focus` against a view that was
    // never registered in package.json, so the button did nothing at all.
    const { provider } = createProvider();

    await provider.handle({ type: "viewInGraph", beadId: "bd-7" });

    expect(executeCommand).toHaveBeenCalledWith("beads.openGraph", "bd-7");
    expect(executeCommand).not.toHaveBeenCalledWith("beadsGraph.focus");
  });

  it("ignores an unrecognized message rather than throwing", async () => {
    const { provider } = createProvider();

    await expect(
      provider.handle({ type: "not-a-real-message" } as unknown as WebviewToExtensionMessage)
    ).resolves.toBeUndefined();
  });
});
