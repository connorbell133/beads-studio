import * as vscode from "vscode";
import {
  BeadsCommandRunner,
  GUARD_MISMATCH_EXIT_CODE,
  createListCommandArgs,
  createShowCommandArgs,
  createUpdateCommandArgs,
  detectListCapabilities,
  parseGuardMismatch,
} from "../BeadsCommandRunner";
import { MIN_SUPPORTED_BD_VERSION } from "../BeadsBackend";
import { Logger } from "../../utils/logger";

// Trimmed from the real `bd list --help` on bd 1.2.1.
const HELP_WITH_BOTH_FLAGS = `
      --include-gates                Include gate issues in output (normally hidden)
      --include-infra                Include infrastructure beads (agent/role/message) in output
      --include-templates            Include template molecules in output
`;

/**
 * Substitutes the process boundary so capability probing and the list read can
 * be exercised without a bd install or a real project.
 */
class StubRunner extends BeadsCommandRunner {
  public readonly calls: string[][] = [];

  constructor(private readonly respond: (args: string[]) => { stdout: string; stderr: string }) {
    super({
      bdPath: "bd",
      cwd: "/tmp",
      beadsDir: "/tmp/.beads",
      log: new Logger(
        vscode.window.createOutputChannel() as unknown as vscode.LogOutputChannel
      ),
    });
  }

  protected async execBd(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push(args);
    return this.respond(args);
  }
}

function respondWith(options: { help?: string; issues?: unknown[]; helpThrows?: boolean }) {
  return (args: string[]): { stdout: string; stderr: string } => {
    if (args[0] === "version" || args[0] === "--version") {
      return { stdout: "bd version 1.2.1", stderr: "" };
    }
    if (args.includes("--help")) {
      if (options.helpThrows) throw new Error("bd exploded while printing help");
      return { stdout: options.help ?? "", stderr: "" };
    }
    return { stdout: JSON.stringify(options.issues ?? []), stderr: "" };
  };
}

describe("createListCommandArgs", () => {
  it("requests all issues without the CLI default limit", () => {
    expect(createListCommandArgs()).toEqual(["list", "--all", "--limit", "0", "--json"]);
  });

  it("asks for gate and infra beads when bd supports it", () => {
    expect(createListCommandArgs({ includeHidden: true })).toEqual([
      "list",
      "--all",
      "--limit",
      "0",
      "--json",
      "--include-gates",
      "--include-infra",
    ]);
  });
});

describe("detectListCapabilities", () => {
  it("reports support when help advertises both flags", () => {
    expect(detectListCapabilities(HELP_WITH_BOTH_FLAGS)).toEqual({ includeHidden: true });
  });

  it("reports no support when help advertises neither", () => {
    expect(detectListCapabilities("      --all   Show all issues\n")).toEqual({
      includeHidden: false,
    });
  });

  it("treats a partial flag pair as unsupported", () => {
    // Sending one of the pair to a bd that only has the other fails the whole
    // command, so half a pair is worth exactly as much as none.
    expect(
      detectListCapabilities("      --include-gates   Include gate issues\n").includeHidden
    ).toBe(false);
    expect(
      detectListCapabilities("      --include-infra   Include infra beads\n").includeHidden
    ).toBe(false);
  });

  it("reports no support for empty help output", () => {
    expect(detectListCapabilities("").includeHidden).toBe(false);
  });
});

describe("BeadsCommandRunner.listGraph", () => {
  it("sends the completeness flags and reports a complete payload when bd supports them", async () => {
    const runner = new StubRunner(respondWith({ help: HELP_WITH_BOTH_FLAGS }));

    const payload = await runner.listGraph();

    expect(payload.complete).toBe(true);
    expect(runner.calls).toContainEqual([
      "list",
      "--all",
      "--limit",
      "0",
      "--json",
      "--include-gates",
      "--include-infra",
    ]);
  });

  it("omits the flags and reports an incomplete payload when bd lacks them", async () => {
    const runner = new StubRunner(respondWith({ help: "      --all   Show all issues\n" }));

    const payload = await runner.listGraph();

    expect(payload.complete).toBe(false);
    expect(runner.calls).toContainEqual(["list", "--all", "--limit", "0", "--json"]);
    expect(runner.calls.flat()).not.toContain("--include-gates");
  });

  it("probes once across repeated reads", async () => {
    const runner = new StubRunner(respondWith({ help: HELP_WITH_BOTH_FLAGS }));

    await runner.listGraph();
    await runner.listGraph();
    await runner.listGraph();

    expect(runner.calls.filter((args) => args.includes("--help"))).toHaveLength(1);
  });

  it("degrades instead of failing when the probe throws", async () => {
    const runner = new StubRunner(respondWith({ helpThrows: true }));

    const payload = await runner.listGraph();

    expect(payload.complete).toBe(false);
    expect(payload.nodes).toEqual([]);
  });

  it("extracts the inline edges bd list ships on each bead", async () => {
    const runner = new StubRunner(
      respondWith({
        help: HELP_WITH_BOTH_FLAGS,
        issues: [
          {
            id: "bd-1",
            dependencies: [{ issue_id: "bd-1", depends_on_id: "bd-2", type: "blocks" }],
          },
          { id: "bd-2" },
        ],
      })
    );

    const payload = await runner.listGraph();

    expect(payload.nodes).toHaveLength(2);
    expect(payload.edges).toEqual([{ from: "bd-1", to: "bd-2", type: "blocks" }]);
  });

  it("returns an empty payload when bd emits something that is not an array", async () => {
    const runner = new StubRunner((args) => {
      if (args[0] === "version") return { stdout: "bd version 1.2.1", stderr: "" };
      if (args.includes("--help")) return { stdout: HELP_WITH_BOTH_FLAGS, stderr: "" };
      return { stdout: JSON.stringify({ error: "nope" }), stderr: "" };
    });

    const payload = await runner.listGraph();

    expect(payload.nodes).toEqual([]);
    expect(payload.edges).toEqual([]);
  });
});

describe("createShowCommandArgs", () => {
  it("opts in to the dependents payload bd 1.0.5+ omits by default", () => {
    expect(createShowCommandArgs("bd-abc")).toEqual([
      "show",
      "bd-abc",
      "--json",
      "--include-dependents",
    ]);
  });

  it("is backed by a version floor new enough to accept --include-dependents", () => {
    // bd rejects unknown flags outright, so the floor must be >= 1.0.5.
    const [major, minor, patch] = MIN_SUPPORTED_BD_VERSION.split(".").map(Number);
    expect(major * 10000 + minor * 100 + patch).toBeGreaterThanOrEqual(10005);
  });
});

describe("createUpdateCommandArgs", () => {
  it("sends no preconditions when the caller supplies none", () => {
    // The pre-guard behaviour, still reachable: an unguarded write is
    // unconditional, exactly as it was.
    expect(createUpdateCommandArgs({ id: "bd-1", status: "closed" })).toEqual([
      "update",
      "bd-1",
      "--json",
      "--status",
      "closed",
    ]);
  });

  it("conditions the write on the status the caller last saw", () => {
    const args = createUpdateCommandArgs({
      id: "bd-1",
      status: "in_progress",
      guard: { ifStatus: "open" },
    });

    expect(args).toEqual([
      "update",
      "bd-1",
      "--json",
      "--status",
      "in_progress",
      "--if-status",
      "open",
    ]);
  });

  it("guards an assignment on the previous holder", () => {
    const args = createUpdateCommandArgs({
      id: "bd-1",
      assignee: "connor",
      guard: { ifAssignee: "agent-7" },
    });

    expect(args.slice(-2)).toEqual(["--if-assignee", "agent-7"]);
  });

  it("guards a claim of an unassigned bead on it still being unassigned", () => {
    // bd reads --if-assignee '' as "requires unassigned", so the empty string
    // is a value to send, not an absent guard to drop.
    const args = createUpdateCommandArgs({
      id: "bd-1",
      assignee: "connor",
      guard: { ifAssignee: "" },
    });

    expect(args.slice(-2)).toEqual(["--if-assignee", ""]);
  });

  it("sends both preconditions when an edit changes both fields", () => {
    const args = createUpdateCommandArgs({
      id: "bd-1",
      status: "in_progress",
      assignee: "connor",
      guard: { ifStatus: "open", ifAssignee: "" },
    });

    expect(args).toContain("--if-status");
    expect(args).toContain("--if-assignee");
  });

  it("drops preconditions when the update writes no field", () => {
    // bd rejects a guard without a field update, so attaching one to a no-op
    // would turn a harmless call into a hard failure.
    expect(createUpdateCommandArgs({ id: "bd-1", guard: { ifStatus: "open" } })).toEqual([
      "update",
      "bd-1",
      "--json",
    ]);
  });

  it("still rejects contradictory estimate and type aliases", () => {
    expect(() =>
      createUpdateCommandArgs({ id: "bd-1", estimate: 30, estimated_minutes: 60 })
    ).toThrow(/Conflicting estimate/);
    expect(() =>
      createUpdateCommandArgs({ id: "bd-1", type: "bug", issue_type: "task" })
    ).toThrow(/Conflicting issue type/);
  });
});

describe("parseGuardMismatch", () => {
  it("recovers the live status from bd's mismatch report", () => {
    expect(
      parseGuardMismatch(
        'Error updating bd-1: status mismatch: bd-1 has status "in_progress", expected "open"'
      )
    ).toEqual({ field: "status", actual: "in_progress" });
  });

  it("recovers an empty assignee as the unassigned value it is", () => {
    expect(
      parseGuardMismatch('assignee mismatch: bd-1 is held by "", expected "alice"')
    ).toEqual({ field: "assignee", actual: "" });
  });

  it("still names the field when the phrasing no longer parses", () => {
    // A bd rewording costs the notification one value, never the detection.
    expect(parseGuardMismatch("status mismatch happened")).toEqual({ field: "status" });
  });

  it("reports nothing for output that is not a guard mismatch", () => {
    expect(parseGuardMismatch("some other failure")).toBeNull();
  });
});

/** Reproduces what execFile throws for a bd process that exited non-zero. */
function exitWith(code: number, stdout: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed with exit code ${code}`), {
    code,
    stdout,
    stderr,
  });
}

// Verified against bd 1.2.1: a stale guard prints the machine-readable report
// on stdout, the human message on stderr, and exits 13.
const GUARD_MISMATCH_STDOUT = JSON.stringify({
  error: "1 of 1 issues failed to update",
  failed: [
    {
      id: "bd-1",
      error: 'updating issue: status mismatch: bd-1 has status "in_progress", expected "open"',
      guard_mismatch: true,
    },
  ],
});
const GUARD_MISMATCH_STDERR =
  'Error updating bd-1: status mismatch: bd-1 has status "in_progress", expected "open"';

function updateRunner(onUpdate: (args: string[]) => { stdout: string; stderr: string }) {
  return new StubRunner((args) => {
    if (args[0] === "version" || args[0] === "--version") {
      return { stdout: "bd version 1.2.1", stderr: "" };
    }
    return onUpdate(args);
  });
}

describe("BeadsCommandRunner.update", () => {
  it("reports a conflict instead of throwing when bd exits 13", async () => {
    const runner = updateRunner(() => {
      throw exitWith(GUARD_MISMATCH_EXIT_CODE, GUARD_MISMATCH_STDOUT, GUARD_MISMATCH_STDERR);
    });

    const outcome = await runner.update({
      id: "bd-1",
      status: "blocked",
      guard: { ifStatus: "open" },
    });

    expect(outcome).toEqual({
      ok: false,
      conflict: {
        id: "bd-1",
        field: "status",
        expected: "open",
        actual: "in_progress",
        attempted: "blocked",
      },
    });
  });

  it("names the guarded field even when bd's message cannot be parsed", async () => {
    const runner = updateRunner(() => {
      throw exitWith(GUARD_MISMATCH_EXIT_CODE, "", "refused");
    });

    const outcome = await runner.update({
      id: "bd-1",
      assignee: "connor",
      guard: { ifAssignee: "agent-7" },
    });

    expect(outcome).toEqual({
      ok: false,
      conflict: {
        id: "bd-1",
        field: "assignee",
        expected: "agent-7",
        actual: undefined,
        attempted: "connor",
      },
    });
  });

  it("keeps throwing for failures that are not a stale precondition", async () => {
    // Exit 1 is bd saying the command broke; nothing about it is recoverable
    // by showing the user current values.
    const runner = updateRunner(() => {
      throw exitWith(1, "", "issue not found: bd-1");
    });

    await expect(
      runner.update({ id: "bd-1", status: "closed", guard: { ifStatus: "open" } })
    ).rejects.toThrow("issue not found: bd-1");
  });

  it("returns the written issue when the precondition holds", async () => {
    const runner = updateRunner(() => ({
      stdout: JSON.stringify([{ id: "bd-1", status: "in_progress" }]),
      stderr: "",
    }));

    const outcome = await runner.update({
      id: "bd-1",
      status: "in_progress",
      guard: { ifStatus: "open" },
    });

    expect(outcome).toEqual({ ok: true, issue: { id: "bd-1", status: "in_progress" } });
    expect(runner.calls).toContainEqual([
      "update",
      "bd-1",
      "--json",
      "--status",
      "in_progress",
      "--if-status",
      "open",
    ]);
  });
});
