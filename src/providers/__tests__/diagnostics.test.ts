import * as vscode from "vscode";
import {
  createdDiagnosticCollections,
  Diagnostic,
  FakeDiagnosticCollection,
} from "../../__mocks__/vscode";
import { BeadsProject } from "../../backend/types";
import { deriveGraph } from "../../graph/BeadsGraph";
import { BeadsGraphModel } from "../../graph/types";
import { Logger } from "../../utils/logger";
import {
  BeadsDiagnostics,
  CYCLE_DIAGNOSTIC_CODE,
  DIAGNOSTIC_SOURCE,
} from "../BeadsDiagnostics";

function createDiagnostics(): BeadsDiagnostics {
  const logger = new Logger(
    vscode.window.createOutputChannel() as unknown as vscode.LogOutputChannel
  );
  return new BeadsDiagnostics(logger);
}

/** The collection the class under test created, as the fake that records calls. */
function collection(): FakeDiagnosticCollection {
  return createdDiagnosticCollections[createdDiagnosticCollections.length - 1];
}

function published(fsPath: string): Diagnostic[] {
  return collection().entries.get(fsPath) ?? [];
}

function project(overrides: Partial<BeadsProject> = {}): BeadsProject {
  return {
    id: "p1",
    name: "repo",
    rootPath: "/repo",
    beadsDir: "/repo/.beads",
    backendStatus: "running",
    ...overrides,
  };
}

function model(overrides: Partial<BeadsGraphModel> = {}): BeadsGraphModel {
  return {
    nodes: {},
    ready: [],
    blocked: [],
    orphans: [],
    cycles: [],
    hasCycle: false,
    complete: true,
    ...overrides,
  };
}

/** A model derived for real, so the cycle shape is the module's, not the test's. */
function derivedCycle(): BeadsGraphModel {
  return deriveGraph(
    [
      { id: "bd-a", status: "open", issue_type: "task" },
      { id: "bd-b", status: "open", issue_type: "task" },
      { id: "bd-c", status: "open", issue_type: "task" },
    ],
    [
      { from: "bd-a", to: "bd-b", type: "blocks" },
      { from: "bd-b", to: "bd-c", type: "blocks" },
      { from: "bd-c", to: "bd-a", type: "blocks" },
    ]
  );
}

describe("BeadsDiagnostics", () => {
  beforeEach(() => {
    createdDiagnosticCollections.length = 0;
  });

  it("publishes one diagnostic naming every id in a three-bead cycle", () => {
    const diagnostics = createDiagnostics();

    diagnostics.update(derivedCycle(), project());

    const entries = published("/repo/.beads");
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain("bd-a");
    expect(entries[0].message).toContain("bd-b");
    expect(entries[0].message).toContain("bd-c");
  });

  it("tags each finding with the beads source, cycle code, and error severity", () => {
    const diagnostics = createDiagnostics();

    diagnostics.update(derivedCycle(), project());

    const [entry] = published("/repo/.beads");
    expect(entry.source).toBe(DIAGNOSTIC_SOURCE);
    expect(entry.code).toBe(CYCLE_DIAGNOSTIC_CODE);
    expect(entry.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(entry.range.start.line).toBe(0);
    expect(entry.range.end.character).toBe(0);
  });

  it("publishes two diagnostics for two disjoint cycles", () => {
    const diagnostics = createDiagnostics();

    diagnostics.update(
      model({
        cycles: [
          ["bd-a", "bd-b"],
          ["bd-y", "bd-z"],
        ],
        hasCycle: true,
      }),
      project()
    );

    const entries = published("/repo/.beads");
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toContain("bd-a");
    expect(entries[1].message).toContain("bd-y");
  });

  it("orders cycles and their members deterministically regardless of input order", () => {
    const first = createDiagnostics();
    first.update(
      model({
        cycles: [
          ["bd-z", "bd-y"],
          ["bd-b", "bd-a"],
        ],
        hasCycle: true,
      }),
      project()
    );
    const firstMessages = published("/repo/.beads").map((d) => d.message);

    createdDiagnosticCollections.length = 0;
    const second = createDiagnostics();
    second.update(
      model({
        cycles: [
          ["bd-a", "bd-b"],
          ["bd-y", "bd-z"],
        ],
        hasCycle: true,
      }),
      project()
    );

    expect(published("/repo/.beads").map((d) => d.message)).toEqual(firstMessages);
  });

  it("clears previously published diagnostics when the cycle is resolved", () => {
    const diagnostics = createDiagnostics();
    diagnostics.update(derivedCycle(), project());
    expect(published("/repo/.beads")).toHaveLength(1);

    diagnostics.update(model(), project());

    expect(collection().entries.has("/repo/.beads")).toBe(false);
  });

  it("clears the previous project before publishing the new one", () => {
    const diagnostics = createDiagnostics();
    diagnostics.update(derivedCycle(), project());

    diagnostics.update(
      model({ cycles: [["bd-x", "bd-w"]], hasCycle: true }),
      project({ id: "p2", rootPath: "/other", beadsDir: "/other/.beads" })
    );

    expect(collection().entries.has("/repo/.beads")).toBe(false);
    expect(published("/other/.beads")).toHaveLength(1);

    // The clear has to land before the new set, or the outgoing project's
    // findings survive one refresh under the incoming project.
    const ops = collection().calls.map((c) => c.op);
    const lastClear = ops.lastIndexOf("clear");
    const lastSet = ops.lastIndexOf("set");
    expect(lastClear).toBeLessThan(lastSet);
  });

  it("reports a cycle whose members include a hidden-type bead", () => {
    const diagnostics = createDiagnostics();
    const graph = deriveGraph(
      [
        { id: "bd-task", status: "open", issue_type: "task" },
        { id: "bd-gate", status: "open", issue_type: "gate" },
      ],
      [
        { from: "bd-task", to: "bd-gate", type: "blocks" },
        { from: "bd-gate", to: "bd-task", type: "blocks" },
      ]
    );

    diagnostics.update(graph, project());

    const entries = published("/repo/.beads");
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain("bd-gate");
    expect(entries[0].message).toContain("bd-task");
  });

  it("names a self-blocking bead as blocking itself", () => {
    const diagnostics = createDiagnostics();

    diagnostics.update(model({ cycles: [["bd-solo"]], hasCycle: true }), project());

    expect(published("/repo/.beads")[0].message).toBe(
      "Dependency cycle: bd-solo blocks itself. It cannot become ready until that blocks edge is removed."
    );
  });

  it("summarizes the tail of an oversized tangle rather than naming forty ids", () => {
    const diagnostics = createDiagnostics();
    const members = Array.from({ length: 14 }, (_, i) => `bd-${String(i).padStart(2, "0")}`);

    diagnostics.update(model({ cycles: [members], hasCycle: true }), project());

    const message = published("/repo/.beads")[0].message;
    expect(message).toContain("14 beads block each other");
    expect(message).toContain("bd-09");
    expect(message).not.toContain("bd-13");
    expect(message).toContain("and 4 more");
  });

  it("clears everything when there is no active project", () => {
    const diagnostics = createDiagnostics();
    diagnostics.update(derivedCycle(), project());

    diagnostics.update(derivedCycle(), null);

    expect(collection().entries.size).toBe(0);
  });

  it("does not publish when the model has not been derived yet", () => {
    const diagnostics = createDiagnostics();

    expect(() => diagnostics.update(null, project())).not.toThrow();
    expect(collection().entries.size).toBe(0);
  });

  it("anchors on the project root when no beads directory is resolved", () => {
    const diagnostics = createDiagnostics();

    diagnostics.update(derivedCycle(), project({ beadsDir: "" }));

    expect(published("/repo")).toHaveLength(1);
  });

  it("skips publishing rather than throwing when the project has no path at all", () => {
    const diagnostics = createDiagnostics();

    expect(() =>
      diagnostics.update(derivedCycle(), project({ beadsDir: "", rootPath: "" }))
    ).not.toThrow();
    expect(collection().entries.size).toBe(0);
  });

  it("clear() removes every published finding", () => {
    const diagnostics = createDiagnostics();
    diagnostics.update(derivedCycle(), project());

    diagnostics.clear();

    expect(collection().entries.size).toBe(0);
  });

  it("republishes after clear() even though the project did not change", () => {
    const diagnostics = createDiagnostics();
    diagnostics.update(derivedCycle(), project());
    diagnostics.clear();

    diagnostics.update(derivedCycle(), project());

    expect(published("/repo/.beads")).toHaveLength(1);
  });

  it("disposes the collection and ignores later updates", () => {
    const diagnostics = createDiagnostics();
    diagnostics.update(derivedCycle(), project());

    diagnostics.dispose();

    expect(collection().disposed).toBe(true);
    expect(collection().entries.size).toBe(0);
    expect(() => diagnostics.update(derivedCycle(), project())).not.toThrow();
    expect(collection().entries.size).toBe(0);
  });

  it("is safe to dispose twice", () => {
    const diagnostics = createDiagnostics();

    diagnostics.dispose();

    expect(() => diagnostics.dispose()).not.toThrow();
    expect(() => diagnostics.clear()).not.toThrow();
  });
});
