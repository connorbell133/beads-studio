import * as vscode from "vscode";
import type { Diagnostic, FakeDiagnosticCollection } from "../../__mocks__/vscode";

// Read the recorder through the same specifier the code under test uses.
// Importing "../../__mocks__/vscode" for a *value* can resolve to a second
// module instance: jest only dedupes the two specifiers when another suite
// instantiated the module first in the same worker, so the assertions would
// pass or fail on worker assignment. Types are erased, so importing those
// from the path directly is safe.
const { createdDiagnosticCollections } = vscode as unknown as {
  createdDiagnosticCollections: FakeDiagnosticCollection[];
};
import { BeadsProject } from "../../backend/types";
import { deriveGraph } from "../../graph/BeadsGraph";
import { BeadsGraphModel } from "../../graph/types";
import { Logger } from "../../utils/logger";
import {
  BeadsDiagnostics,
  CYCLE_DIAGNOSTIC_CODE,
  DIAGNOSTIC_SOURCE,
  diagnosticKey,
} from "../BeadsDiagnostics";
import { BeadsHygieneActions, describeFix } from "../BeadsHygiene";
import { HygieneFinding } from "../../hygiene/types";

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
    parentless: [],
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

/** A graph where one epic owns one task, so the loose-work rule is armed. */
function hierarchy(loose: string[]): BeadsGraphModel {
  return deriveGraph(
    [
      { id: "bd-epic", status: "open", issue_type: "epic" },
      { id: "bd-child", status: "open", issue_type: "task", parent: "bd-epic" },
      ...loose.map((id) => ({ id, status: "open", issue_type: "task" })),
    ],
    []
  );
}

function finding(overrides: Partial<HygieneFinding> = {}): HygieneFinding {
  return {
    code: "stale-bead",
    severity: "info",
    message: "bd-old has not been updated in 45 days.",
    beadIds: ["bd-old"],
    ...overrides,
  };
}

describe("BeadsDiagnostics as a rule engine", () => {
  beforeEach(() => {
    createdDiagnosticCollections.length = 0;
  });

  it("publishes findings from more than one local rule at once", () => {
    const diagnostics = createDiagnostics();
    const graph = hierarchy(["bd-loose"]);
    graph.cycles = [["bd-a", "bd-b"]];
    graph.hasCycle = true;

    diagnostics.update(graph, project());

    const codes = published("/repo/.beads").map((d) => d.code);
    expect(codes).toContain(CYCLE_DIAGNOSTIC_CODE);
    expect(codes).toContain("loose-work");
  });

  it("maps each rule's severity onto the panel rather than flagging everything as an error", () => {
    const diagnostics = createDiagnostics();
    const graph = hierarchy(["bd-loose"]);
    graph.cycles = [["bd-a", "bd-b"]];
    graph.hasCycle = true;

    diagnostics.update(graph, project());
    diagnostics.setShellFindings([finding({ severity: "warning" })], project());

    const bySeverity = new Map(
      published("/repo/.beads").map((d) => [d.code, d.severity])
    );
    expect(bySeverity.get(CYCLE_DIAGNOSTIC_CODE)).toBe(vscode.DiagnosticSeverity.Error);
    expect(bySeverity.get("loose-work")).toBe(vscode.DiagnosticSeverity.Information);
    expect(bySeverity.get("stale-bead")).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it("names the beads that sit outside every epic", () => {
    const diagnostics = createDiagnostics();

    diagnostics.update(hierarchy(["bd-loose"]), project());

    const [entry] = published("/repo/.beads").filter((d) => d.code === "loose-work");
    expect(entry.message).toContain("bd-loose");
    expect(entry.message).not.toContain("bd-epic");
    expect(entry.source).toBe(DIAGNOSTIC_SOURCE);
  });

  it("keeps a hygiene snapshot alive across a local republish", () => {
    const diagnostics = createDiagnostics();
    diagnostics.setShellFindings([finding()], project());

    // A repaint derives the graph again. The shell tier is not re-run, so it
    // must not be dropped either.
    diagnostics.update(model(), project());

    expect(published("/repo/.beads").map((d) => d.code)).toEqual(["stale-bead"]);
  });

  it("replaces the previous snapshot rather than appending to it", () => {
    const diagnostics = createDiagnostics();
    diagnostics.setShellFindings([finding(), finding({ beadIds: ["bd-two"] })], project());

    diagnostics.setShellFindings([finding()], project());

    expect(published("/repo/.beads")).toHaveLength(1);
  });

  it("drops the snapshot on a project switch, since the ids mean nothing there", () => {
    const diagnostics = createDiagnostics();
    diagnostics.setShellFindings([finding()], project());

    diagnostics.update(model(), project({ id: "p2", beadsDir: "/other/.beads" }));

    expect(collection().entries.has("/repo/.beads")).toBe(false);
    expect(collection().entries.has("/other/.beads")).toBe(false);
  });

  it("clears the anchor when the last finding of either tier is resolved", () => {
    const diagnostics = createDiagnostics();
    diagnostics.update(derivedCycle(), project());
    diagnostics.setShellFindings([finding()], project());

    diagnostics.update(model(), project());
    diagnostics.setShellFindings([], project());

    expect(collection().entries.has("/repo/.beads")).toBe(false);
  });

  it("ignores a snapshot published after disposal", () => {
    const diagnostics = createDiagnostics();
    diagnostics.dispose();

    expect(() => diagnostics.setShellFindings([finding()], project())).not.toThrow();
    expect(collection().entries.size).toBe(0);
  });
});

describe("hygiene quick fixes", () => {
  const fix = {
    key: "commit-referenced-open",
    title: "Close 2 issues already referenced by commits",
    action: { type: "closeCommitReferenced" as const, ids: ["bd-a", "bd-b"] },
  };

  beforeEach(() => {
    createdDiagnosticCollections.length = 0;
  });

  it("looks a fix back up from the diagnostic it was published with", () => {
    const diagnostics = createDiagnostics();
    const withFix = finding({ code: fix.key, message: "still open: bd-a, bd-b", fix });

    diagnostics.setShellFindings([withFix], project());

    const [entry] = published("/repo/.beads");
    expect(diagnostics.getFix(diagnosticKey(entry))).toEqual(fix);
  });

  it("offers a quick fix only for the diagnostics that carry one", () => {
    const diagnostics = createDiagnostics();
    diagnostics.setShellFindings(
      [finding({ code: fix.key, message: "still open: bd-a, bd-b", fix }), finding()],
      project()
    );
    const provider = new BeadsHygieneActions(diagnostics);

    const actions = provider.provideCodeActions(
      {} as never,
      {} as never,
      { diagnostics: published("/repo/.beads") } as never
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe(fix.title);
    expect(actions[0].command?.command).toBe("beads.applyHygieneFix");

    // The argument has to be the key the extension can resolve back to a fix,
    // because the lightbulb cannot carry the finding itself across the host.
    const [key] = actions[0].command?.arguments as string[];
    expect(diagnostics.getFix(key)).toEqual(fix);
  });

  it("ignores diagnostics published by anything other than beads", () => {
    const diagnostics = createDiagnostics();
    diagnostics.setShellFindings(
      [finding({ code: fix.key, message: "still open", fix })],
      project()
    );
    const provider = new BeadsHygieneActions(diagnostics);
    const foreign = published("/repo/.beads").map((d) => ({ ...d, source: "eslint" }));

    const actions = provider.provideCodeActions(
      {} as never,
      {} as never,
      { diagnostics: foreign } as never
    );

    expect(actions).toEqual([]);
  });

  it("forgets its fixes when the findings are cleared", () => {
    const diagnostics = createDiagnostics();
    const withFix = finding({ code: fix.key, message: "still open", fix });
    diagnostics.setShellFindings([withFix], project());
    expect(diagnostics.listFixes()).toHaveLength(1);

    diagnostics.setShellFindings([], project());

    expect(diagnostics.listFixes()).toEqual([]);
  });

  it("spells out the blast radius, because every fix closes beads", () => {
    expect(describeFix(fix.action)).toContain("bd-a, bd-b");
    expect(
      describeFix({ type: "closeDuplicate", sources: ["bd-dup"], target: "bd-keep" })
    ).toBe("Closes bd-dup and links it to bd-keep as related.");
  });
});
