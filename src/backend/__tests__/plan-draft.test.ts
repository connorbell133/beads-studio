import {
  PlanDraft,
  derivePlanGraph,
  hasBlockingErrors,
  planDraftToGraphInput,
  validatePlanDraft,
} from "../plan-draft";

function draft(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    epic: { key: "epic", title: "Ship the thing", type: "epic", priority: 1 },
    tasks: [
      { key: "t1", title: "Design it", type: "task", priority: 2 },
      { key: "t2", title: "Build it", type: "task", priority: 2 },
    ],
    blocks: [{ from: "t2", to: "t1" }],
    ...overrides,
  };
}

const errorsOf = (plan: PlanDraft): string[] =>
  validatePlanDraft(plan)
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.message);

const warningsOf = (plan: PlanDraft): string[] =>
  validatePlanDraft(plan)
    .filter((issue) => issue.severity === "warning")
    .map((issue) => issue.message);

describe("planDraftToGraphInput", () => {
  it("emits epic membership as parent-child and sequencing as blocks", () => {
    const { nodes, edges } = planDraftToGraphInput(draft());

    expect(nodes.map((n) => n.id)).toEqual(["epic", "t1", "t2"]);
    expect(edges).toEqual([
      { from: "t1", to: "epic", type: "parent-child" },
      { from: "t2", to: "epic", type: "parent-child" },
      { from: "t2", to: "t1", type: "blocks" },
    ]);
  });

  it("drops a blocking edge whose endpoint is not in the draft", () => {
    const { edges } = planDraftToGraphInput(
      draft({ blocks: [{ from: "t2", to: "ghost" }] })
    );

    expect(edges.filter((edge) => edge.type === "blocks")).toEqual([]);
  });
});

describe("derivePlanGraph", () => {
  it("marks only the unblocked task ready, leaving the blocked one waiting", () => {
    const graph = derivePlanGraph(draft());

    expect(graph.ready).toContain("t1");
    expect(graph.ready).not.toContain("t2");
    expect(graph.nodes.t2.blockedBy).toEqual(["t1"]);
  });

  it("does not let epic membership block a task", () => {
    const graph = derivePlanGraph(draft({ blocks: [] }));

    expect(graph.ready).toEqual(expect.arrayContaining(["t1", "t2"]));
    expect(graph.nodes.t1.parent).toBe("epic");
  });

  it("sees a cycle the composer drew", () => {
    const graph = derivePlanGraph(
      draft({
        blocks: [
          { from: "t1", to: "t2" },
          { from: "t2", to: "t1" },
        ],
      })
    );

    expect(graph.hasCycle).toBe(true);
  });
});

describe("validatePlanDraft", () => {
  it("passes a well-formed plan", () => {
    expect(validatePlanDraft(draft())).toEqual([]);
    expect(hasBlockingErrors(validatePlanDraft(draft()))).toBe(false);
  });

  it("rejects a plan with no tasks", () => {
    expect(errorsOf(draft({ tasks: [], blocks: [] }))).toContain(
      "An epic needs at least one task."
    );
  });

  it("rejects a blank title on the epic and on a task", () => {
    expect(
      errorsOf(draft({ epic: { key: "epic", title: "   ", type: "epic", priority: 1 } }))
    ).toContain("The epic needs a title.");

    expect(
      errorsOf(
        draft({
          tasks: [{ key: "t1", title: "", type: "task", priority: 2 }],
          blocks: [],
        })
      )
    ).toContain("A task needs a title.");
  });

  it("rejects a title that would break the line-oriented batch grammar", () => {
    const errors = errorsOf(
      draft({
        tasks: [{ key: "t1", title: "Two\nlines", type: "task", priority: 2 }],
        blocks: [],
      })
    );

    expect(errors).toContain("A task title must be a single line of text.");
  });

  it("rejects an out-of-range priority", () => {
    expect(
      errorsOf(
        draft({
          tasks: [{ key: "t1", title: "Do it", type: "task", priority: 9 }],
          blocks: [],
        })
      )
    ).toContain("A task priority must be P0-P4.");
  });

  it("rejects a duplicate key", () => {
    const errors = errorsOf(
      draft({
        tasks: [
          { key: "t1", title: "One", type: "task", priority: 2 },
          { key: "t1", title: "Two", type: "task", priority: 2 },
        ],
        blocks: [],
      })
    );

    expect(errors).toContain('Duplicate key "t1".');
  });

  it("rejects a self-blocking task", () => {
    expect(errorsOf(draft({ blocks: [{ from: "t1", to: "t1" }] }))).toContain(
      '"Design it" cannot wait on itself.'
    );
  });

  it("rejects an edge pointing outside the plan", () => {
    expect(errorsOf(draft({ blocks: [{ from: "t1", to: "ghost" }] }))).toContain(
      "A blocking link points at an issue that is not in this plan."
    );
  });

  it("refuses to sequence the epic against its own tasks", () => {
    expect(errorsOf(draft({ blocks: [{ from: "t1", to: "epic" }] }))).toContain(
      "The epic holds its tasks; it cannot block them or wait on them."
    );
  });

  it("names the loop when tasks wait on each other", () => {
    const errors = errorsOf(
      draft({
        blocks: [
          { from: "t1", to: "t2" },
          { from: "t2", to: "t1" },
        ],
      })
    );

    expect(errors.some((message) => message.startsWith("These tasks wait on each other"))).toBe(
      true
    );
    expect(errors.some((message) => message.includes("Design it"))).toBe(true);
  });

  it("warns rather than blocks on a duplicated blocker", () => {
    const plan = draft({
      blocks: [
        { from: "t2", to: "t1" },
        { from: "t2", to: "t1" },
      ],
    });

    expect(hasBlockingErrors(validatePlanDraft(plan))).toBe(false);
    expect(warningsOf(plan)).toContain('"Build it" lists the same blocker twice.');
  });

  it("warns rather than blocks on two issues with the same title", () => {
    const plan = draft({
      tasks: [
        { key: "t1", title: "Build it", type: "task", priority: 2 },
        { key: "t2", title: "build it", type: "task", priority: 2 },
      ],
      blocks: [],
    });

    expect(hasBlockingErrors(validatePlanDraft(plan))).toBe(false);
    expect(warningsOf(plan)).toContain('Two issues are titled "build it".');
  });
});
