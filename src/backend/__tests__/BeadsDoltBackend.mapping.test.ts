import { rowToBeadsIssue, rowsToBeadEdges } from "../BeadsDoltBackend";

// The query path needs a live Dolt server. The mapping between what the server
// returns and what the rest of the extension consumes does not, and that
// mapping is where backend parity is won or lost.

describe("rowToBeadsIssue", () => {
  const row = {
    id: "bd-1",
    title: "Fix the thing",
    description: "desc",
    design: "design",
    acceptance_criteria: "ac",
    notes: "notes",
    status: "open",
    priority: 1,
    issue_type: "bug",
    assignee: "connor",
    estimated_minutes: 30,
    external_ref: "gh-9",
    created_at: "2026-08-12T00:00:00Z",
    updated_at: "2026-08-12T01:00:00Z",
    closed_at: null,
  };

  it("maps a full row onto the shared issue shape", () => {
    expect(rowToBeadsIssue(row, ["a", "b"])).toEqual({
      id: "bd-1",
      title: "Fix the thing",
      description: "desc",
      design: "design",
      acceptance_criteria: "ac",
      notes: "notes",
      status: "open",
      priority: 1,
      issue_type: "bug",
      assignee: "connor",
      labels: ["a", "b"],
      estimated_minutes: 30,
      external_ref: "gh-9",
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T01:00:00Z",
      closed_at: undefined,
    });
  });

  it("treats an empty assignee as absent, matching the NULLIF in the query", () => {
    expect(rowToBeadsIssue({ ...row, assignee: "" }).assignee).toBeUndefined();
    expect(rowToBeadsIssue({ ...row, assignee: "   " }).assignee).toBeUndefined();
    expect(rowToBeadsIssue({ ...row, external_ref: "" }).external_ref).toBeUndefined();
  });

  it("falls back to the lowest priority when the column is unusable", () => {
    // Regression: Number(null) is 0, so a null priority used to map to P0
    // Critical - the loudest value in the UI - rather than P4 None.
    expect(rowToBeadsIssue({ ...row, priority: null }).priority).toBe(4);
    expect(rowToBeadsIssue({ ...row, priority: undefined }).priority).toBe(4);
    expect(rowToBeadsIssue({ ...row, priority: "" }).priority).toBe(4);
    expect(rowToBeadsIssue({ ...row, priority: "not a number" }).priority).toBe(4);
  });

  it("keeps a genuine P0 distinct from a missing priority", () => {
    expect(rowToBeadsIssue({ ...row, priority: 0 }).priority).toBe(0);
    expect(rowToBeadsIssue({ ...row, priority: "0" }).priority).toBe(0);
  });

  it("defaults labels to empty rather than undefined", () => {
    expect(rowToBeadsIssue(row).labels).toEqual([]);
  });

  it("keeps a gate row rather than filtering it during mapping", () => {
    // Hidden-type filtering is a display concern. A graph read that dropped
    // gate beads here would leave every edge pointing at one dangling.
    expect(rowToBeadsIssue({ ...row, issue_type: "gate" }).issue_type).toBe("gate");
  });

  it("carries a closed timestamp through when present", () => {
    expect(rowToBeadsIssue({ ...row, closed_at: "2026-08-12T02:00:00Z" }).closed_at).toBe(
      "2026-08-12T02:00:00Z"
    );
  });
});

describe("rowsToBeadEdges", () => {
  it("orients edges the same way the CLI path does", () => {
    // issue_id is the dependent side, the target column is the blocker.
    expect(
      rowsToBeadEdges([{ issue_id: "bd-1", depends_on_id: "bd-2", type: "blocks" }])
    ).toEqual([{ from: "bd-1", to: "bd-2", type: "blocks" }]);
  });

  it("groups rows spanning several issues without losing any", () => {
    const edges = rowsToBeadEdges([
      { issue_id: "a", depends_on_id: "b", type: "blocks" },
      { issue_id: "a", depends_on_id: "c", type: "parent-child" },
      { issue_id: "d", depends_on_id: "b", type: "blocks" },
    ]);
    expect(edges).toHaveLength(3);
    expect(edges).toContainEqual({ from: "a", to: "c", type: "parent-child" });
    expect(edges).toContainEqual({ from: "d", to: "b", type: "blocks" });
  });

  it("drops a row whose target coalesced to null", () => {
    // bd >= 1.1 splits the target across issue/wisp/external columns; a
    // dependency on a non-issue target has nothing an issue graph can resolve.
    expect(
      rowsToBeadEdges([
        { issue_id: "a", depends_on_id: null, type: "blocks" },
        { issue_id: "a", depends_on_id: "b", type: "blocks" },
      ])
    ).toEqual([{ from: "a", to: "b", type: "blocks" }]);
  });

  it("drops a row with no source", () => {
    expect(rowsToBeadEdges([{ issue_id: null, depends_on_id: "b", type: "blocks" }])).toEqual([]);
  });

  it("defaults a missing type to blocks so readiness fails safe", () => {
    expect(rowsToBeadEdges([{ issue_id: "a", depends_on_id: "b", type: null }])).toEqual([
      { from: "a", to: "b", type: "blocks" },
    ]);
  });

  it("keeps an edge whose target is outside the loaded node set", () => {
    // The backend reports what the database says; deciding what an unresolvable
    // blocker means belongs to the derivation layer, which treats it as open.
    expect(
      rowsToBeadEdges([{ issue_id: "a", depends_on_id: "not-loaded", type: "blocks" }])
    ).toEqual([{ from: "a", to: "not-loaded", type: "blocks" }]);
  });

  it("returns nothing for an empty result set", () => {
    expect(rowsToBeadEdges([])).toEqual([]);
  });
});
