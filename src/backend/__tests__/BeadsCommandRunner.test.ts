import * as vscode from "vscode";
import {
  BeadsCommandRunner,
  createListCommandArgs,
  createShowCommandArgs,
  detectListCapabilities,
  unwrapBdError,
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

/**
 * The version-control reads behind the plan-drift lens.
 *
 * These assert the commands as bd 1.2.1 actually accepts them, which is the
 * part that cannot be inferred from the types: `bd diff` takes two positional
 * refs and rejects relative ones, and `bd history` takes exactly one id.
 */
describe("BeadsCommandRunner drift reads", () => {
  /** Two commits, in `bd history --json`'s own casing. */
  const HISTORY = [
    { CommitHash: "aaaa1111", Committer: "beads", CommitDate: "2026-08-14T10:17:29.334-07:00" },
    { CommitHash: "bbbb2222", Committer: "beads", CommitDate: "2026-08-14T10:12:43.629-07:00" },
  ];

  function driftRunner(overrides: { diff?: unknown; history?: unknown; issues?: unknown[] } = {}) {
    return new StubRunner((args) => {
      if (args[0] === "version") return { stdout: "bd version 1.2.1", stderr: "" };
      if (args.includes("--help")) return { stdout: HELP_WITH_BOTH_FLAGS, stderr: "" };
      if (args[0] === "diff") return { stdout: JSON.stringify(overrides.diff ?? []), stderr: "" };
      if (args[0] === "history") {
        return { stdout: JSON.stringify(overrides.history ?? HISTORY), stderr: "" };
      }
      return { stdout: JSON.stringify(overrides.issues ?? []), stderr: "" };
    });
  }

  it("diffs two positional refs, defaulting the second to HEAD", async () => {
    const runner = driftRunner();

    await runner.diffRefs("abc123");

    expect(runner.calls).toContainEqual(["diff", "abc123", "HEAD", "--json"]);
  });

  it("passes an explicit target ref through", async () => {
    const runner = driftRunner();

    await runner.diffRefs("abc123", "def456");

    expect(runner.calls).toContainEqual(["diff", "abc123", "def456", "--json"]);
  });

  it("hands back the rows bd printed", async () => {
    const runner = driftRunner({
      diff: [{ IssueID: "bd-1", DiffType: "added", OldValue: null, NewValue: { id: "bd-1" } }],
    });

    const entries = await runner.diffRefs("abc123");

    expect(entries).toHaveLength(1);
    expect(entries[0].IssueID).toBe("bd-1");
  });

  it("surfaces bd's error object as a thrown error, never as an empty diff", async () => {
    const runner = driftRunner({ diff: { error: "invalid ref format: HEAD~5" } });

    await expect(runner.diffRefs("HEAD~5")).rejects.toThrow(/invalid ref format/);
  });

  it("reports bd's sentence, not the JSON envelope it failed inside", () => {
    // bd exits 1 with this on stdout and nothing on stderr, so the raw failure
    // message the generic runner throws is the whole blob.
    expect(
      unwrapBdError(
        'Command failed\n{\n  "error": "failed to get diff: invalid ref format: HEAD~5",\n  "schema_version": 1\n}'
      )
    ).toBe("failed to get diff: invalid ref format: HEAD~5");

    expect(unwrapBdError("bd: command not found")).toBe("bd: command not found");
    expect(unwrapBdError("{ not json")).toBe("{ not json");
    expect(unwrapBdError('{"schema_version":1}')).toBe('{"schema_version":1}');
  });

  it("reads history one bead at a time - bd history takes exactly one id", async () => {
    const runner = driftRunner({ issues: [{ id: "bd-1", updated_at: "2026-08-14T10:00:00Z" }] });

    await runner.recentCommits();

    const historyCalls = runner.calls.filter((args) => args[0] === "history");
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0][1]).toBe("bd-1");
    expect(historyCalls[0]).toContain("--json");
  });

  it("samples the most recently touched beads, and bounds how many it spawns", async () => {
    const issues = Array.from({ length: 40 }, (_, index) => ({
      id: `bd-${index}`,
      updated_at: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
    }));
    const runner = driftRunner({ issues });

    await runner.recentCommits();

    const historyCalls = runner.calls.filter((args) => args[0] === "history");
    expect(historyCalls.length).toBeLessThanOrEqual(12);
    // Newest first: bd-39 has the latest updated_at.
    expect(historyCalls[0][1]).toBe("bd-39");
  });

  it("unions and de-duplicates the commits the sampled beads share", async () => {
    const runner = driftRunner({
      issues: [
        { id: "bd-1", updated_at: "2026-08-14T10:00:00Z" },
        { id: "bd-2", updated_at: "2026-08-13T10:00:00Z" },
      ],
    });

    const commits = await runner.recentCommits();

    // Both beads report the same two commits; the listing holds two, newest first.
    expect(commits.map((commit) => commit.hash)).toEqual(["aaaa1111", "bbbb2222"]);
  });

  it("drops history rows with no hash or an unusable date", async () => {
    const runner = driftRunner({
      issues: [{ id: "bd-1", updated_at: "2026-08-14T10:00:00Z" }],
      history: [
        { CommitHash: "", CommitDate: "2026-08-14T10:00:00Z" },
        { CommitHash: "cccc3333", CommitDate: "not a date" },
        { CommitHash: "dddd4444", CommitDate: "2026-08-14T10:00:00Z" },
      ],
    });

    const commits = await runner.recentCommits();

    expect(commits).toEqual([{ hash: "dddd4444", at: "2026-08-14T10:00:00Z" }]);
  });

  it("keeps the picker usable when one bead's history cannot be read", async () => {
    const runner = new StubRunner((args) => {
      if (args[0] === "version") return { stdout: "bd version 1.2.1", stderr: "" };
      if (args.includes("--help")) return { stdout: HELP_WITH_BOTH_FLAGS, stderr: "" };
      if (args[0] === "history") {
        if (args[1] === "bd-broken") throw new Error("issue not found");
        return { stdout: JSON.stringify(HISTORY), stderr: "" };
      }
      return {
        stdout: JSON.stringify([
          { id: "bd-broken", updated_at: "2026-08-14T11:00:00Z" },
          { id: "bd-ok", updated_at: "2026-08-14T10:00:00Z" },
        ]),
        stderr: "",
      };
    });

    const commits = await runner.recentCommits();

    expect(commits.map((commit) => commit.hash)).toEqual(["aaaa1111", "bbbb2222"]);
  });
});
