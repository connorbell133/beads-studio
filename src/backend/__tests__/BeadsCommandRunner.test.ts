import * as vscode from "vscode";
import {
  BeadsCommandRunner,
  createListCommandArgs,
  createShowCommandArgs,
  detectListCapabilities,
  parseHumanNeeded,
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

describe("parseHumanNeeded", () => {
  it("reads the ids out of a human list payload", () => {
    expect(
      parseHumanNeeded([
        { id: "bd-1", title: "Pick an auth scheme", labels: ["human"] },
        { id: "bd-2", title: "Approve the schema" },
      ])
    ).toEqual(["bd-1", "bd-2"]);
  });

  it("treats bd's empty-inbox null as an empty list, not a failure", () => {
    // Verified against bd 1.2.1: `bd human list --json` prints a bare `null`
    // when nothing is waiting. An empty inbox is the common case, so reading it
    // as a parse error would mark the surface degraded almost all the time.
    expect(parseHumanNeeded(null)).toEqual([]);
  });

  it("drops entries with no usable id", () => {
    // The ids become set members. One `undefined` would match every bead that
    // also has no id, which is how a filter turns into a passthrough.
    expect(parseHumanNeeded([{ id: "bd-1" }, {}, { id: "" }, null, "bd-3"])).toEqual(["bd-1"]);
  });
});

describe("BeadsCommandRunner human verbs", () => {
  it("asks bd for its own human list", async () => {
    const runner = new StubRunner((args) => {
      if (args[0] === "version") return { stdout: "bd version 1.2.1", stderr: "" };
      return { stdout: JSON.stringify([{ id: "bd-7" }]), stderr: "" };
    });

    const payload = await runner.listHumanNeeded();

    expect(payload).toEqual({ ids: ["bd-7"], supported: true });
    expect(runner.calls).toContainEqual(["human", "list", "--json"]);
  });

  it("reports unsupported rather than throwing when bd has no human command", async () => {
    // The inbox has a correct fallback - the label is already on every bead -
    // so an older bd costs the user a caveat, never the surface.
    const runner = new StubRunner((args) => {
      if (args[0] === "version") return { stdout: "bd version 1.0.5", stderr: "" };
      throw new Error('unknown command "human" for "bd"');
    });

    expect(await runner.listHumanNeeded()).toEqual({ ids: [], supported: false });
  });

  it("responds and dismisses through bd's own verbs", async () => {
    const runner = new StubRunner((args) => {
      if (args[0] === "version") return { stdout: "bd version 1.2.1", stderr: "" };
      // bd prints prose for these even with --json, which is why neither call
      // parses its output.
      return { stdout: "Bead bd-1 closed with response.", stderr: "" };
    });

    await runner.humanRespond({ id: "bd-1", response: "Use OAuth2" });
    await runner.humanDismiss({ id: "bd-2", reason: "No longer applicable" });
    await runner.humanDismiss({ id: "bd-3" });

    expect(runner.calls).toContainEqual(["human", "respond", "bd-1", "--response", "Use OAuth2"]);
    expect(runner.calls).toContainEqual([
      "human",
      "dismiss",
      "bd-2",
      "--reason",
      "No longer applicable",
    ]);
    expect(runner.calls).toContainEqual(["human", "dismiss", "bd-3"]);
  });
});
