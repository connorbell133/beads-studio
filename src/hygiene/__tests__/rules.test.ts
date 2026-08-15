import { deriveGraph } from "../../graph/BeadsGraph";
import { BeadsGraphModel } from "../../graph/types";
import {
  COMMIT_REFERENCED_RULE_CODE,
  DUPLICATE_RULE_CODE,
  HYGIENE_RULES,
  LOCAL_RULES,
  MISSING_SECTIONS_RULE_CODE,
  SHELL_RULES,
  SIMILAR_RULE_CODE,
  STALE_RULE_CODE,
  commitReferencedRule,
  cycleRule,
  duplicateRule,
  looseWork,
  looseWorkRule,
  missingSectionsRule,
  parseCommitReferenced,
  parseDuplicates,
  parseLint,
  parseSimilar,
  parseStale,
  runRules,
  similarRule,
  staleRule,
} from "../rules";
import { HygieneContext, HygieneFinding, HygieneRule, MAX_FINDINGS_PER_RULE } from "../types";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-14T00:00:00Z");

function context(overrides: Partial<HygieneContext> = {}): HygieneContext {
  return {
    graph: null,
    runBdJson: async () => null,
    staleDays: 30,
    similarityThreshold: 0.5,
    now: NOW,
    ...overrides,
  };
}

/** A context whose bd calls answer from a fixture keyed by the subcommand. */
function bdContext(
  responses: Record<string, unknown>,
  overrides: Partial<HygieneContext> = {}
): { ctx: HygieneContext; calls: string[][] } {
  const calls: string[][] = [];
  const ctx = context({
    runBdJson: async (args) => {
      calls.push(args);
      if (!(args[0] in responses)) throw new Error(`unknown bd command: ${args[0]}`);
      return responses[args[0]];
    },
    ...overrides,
  });
  return { ctx, calls };
}

/** A local rule's findings. Local rules never return a promise, by contract. */
function local(rule: HygieneRule, graph: BeadsGraphModel | null): HygieneFinding[] {
  return rule.run(context({ graph })) as HygieneFinding[];
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

describe("the rule set", () => {
  it("splits into a free tier and a shelling tier, with nothing in both", () => {
    expect(LOCAL_RULES.length + SHELL_RULES.length).toBe(HYGIENE_RULES.length);
    expect(LOCAL_RULES.every((rule) => rule.tier === "local")).toBe(true);
    expect(SHELL_RULES.every((rule) => rule.tier === "shell")).toBe(true);
  });

  it("gives every rule a distinct code, since the code is the Problems tag", () => {
    const codes = HYGIENE_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("does not run bd doctor or bd preflight", async () => {
    const { ctx, calls } = bdContext({
      lint: {},
      stale: [],
      duplicates: {},
      "find-duplicates": {},
      orphans: null,
    });

    await runRules(SHELL_RULES, ctx);

    const subcommands = calls.map((args) => args[0]);
    expect(subcommands).not.toContain("doctor");
    expect(subcommands).not.toContain("preflight");
  });

  it("loses only the failing rule's findings when one rule throws", async () => {
    const failing: HygieneRule = {
      code: "boom",
      title: "boom",
      tier: "shell",
      run: () => {
        throw new Error("bd is not on PATH");
      },
    };
    const working: HygieneRule = {
      code: "fine",
      title: "fine",
      tier: "shell",
      run: () => [{ code: "fine", severity: "info", message: "still here", beadIds: [] }],
    };
    const seen: string[] = [];

    const findings = await runRules([failing, working], context(), (rule) => seen.push(rule.code));

    expect(findings.map((f) => f.code)).toEqual(["fine"]);
    expect(seen).toEqual(["boom"]);
  });
});

describe("dependency-cycle rule", () => {
  it("names every id in a three-bead cycle", () => {
    const graph = deriveGraph(
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

    const findings = local(cycleRule, graph);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("bd-a");
    expect(findings[0].message).toContain("bd-c");
  });

  it("orders cycles and their members the same however they arrive", () => {
    const forward = local(
      cycleRule,
      model({ cycles: [["bd-z", "bd-y"], ["bd-b", "bd-a"]], hasCycle: true })
    );
    const reversed = local(
      cycleRule,
      model({ cycles: [["bd-a", "bd-b"], ["bd-y", "bd-z"]], hasCycle: true })
    );

    expect(forward.map((f) => f.message)).toEqual(reversed.map((f) => f.message));
  });
});

describe("loose-work rule", () => {
  /** An epic with one child, plus whatever standalone beads the caller names. */
  function withHierarchy(loose: string[]): BeadsGraphModel {
    return deriveGraph(
      [
        { id: "bd-epic", status: "open", issue_type: "epic" },
        { id: "bd-child", status: "open", issue_type: "task", parent: "bd-epic" },
        ...loose.map((id) => ({ id, status: "open", issue_type: "task" })),
      ],
      []
    );
  }

  it("reports open beads with no parent and no children", () => {
    expect(looseWork(withHierarchy(["bd-loose"]))).toEqual(["bd-loose"]);
  });

  it("does not report the epic itself, which has children", () => {
    expect(looseWork(withHierarchy([]))).toEqual([]);
  });

  it("stays silent on a project that does not use hierarchy at all", () => {
    const flat = deriveGraph(
      [
        { id: "bd-1", status: "open", issue_type: "task" },
        { id: "bd-2", status: "open", issue_type: "task" },
      ],
      []
    );

    expect(looseWork(flat)).toEqual([]);
  });

  it("ignores closed work, which is not a hygiene problem", () => {
    const graph = deriveGraph(
      [
        { id: "bd-epic", status: "open", issue_type: "epic" },
        { id: "bd-child", status: "open", issue_type: "task", parent: "bd-epic" },
        { id: "bd-done", status: "closed", issue_type: "task" },
      ],
      []
    );

    expect(looseWork(graph)).toEqual([]);
  });

  it("ignores coordination beads, which are not work", () => {
    const graph = deriveGraph(
      [
        { id: "bd-epic", status: "open", issue_type: "epic" },
        { id: "bd-child", status: "open", issue_type: "task", parent: "bd-epic" },
        { id: "bd-gate", status: "open", issue_type: "gate" },
      ],
      []
    );

    expect(looseWork(graph)).toEqual([]);
  });

  it("reports blocked work too, which is loose whether or not it is ready", () => {
    const graph = deriveGraph(
      [
        { id: "bd-epic", status: "open", issue_type: "epic" },
        { id: "bd-child", status: "open", issue_type: "task", parent: "bd-epic" },
        { id: "bd-stuck", status: "open", issue_type: "task" },
        { id: "bd-blocker", status: "open", issue_type: "task" },
      ],
      [{ from: "bd-stuck", to: "bd-blocker", type: "blocks" }]
    );

    expect(looseWork(graph)).toContain("bd-stuck");
  });

  it("emits one finding for the whole set rather than one per bead", () => {
    const findings = local(looseWorkRule, withHierarchy(["bd-x", "bd-y", "bd-z"]));

    expect(findings).toHaveLength(1);
    expect(findings[0].beadIds).toEqual(["bd-x", "bd-y", "bd-z"]);
    expect(findings[0].message).toContain("3 open beads");
  });

  it("survives a missing graph", () => {
    expect(looseWork(null)).toEqual([]);
    expect(looseWorkRule.run(context())).toEqual([]);
  });
});

describe("bd lint parsing", () => {
  const payload = {
    total: 14,
    issues: 2,
    results: [
      { id: "bd-b", title: "Second", type: "task", missing: ["## Acceptance Criteria"], warnings: 1 },
      { id: "bd-a", title: "First", type: "bug", missing: ["## Steps to Reproduce"], warnings: 1 },
      { id: "bd-clean", title: "Clean", type: "chore", missing: [], warnings: 0 },
    ],
  };

  it("keeps only beads with missing sections, id-ordered", () => {
    expect(parseLint(payload).map((r) => r.id)).toEqual(["bd-a", "bd-b"]);
  });

  it("treats an unexpected payload as no findings rather than throwing", () => {
    expect(parseLint(null)).toEqual([]);
    expect(parseLint([])).toEqual([]);
    expect(parseLint({ results: "nope" })).toEqual([]);
  });

  it("names the bead and the heading it is missing", async () => {
    const { ctx } = bdContext({ lint: payload });

    const findings = await missingSectionsRule.run(ctx);

    expect(findings).toHaveLength(2);
    expect(findings[0].code).toBe(MISSING_SECTIONS_RULE_CODE);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].message).toContain("bd-a");
    expect(findings[0].message).toContain("## Steps to Reproduce");
  });

  it("collapses the overflow into one row instead of publishing hundreds", async () => {
    const results = Array.from({ length: MAX_FINDINGS_PER_RULE + 5 }, (_, i) => ({
      id: `bd-${String(i).padStart(3, "0")}`,
      title: "t",
      missing: ["## Acceptance Criteria"],
    }));
    const { ctx } = bdContext({ lint: { results } });

    const findings = await missingSectionsRule.run(ctx);

    expect(findings).toHaveLength(MAX_FINDINGS_PER_RULE + 1);
    expect(findings[findings.length - 1].message).toContain("5 further beads");
  });
});

describe("bd stale parsing", () => {
  const payload = [
    { id: "bd-old", title: "Old", status: "open", updated_at: new Date(NOW - 45 * DAY_MS).toISOString() },
  ];

  it("reports whole days since the last update", () => {
    expect(parseStale(payload, NOW)[0].days).toBe(45);
  });

  it("tolerates a missing or unparseable timestamp", () => {
    expect(parseStale([{ id: "bd-x", updated_at: "not a date" }], NOW)[0].days).toBeNull();
    expect(parseStale(null, NOW)).toEqual([]);
  });

  it("asks bd for the configured window and says how long it has been", async () => {
    const { ctx, calls } = bdContext({ stale: payload }, { staleDays: 45 });

    const findings = await staleRule.run(ctx);

    expect(calls[0]).toEqual(["stale", "--days", "45", "--json"]);
    expect(findings[0].code).toBe(STALE_RULE_CODE);
    expect(findings[0].message).toContain("bd-old");
    expect(findings[0].message).toContain("45 days");
    expect(findings[0].message).toContain("still open");
  });

  it("falls back to the window when bd sent no usable timestamp", async () => {
    const { ctx } = bdContext({ stale: [{ id: "bd-x", title: "X", status: "open" }] });

    const findings = await staleRule.run(ctx);

    expect(findings[0].message).toContain("over 30 days");
  });
});

describe("bd duplicates parsing", () => {
  const payload = {
    duplicate_groups: 1,
    groups: [
      {
        title: "Fix the login timeout",
        suggested_target: "bd-keep",
        suggested_sources: ["bd-dup"],
        issues: [{ id: "bd-keep", is_merge_target: true }, { id: "bd-dup", is_merge_target: false }],
      },
    ],
  };

  it("reads bd's own survivor choice rather than picking one", () => {
    expect(parseDuplicates(payload)).toEqual([
      { title: "Fix the login timeout", target: "bd-keep", sources: ["bd-dup"] },
    ]);
  });

  it("drops a group with no survivor or no copies", () => {
    expect(parseDuplicates({ groups: [{ suggested_target: "", suggested_sources: ["a"] }] })).toEqual([]);
    expect(parseDuplicates({ groups: [{ suggested_target: "a", suggested_sources: [] }] })).toEqual([]);
  });

  it("warns per group and offers a fix scoped to that group", async () => {
    const { ctx } = bdContext({ duplicates: payload });

    const findings = await duplicateRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(DUPLICATE_RULE_CODE);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].beadIds).toEqual(["bd-keep", "bd-dup"]);
    expect(findings[0].fix).toEqual({
      key: "duplicate-content:bd-keep",
      title: "Close bd-dup as a duplicate of bd-keep",
      action: { type: "closeDuplicate", sources: ["bd-dup"], target: "bd-keep" },
    });
  });
});

describe("bd find-duplicates parsing", () => {
  const payload = {
    count: 1,
    pairs: [
      {
        issue_a_id: "bd-a",
        issue_a_title: "Login times out",
        issue_b_id: "bd-b",
        issue_b_title: "Session expires too early",
        similarity: 0.62,
      },
    ],
  };

  it("keeps both sides of the pair and the score", () => {
    expect(parseSimilar(payload)[0]).toMatchObject({ a: "bd-a", b: "bd-b", similarity: 0.62 });
  });

  it("uses the mechanical method, never the billed one", async () => {
    const { ctx, calls } = bdContext({ "find-duplicates": payload }, { similarityThreshold: 0.4 });

    await similarRule.run(ctx);

    expect(calls[0]).toEqual([
      "find-duplicates",
      "--method",
      "mechanical",
      "--threshold",
      "0.4",
      "--json",
    ]);
    expect(calls[0]).not.toContain("ai");
  });

  it("reports the score as a percentage", async () => {
    const { ctx } = bdContext({ "find-duplicates": payload });

    const findings = await similarRule.run(ctx);

    expect(findings[0].code).toBe(SIMILAR_RULE_CODE);
    expect(findings[0].message).toContain("62% similar");
    expect(findings[0].beadIds).toEqual(["bd-a", "bd-b"]);
  });
});

describe("bd orphans parsing", () => {
  const payload = [
    {
      issue_id: "bd-b",
      title: "Second",
      status: "open",
      latest_commit: "bd76b4a",
      latest_commit_message: "fix: login timeout (bd-b)",
    },
    { issue_id: "bd-a", title: "First", status: "in_progress" },
  ];

  it("treats bd's literal null for 'none' as an empty result", () => {
    // bd marshals a nil slice, so the no-findings payload is `null`, not `[]`.
    expect(parseCommitReferenced(null)).toEqual([]);
  });

  it("orders by id so the message is stable across runs", () => {
    expect(parseCommitReferenced(payload).map((r) => r.id)).toEqual(["bd-a", "bd-b"]);
  });

  it("emits one finding for the whole set, matching the blast radius of the fix", async () => {
    const { ctx } = bdContext({ orphans: payload });

    const findings = await commitReferencedRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(COMMIT_REFERENCED_RULE_CODE);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].fix).toEqual({
      key: COMMIT_REFERENCED_RULE_CODE,
      title: "Close 2 issues already referenced by commits",
      action: { type: "closeCommitReferenced", ids: ["bd-a", "bd-b"] },
    });
  });

  it("says nothing when nothing is orphaned", async () => {
    const { ctx } = bdContext({ orphans: null });

    expect(await commitReferencedRule.run(ctx)).toEqual([]);
  });
});
