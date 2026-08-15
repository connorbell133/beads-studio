import {
  buildCreateScript,
  buildEdgeScript,
  commitPlanDraft,
  describeBatchFailure,
  quoteBatchToken,
  readCreatedIds,
} from "../plan-batch";
import { PlanDraft } from "../plan-draft";

function draft(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    epic: { key: "epic", title: "Ship the thing", type: "epic", priority: 1 },
    tasks: [
      { key: "t1", title: "Design it", type: "task", priority: 2 },
      { key: "t2", title: "Build it", type: "feature", priority: 0 },
    ],
    blocks: [{ from: "t2", to: "t1" }],
    ...overrides,
  };
}

/** What bd emits for a script of N successful creates. */
function createdResult(ids: string[]): unknown {
  return {
    status: "ok",
    operations: ids.length,
    results: ids.map((target, index) => ({ line: index + 1, op: "create", target })),
  };
}

describe("quoteBatchToken", () => {
  it("quotes unconditionally, so a one-word title stays one token", () => {
    expect(quoteBatchToken("Ship")).toBe('"Ship"');
  });

  it("escapes the two characters the batch grammar reserves", () => {
    expect(quoteBatchToken('Say "hi"')).toBe('"Say \\"hi\\""');
    expect(quoteBatchToken("a\\b")).toBe('"a\\\\b"');
  });

  it("escapes a backslash before a quote without eating the quote", () => {
    expect(quoteBatchToken('back\\ "x"')).toBe('"back\\\\ \\"x\\""');
  });
});

describe("buildCreateScript", () => {
  it("writes one create per node, epic first, in type/priority/title order", () => {
    const { script, keysByLine } = buildCreateScript(draft());

    expect(script).toBe(
      'create epic 1 "Ship the thing"\n' +
        'create task 2 "Design it"\n' +
        'create feature 0 "Build it"\n'
    );
    expect(keysByLine).toEqual(["epic", "t1", "t2"]);
  });

  it("trims titles rather than sending the user's stray whitespace to bd", () => {
    const { script } = buildCreateScript(
      draft({ tasks: [{ key: "t1", title: "  Design it  ", type: "task", priority: 2 }] })
    );

    expect(script).toContain('create task 2 "Design it"');
  });
});

describe("readCreatedIds", () => {
  it("maps keys onto ids by the line bd reports", () => {
    const ids = readCreatedIds(createdResult(["bd-a", "bd-b", "bd-c"]), ["epic", "t1", "t2"]);

    expect(ids).toEqual({ epic: "bd-a", t1: "bd-b", t2: "bd-c" });
  });

  it("uses the reported line, not the array position", () => {
    const out = {
      results: [
        { line: 3, op: "create", target: "bd-c" },
        { line: 1, op: "create", target: "bd-a" },
        { line: 2, op: "create", target: "bd-b" },
      ],
    };

    expect(readCreatedIds(out, ["epic", "t1", "t2"])).toEqual({
      epic: "bd-a",
      t1: "bd-b",
      t2: "bd-c",
    });
  });

  it("throws rather than silently mis-attaching a missing id", () => {
    const out = { results: [{ line: 1, op: "create", target: "bd-a" }] };

    expect(() => readCreatedIds(out, ["epic", "t1"])).toThrow(/line 2/);
  });

  it("throws when bd reports no results at all", () => {
    expect(() => readCreatedIds({ status: "ok" }, ["epic"])).toThrow(/did not report/);
  });
});

describe("buildEdgeScript", () => {
  const ids = { epic: "bd-a", t1: "bd-b", t2: "bd-c" };

  it("links membership with parent-child and sequencing with blocks", () => {
    expect(buildEdgeScript(draft(), ids)).toBe(
      "dep add bd-b bd-a parent-child\n" +
        "dep add bd-c bd-a parent-child\n" +
        "dep add bd-c bd-b blocks\n"
    );
  });

  it("points a blocking edge from the waiting task to its blocker", () => {
    const script = buildEdgeScript(draft({ blocks: [{ from: "t2", to: "t1" }] }), ids);

    // `bd dep add <from> <to>` means from waits on to: "Build it" waits on "Design it".
    expect(script).toContain("dep add bd-c bd-b blocks");
    expect(script).not.toContain("dep add bd-b bd-c blocks");
  });

  it("returns an empty script when there is nothing to link", () => {
    expect(buildEdgeScript({ ...draft(), tasks: [], blocks: [] }, ids)).toBe("");
  });
});

describe("describeBatchFailure", () => {
  it("replaces bd's raw line with the title that line was for", () => {
    const message = describeBatchFailure(
      new Error('line 2 (create task 2 "Design it"): prefix mismatch'),
      "create",
      ["Ship the thing", "Design it", "Build it"]
    );

    expect(message).toContain("Design it: prefix mismatch");
    expect(message).toContain("Nothing was created");
  });

  it("says no dependencies landed when the link batch is the one that failed", () => {
    const message = describeBatchFailure(
      new Error("line 1 (dep add bd-b bd-a parent-child): issue bd-a not found"),
      "link",
      ['"Design it" under "Ship the thing"']
    );

    expect(message).toContain('"Design it" under "Ship the thing": issue bd-a not found');
    expect(message).toContain("No dependencies were added");
  });

  it("names the real problem when the installed bd has no batch subcommand", () => {
    const message = describeBatchFailure(
      new Error('unknown command "batch" for "bd"'),
      "create",
      ["Ship the thing"]
    );

    expect(message).toContain("no `bd batch`");
    expect(message).not.toContain("rolled the whole batch back");
  });

  it("keeps an unparseable error intact rather than dropping it", () => {
    const message = describeBatchFailure(new Error("dolt server is down"), "create", []);

    expect(message).toContain("dolt server is down");
    expect(message).toContain("rolled the whole batch back");
  });
});

describe("commitPlanDraft", () => {
  it("creates every node in one batch, then every edge in a second", async () => {
    const scripts: string[] = [];
    const runBatch = jest.fn(async (script: string) => {
      scripts.push(script);
      return scripts.length === 1 ? createdResult(["bd-a", "bd-b", "bd-c"]) : { status: "ok" };
    });

    const result = await commitPlanDraft(draft(), runBatch);

    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(scripts[0].split("\n").filter(Boolean)).toHaveLength(3);
    expect(scripts[1].split("\n").filter(Boolean)).toHaveLength(3);
    expect(result).toEqual({
      ok: true,
      epicId: "bd-a",
      ids: { epic: "bd-a", t1: "bd-b", t2: "bd-c" },
      taskCount: 2,
      edgeCount: 1,
    });
  });

  it("refuses an invalid draft without touching bd", async () => {
    const runBatch = jest.fn();

    const result = await commitPlanDraft(draft({ tasks: [], blocks: [] }), runBatch);

    expect(runBatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, stage: "validate", createdIds: [] });
  });

  it("reports nothing created when the create batch rolls back", async () => {
    const runBatch = jest.fn(async () => {
      throw new Error('line 2 (create task 2 "Design it"): boom');
    });

    const result = await commitPlanDraft(draft(), runBatch);

    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, stage: "create", createdIds: [] });
    if (!result.ok) {
      expect(result.message).toContain("Design it: boom");
    }
  });

  it("names the issues that survive a failed link batch", async () => {
    let call = 0;
    const runBatch = jest.fn(async () => {
      call += 1;
      if (call === 1) return createdResult(["bd-a", "bd-b", "bd-c"]);
      throw new Error("line 3 (dep add bd-c bd-b blocks): would create a cycle");
    });

    const result = await commitPlanDraft(draft(), runBatch);

    expect(result).toMatchObject({
      ok: false,
      stage: "link",
      createdIds: ["bd-a", "bd-b", "bd-c"],
    });
    if (!result.ok) {
      expect(result.message).toContain('"Build it" waiting on "Design it"');
    }
  });

  it("skips the second batch when a plan has nothing to link", async () => {
    const runBatch = jest.fn(async () => createdResult(["bd-a", "bd-b"]));
    const plan: PlanDraft = {
      epic: { key: "epic", title: "Solo", type: "epic", priority: 2 },
      tasks: [{ key: "t1", title: "Only task", type: "task", priority: 2 }],
      blocks: [],
    };

    // One task still gets a parent-child edge, so the link batch does run.
    const result = await commitPlanDraft(plan, runBatch);

    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, epicId: "bd-a", taskCount: 1, edgeCount: 0 });
  });
});
