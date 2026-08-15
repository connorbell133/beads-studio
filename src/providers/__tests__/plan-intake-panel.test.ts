import * as vscode from "vscode";
import { BeadsProjectManager } from "../../backend/BeadsProjectManager";
import { PlanCommitResult } from "../../backend/plan-batch";
import { PlanDraft } from "../../backend/plan-draft";
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../backend/types";
import { Logger } from "../../utils/logger";
import { BeadsPlanIntakePanel } from "../BeadsPlanIntakePanel";

const { createdPanels } = vscode as unknown as {
  createdPanels: Array<{ posted: ExtensionToWebviewMessage[] }>;
};

const DRAFT: PlanDraft = {
  epic: { key: "epic", title: "Ship it", type: "epic", priority: 1 },
  tasks: [{ key: "t1", title: "Do it", type: "task", priority: 2 }],
  blocks: [],
};

class TestPanel extends BeadsPlanIntakePanel {
  public handle(message: WebviewToExtensionMessage): Promise<void> {
    return (
      this as unknown as {
        handleCustomMessage: (m: WebviewToExtensionMessage) => Promise<void>;
      }
    ).handleCustomMessage(message);
  }
}

function createPanel(options: {
  createPlanEpic?: jest.Mock;
  hasClient?: boolean;
}): { panel: TestPanel; refresh: jest.Mock; posted: ExtensionToWebviewMessage[] } {
  const refresh = jest.fn().mockResolvedValue(undefined);
  const client = options.hasClient === false ? null : { createPlanEpic: options.createPlanEpic };

  const projectManager = {
    getClient: () => client,
    getActiveProject: () => ({ id: "p1", rootPath: "/repo", name: "repo" }),
    getProjects: () => [{ id: "p1", rootPath: "/repo", name: "repo" }],
    refresh,
  } as unknown as BeadsProjectManager;

  const logger = new Logger(
    vscode.window.createOutputChannel() as unknown as vscode.LogOutputChannel
  );
  const panel = new TestPanel({ fsPath: "/ext" } as vscode.Uri, projectManager, logger);
  panel.reveal();

  return { panel, refresh, posted: createdPanels[createdPanels.length - 1].posted };
}

function states(posted: ExtensionToWebviewMessage[]): unknown[] {
  return posted
    .filter((message) => message.type === "setPlanCommitState")
    .map((message) => (message as { state: unknown }).state);
}

describe("BeadsPlanIntakePanel", () => {
  beforeEach(() => {
    createdPanels.length = 0;
    jest.spyOn(vscode.commands, "executeCommand").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reports the epic it created and refreshes every other surface", async () => {
    const result: PlanCommitResult = {
      ok: true,
      epicId: "bd-a",
      ids: { epic: "bd-a", t1: "bd-b" },
      taskCount: 1,
      edgeCount: 0,
    };
    const createPlanEpic = jest.fn().mockResolvedValue(result);
    const { panel, refresh, posted } = createPanel({ createPlanEpic });

    await panel.handle({ type: "commitPlanDraft", draft: DRAFT });

    expect(createPlanEpic).toHaveBeenCalledWith(DRAFT);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(states(posted)).toEqual([
      { phase: "committing" },
      { phase: "committed", epicId: "bd-a", taskCount: 1, edgeCount: 0 },
    ]);
  });

  it("hands the failure message and any surviving ids to the composer", async () => {
    const createPlanEpic = jest.fn().mockResolvedValue({
      ok: false,
      stage: "link",
      message: "would create a cycle",
      createdIds: ["bd-a", "bd-b"],
    } satisfies PlanCommitResult);
    const { panel, refresh, posted } = createPanel({ createPlanEpic });

    await panel.handle({ type: "commitPlanDraft", draft: DRAFT });

    expect(states(posted)).toEqual([
      { phase: "committing" },
      { phase: "failed", message: "would create a cycle", createdIds: ["bd-a", "bd-b"] },
    ]);
    // Those two issues exist now, so the rest of the extension has to see them.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when a rolled-back batch left nothing behind", async () => {
    const createPlanEpic = jest.fn().mockResolvedValue({
      ok: false,
      stage: "create",
      message: "prefix mismatch",
      createdIds: [],
    } satisfies PlanCommitResult);
    const { panel, refresh } = createPanel({ createPlanEpic });

    await panel.handle({ type: "commitPlanDraft", draft: DRAFT });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores a second commit while the first batch is still running", async () => {
    let release: (() => void) | null = null;
    const createPlanEpic = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, epicId: "bd-a", ids: {}, taskCount: 1, edgeCount: 0 });
        })
    );
    const { panel } = createPanel({ createPlanEpic });

    const first = panel.handle({ type: "commitPlanDraft", draft: DRAFT });
    await panel.handle({ type: "commitPlanDraft", draft: DRAFT });

    expect(createPlanEpic).toHaveBeenCalledTimes(1);

    release?.();
    await first;

    // Once the first has landed, the guard is released again.
    const third = panel.handle({ type: "commitPlanDraft", draft: DRAFT });
    expect(createPlanEpic).toHaveBeenCalledTimes(2);
    release?.();
    await third;
  });

  it("fails cleanly with no active project instead of throwing", async () => {
    const { panel, posted } = createPanel({ hasClient: false });

    await panel.handle({ type: "commitPlanDraft", draft: DRAFT });

    expect(states(posted)).toEqual([
      { phase: "failed", message: "No active Beads project.", createdIds: [] },
    ]);
  });

  it("turns a thrown backend error into a failure state", async () => {
    const createPlanEpic = jest.fn().mockRejectedValue(new Error("dolt is down"));
    const { panel, posted } = createPanel({ createPlanEpic });

    await panel.handle({ type: "commitPlanDraft", draft: DRAFT });

    expect(states(posted)).toEqual([
      { phase: "committing" },
      { phase: "failed", message: "dolt is down", createdIds: [] },
    ]);
  });
});
