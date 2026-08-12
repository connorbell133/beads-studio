import {
  BUILT_IN_STATUSES,
  edgesFromIssue,
  edgesFromIssues,
  issueToWebviewBead,
  normalizeEdge,
  normalizeStatus,
} from "../types";

describe("normalizeStatus", () => {
  it("maps every bd built-in status to itself", () => {
    for (const status of BUILT_IN_STATUSES) {
      expect(normalizeStatus(status)).toBe(status);
    }
  });

  it("canonicalizes known aliases", () => {
    expect(normalizeStatus("in-progress")).toBe("in_progress");
    expect(normalizeStatus("active")).toBe("in_progress");
    expect(normalizeStatus("done")).toBe("closed");
    expect(normalizeStatus("completed")).toBe("closed");
    expect(normalizeStatus("cancelled")).toBe("closed");
    expect(normalizeStatus("OPEN")).toBe("open");
  });

  it("passes custom statuses through verbatim so they round-trip to bd", () => {
    // bd allows user-defined statuses via `bd config set status.custom`.
    expect(normalizeStatus("awaiting_review")).toBe("awaiting_review");
    expect(normalizeStatus("awaiting-review")).toBe("awaiting-review");
  });

  it("returns null only when the status is absent", () => {
    expect(normalizeStatus(undefined)).toBeNull();
    expect(normalizeStatus("")).toBeNull();
    expect(normalizeStatus("   ")).toBeNull();
  });
});

describe("issueToWebviewBead", () => {
  const base = {
    id: "bd-1",
    title: "t",
    priority: 2,
    issue_type: "task",
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
  };

  it("keeps beads whose status bd added after the original four", () => {
    // Regression: these used to normalize to null and get filtered out of
    // every view, so `bd defer` made an issue vanish from the extension.
    for (const status of ["deferred", "pinned", "hooked"]) {
      expect(issueToWebviewBead({ ...base, status })?.status).toBe(status);
    }
  });

  it("keeps beads with a custom status", () => {
    expect(issueToWebviewBead({ ...base, status: "awaiting_review" })?.status).toBe(
      "awaiting_review"
    );
  });

  it("still drops beads with no status at all", () => {
    expect(issueToWebviewBead({ ...base, status: "" })).toBeNull();
  });

  it("keeps hydrating bd show dependencies with their display metadata", () => {
    const bead = issueToWebviewBead({
      ...base,
      status: "open",
      dependencies: [
        { id: "bd-2", dependency_type: "blocks", issue_type: "bug", title: "B", status: "open", priority: 1 },
      ],
      dependents: [{ id: "bd-3", dependency_type: "parent-child", title: "C" }],
    });
    expect(bead?.dependsOn).toEqual([
      {
        id: "bd-2",
        type: "bug",
        dependencyType: "blocks",
        title: "B",
        status: "open",
        priority: 1,
      },
    ]);
    expect(bead?.blocks?.[0]).toMatchObject({ id: "bd-3", dependencyType: "parent-child" });
  });

  it("drops bd list dependencies from the hydrated lists instead of rendering blank rows", () => {
    // Regression: the list wire shape has no `id`, so every entry used to
    // hydrate as `{ id: undefined }` and render as an empty dependency row.
    const bead = issueToWebviewBead({
      ...base,
      status: "open",
      dependencies: [{ issue_id: "bd-1", depends_on_id: "bd-2", type: "blocks" }],
    });
    expect(bead?.dependsOn).toEqual([]);
  });
});

describe("normalizeEdge", () => {
  it("reads the bd list shape, which names both endpoints", () => {
    expect(normalizeEdge("", { issue_id: "a", depends_on_id: "b", type: "blocks" })).toEqual({
      from: "a",
      to: "b",
      type: "blocks",
    });
  });

  it("reads the bd show shape, taking the near end from the owner", () => {
    expect(normalizeEdge("a", { id: "b", dependency_type: "blocks" }, "dependency")).toEqual({
      from: "a",
      to: "b",
      type: "blocks",
    });
  });

  it("orients a bd show dependent entry the other way", () => {
    // Same edge as above, seen from b: b is blocked by nothing, a is blocked by b.
    expect(normalizeEdge("b", { id: "a", dependency_type: "blocks" }, "dependent")).toEqual({
      from: "a",
      to: "b",
      type: "blocks",
    });
  });

  it("drops an entry missing an endpoint rather than emitting half an edge", () => {
    expect(normalizeEdge("a", { issue_id: "a", type: "blocks" })).toBeNull();
    expect(normalizeEdge("", { id: "b", dependency_type: "blocks" })).toBeNull();
    expect(normalizeEdge("a", { dependency_type: "blocks" })).toBeNull();
    expect(normalizeEdge("a", null)).toBeNull();
    expect(normalizeEdge("a", "nonsense")).toBeNull();
  });

  it("passes an unrecognized type through verbatim", () => {
    // bd allows custom dependency types the same way it allows custom statuses.
    expect(normalizeEdge("a", { id: "b", dependency_type: "supersedes" })?.type).toBe("supersedes");
  });

  it("defaults a missing type to blocks so readiness fails safe", () => {
    // An untyped edge must never be silently downgraded to a non-gating type:
    // over-reporting blocked is recoverable, over-reporting ready is not.
    expect(normalizeEdge("a", { issue_id: "a", depends_on_id: "b" })?.type).toBe("blocks");
    expect(normalizeEdge("a", { id: "b", dependency_type: "  " })?.type).toBe("blocks");
  });
});

describe("edgesFromIssue", () => {
  it("extracts every inline edge from one bead", () => {
    expect(
      edgesFromIssue({
        id: "a",
        dependencies: [
          { issue_id: "a", depends_on_id: "b", type: "blocks" },
          { issue_id: "a", depends_on_id: "c", type: "parent-child" },
        ],
      })
    ).toEqual([
      { from: "a", to: "b", type: "blocks" },
      { from: "a", to: "c", type: "parent-child" },
    ]);
  });

  it("keeps the surviving edges when one entry is malformed", () => {
    expect(
      edgesFromIssue({
        id: "a",
        dependencies: [
          { issue_id: "a", type: "blocks" },
          { issue_id: "a", depends_on_id: "c", type: "blocks" },
        ],
      })
    ).toEqual([{ from: "a", to: "c", type: "blocks" }]);
  });

  it("returns no edges for a bead with no dependency arrays", () => {
    expect(edgesFromIssue({ id: "a" })).toEqual([]);
  });
});

describe("edgesFromIssues", () => {
  it("collects edges across a whole list payload", () => {
    const edges = edgesFromIssues([
      { id: "a", dependencies: [{ issue_id: "a", depends_on_id: "b", type: "blocks" }] },
      { id: "b", dependencies: [] },
      { id: "c", dependencies: [{ issue_id: "c", depends_on_id: "b", type: "blocks" }] },
    ]);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from: "a", to: "b", type: "blocks" });
    expect(edges).toContainEqual({ from: "c", to: "b", type: "blocks" });
  });

  it("dedupes an edge reported from both of its endpoints", () => {
    // A bd show payload names the same edge in a's dependencies and b's dependents.
    expect(
      edgesFromIssues([
        { id: "a", dependencies: [{ id: "b", dependency_type: "blocks" }] },
        { id: "b", dependents: [{ id: "a", dependency_type: "blocks" }] },
      ])
    ).toEqual([{ from: "a", to: "b", type: "blocks" }]);
  });

  it("keeps two different edge types between the same pair", () => {
    expect(
      edgesFromIssues([
        {
          id: "a",
          dependencies: [
            { issue_id: "a", depends_on_id: "b", type: "blocks" },
            { issue_id: "a", depends_on_id: "b", type: "related" },
          ],
        },
      ])
    ).toHaveLength(2);
  });
});
