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
    setVisible: (visible: boolean) => void;
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

/** Same host, but opted into the poll the graph tab uses. */
class PollingTestPanel extends TestPanel {
  protected readonly pollIntervalMs = 5000;
  protected readonly livePollIntervalMs = 60000;

  /** Resolves the pending load, so a slow read can be held open in a test. */
  public release: (() => void) | null = null;

  protected async loadData(reason?: LoadReason): Promise<void> {
    this.loadCalls.push(reason);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
  }

  public hold = false;
}

/**
 * Stands in for the manager's live change feed, so a test can bring the feed up
 * or down the way a real `bd events tail` would.
 */
class FakeChangeFeed {
  public live = false;
  private listeners: Array<(live: boolean) => void> = [];
  public disposedListeners = 0;

  readonly onChangeFeedStateChanged = (listener: (live: boolean) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.disposedListeners++;
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  setLive(live: boolean): void {
    this.live = live;
    for (const listener of [...this.listeners]) listener(live);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

let feed: FakeChangeFeed;

function createPanel<T extends TestPanel = TestPanel>(
  Panel: new (
    uri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) => T = TestPanel as unknown as new (
    uri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) => T
): T {
  const projectManager = {
    getClient: () => null,
    getActiveProject: () => ({ id: "p1", rootPath: "/repo", name: "repo" }),
    getProjects: () => [{ id: "p1", rootPath: "/repo", name: "repo" }],
    isLiveChangeFeedActive: () => feed.live,
    onChangeFeedStateChanged: feed.onChangeFeedStateChanged,
  } as unknown as BeadsProjectManager;

  const logger = new Logger(
    vscode.window.createOutputChannel() as unknown as vscode.LogOutputChannel
  );
  return new Panel({ fsPath: "/ext" } as vscode.Uri, projectManager, logger);
}

describe("BeadsPanelHost", () => {
  beforeEach(() => {
    createdPanels.length = 0;
    feed = new FakeChangeFeed();
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

  describe("polling", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("does not poll a panel that has not opted in", () => {
      const panel = createPanel();
      panel.reveal();

      jest.advanceTimersByTime(60_000);

      expect(panel.loadCalls).toEqual([]);
    });

    it("re-reads on every interval while the panel is open", async () => {
      const panel = createPanel(PollingTestPanel);
      panel.reveal();

      await jest.advanceTimersByTimeAsync(15_000);

      expect(panel.loadCalls).toEqual(["background", "background", "background"]);
    });

    it("stops while the tab is in the background and resumes when it returns", async () => {
      const panel = createPanel(PollingTestPanel);
      panel.reveal();

      createdPanels[0].setVisible(false);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(panel.loadCalls).toEqual([]);

      createdPanels[0].setVisible(true);
      // One load for becoming visible again, then the poll picks back up.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(panel.loadCalls).toEqual(["background", "background"]);
    });

    it("stops polling once the panel is disposed", async () => {
      const panel = createPanel(PollingTestPanel);
      panel.reveal();
      panel.dispose();

      await jest.advanceTimersByTimeAsync(30_000);

      expect(panel.loadCalls).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("skips a tick rather than stacking reads on a slow one", async () => {
      const panel = createPanel(PollingTestPanel);
      panel.hold = true;
      panel.reveal();

      await jest.advanceTimersByTimeAsync(15_000);

      expect(panel.loadCalls).toEqual(["background"]);

      // Once the slow read finishes, the next tick is taken normally.
      panel.release?.();
      panel.hold = false;
      await jest.advanceTimersByTimeAsync(5_000);
      expect(panel.loadCalls).toEqual(["background", "background"]);
    });

    describe("with a live change feed", () => {
      it("drops to the safety-net interval when the feed is already up", async () => {
        feed.live = true;
        const panel = createPanel(PollingTestPanel);
        panel.reveal();

        // The fast interval would have read three times by now.
        await jest.advanceTimersByTimeAsync(15_000);
        expect(panel.loadCalls).toEqual([]);

        // The slow read still happens: the journal carries neither `bd sql`
        // writes nor rows that arrived by `bd dolt pull`.
        await jest.advanceTimersByTimeAsync(45_000);
        expect(panel.loadCalls).toEqual(["background"]);
      });

      it("slows down when the feed comes up while the tab is open", async () => {
        const panel = createPanel(PollingTestPanel);
        panel.reveal();

        await jest.advanceTimersByTimeAsync(5_000);
        expect(panel.loadCalls).toEqual(["background"]);

        feed.setLive(true);
        await jest.advanceTimersByTimeAsync(15_000);
        expect(panel.loadCalls).toEqual(["background"]);
      });

      it("speeds back up when the feed drops, with no help from the caller", async () => {
        feed.live = true;
        const panel = createPanel(PollingTestPanel);
        panel.reveal();

        feed.setLive(false);
        await jest.advanceTimersByTimeAsync(10_000);

        expect(panel.loadCalls).toEqual(["background", "background"]);
      });

      it("keeps one feed subscription per panel and releases it on dispose", () => {
        const panel = createPanel(PollingTestPanel);
        panel.reveal();
        panel.reveal();
        expect(feed.listenerCount).toBe(1);

        panel.dispose();
        expect(feed.listenerCount).toBe(0);
      });

      it("releases the subscription when the tab is closed from the editor", () => {
        const panel = createPanel(PollingTestPanel);
        panel.reveal();

        createdPanels[0].fireDispose();

        expect(feed.listenerCount).toBe(0);
      });

      it("does not subscribe a panel that never polls", () => {
        const panel = createPanel();
        panel.reveal();

        expect(feed.listenerCount).toBe(0);
      });
    });
  });

  describe("background refresh", () => {
    it("skips the read for a tab nobody is looking at", () => {
      const panel = createPanel();
      panel.reveal();
      createdPanels[0].setVisible(false);
      panel.loadCalls.length = 0;

      panel.refresh();

      expect(panel.loadCalls).toEqual([]);
      // Project context is still delivered, so the tab is correct when it returns.
      const types = createdPanels[0].posted.map((m) => (m as { type: string }).type);
      expect(types).toContain("setProject");
    });

    it("still honours an explicit refresh of a hidden tab", () => {
      const panel = createPanel();
      panel.reveal();
      createdPanels[0].setVisible(false);
      panel.loadCalls.length = 0;

      panel.hardRefresh();
      panel.refreshForProjectChange();

      expect(panel.loadCalls).toEqual(["manualRefresh", "projectChange"]);
    });
  });
});
