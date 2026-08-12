/**
 * Lens tests run over a real derived model rather than a hand-built one, so a
 * change to readiness or hierarchy shows up here instead of drifting apart from
 * what the views actually draw.
 */

import { deriveGraph } from "../BeadsGraph";
import {
  applyLens,
  chooseInitialLens,
  DEFAULT_LENS,
  GRAPH_LENSES,
  LensBead,
  listEpics,
} from "../lens";
import type { BeadsGraphModel, GraphInputEdge, GraphInputNode } from "../types";

const raw = (id: string, over: Partial<GraphInputNode> = {}): GraphInputNode => ({
  id,
  status: "open",
  issue_type: "task",
  priority: 2,
  created_at: "2026-08-12T00:00:00Z",
  ...over,
});

/** `blocks(a, b)` reads "a is blocked by b" - `bd dep add <from> <to>`. */
const blocks = (from: string, to: string): GraphInputEdge => ({ from, to, type: "blocks" });

/** Model plus the bead metadata the lens needs, from one node list. */
function build(
  nodes: GraphInputNode[],
  edges: GraphInputEdge[] = []
): { model: BeadsGraphModel; beads: LensBead[] } {
  return {
    model: deriveGraph(nodes, edges, { complete: true }),
    beads: nodes.map((node) => ({
      id: node.id,
      title: `Bead ${node.id}`,
      type: node.issue_type,
      status: node.status,
    })),
  };
}

const ids = (result: { nodes: Array<{ id: string }> }): string[] =>
  result.nodes.map((node) => node.id).sort();

const pairs = (result: { edges: Array<{ blocker: string; blocked: string }> }): string[] =>
  result.edges.map((edge) => `${edge.blocker}->${edge.blocked}`).sort();

describe("lens catalogue", () => {
  it("opens on the epic lens, never the full graph", () => {
    expect(DEFAULT_LENS).toBe("epic");
    expect(GRAPH_LENSES).toContain("full");
    expect(GRAPH_LENSES).toContain("blast-radius");
  });
});

describe("full lens", () => {
  it("returns every non-coordination node", () => {
    const { model, beads } = build(
      [
        raw("a"),
        raw("b"),
        raw("gate1", { issue_type: "gate" }),
        raw("agent1", { issue_type: "agent" }),
        raw("role1", { issue_type: "role" }),
        raw("msg1", { issue_type: "message" }),
      ],
      [blocks("b", "a")]
    );

    const result = applyLens(model, beads, { lens: "full" });

    expect(ids(result)).toEqual(["a", "b"]);
    expect(pairs(result)).toEqual(["a->b"]);
    expect(result.omitted).toBe(4);
  });

  it("draws a gating coordination bead rather than leaving a hole in the chain", () => {
    // Dropping the gate broke the chain exactly where the ready lane names it
    // as the blocker, so the picture and the lane disagreed about why c was
    // stuck. The real node is drawn instead - muted, because it is not work.
    const { model, beads } = build(
      [raw("a"), raw("gate1", { issue_type: "gate" }), raw("c")],
      [blocks("gate1", "a"), blocks("c", "gate1")]
    );

    const result = applyLens(model, beads, { lens: "full" });

    expect(ids(result).sort()).toEqual(["a", "c", "gate1"]);
    expect(result.nodes.find((n) => n.id === "gate1")?.coordination).toBe(true);
    expect(result.nodes.find((n) => n.id === "a")?.coordination).toBe(false);
    // The chain is continuous and every edge is one bd actually recorded.
    expect(pairs(result)).toEqual(["a->gate1", "gate1->c"]);
  });

  it("still never bridges across a hidden bead", () => {
    // Re-admitting a gate is not the same as inventing c->a. A coordination
    // bead that gates nothing visible stays out entirely.
    const { model, beads } = build(
      [raw("a"), raw("agent1", { issue_type: "agent" })],
      [blocks("agent1", "a")]
    );

    const result = applyLens(model, beads, { lens: "full" });

    expect(ids(result)).toEqual(["a"]);
    expect(result.edges).toEqual([]);
  });

  it("distinguishes containment from sequencing rather than conflating them", () => {
    // parent-child is drawn, but as its own kind. Without it an epic floats
    // unattached to its own members; drawn as a blocks arrow it would claim an
    // order beads never recorded - and would put the epic in blockedCount.
    const { model, beads } = build(
      [raw("epic", { issue_type: "epic" }), raw("child", { parent: "epic" })],
      [
        { from: "child", to: "epic", type: "parent-child" },
        { from: "child", to: "other", type: "related" },
      ]
    );

    const result = applyLens(model, beads, { lens: "full" });

    expect(ids(result)).toEqual(["child", "epic"]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      blocker: "epic",
      blocked: "child",
      kind: "contains",
    });
    // Containment never gates readiness: the child has no blockers.
    expect(model.nodes.child.blockedBy).toEqual([]);
    expect(model.blocked).not.toContain("epic");
  });

  it("never draws related or discovered-from at all", () => {
    const { model, beads } = build(
      [raw("a"), raw("b")],
      [
        { from: "a", to: "b", type: "related" },
        { from: "a", to: "b", type: "discovered-from" },
      ]
    );

    expect(applyLens(model, beads, { lens: "full" }).edges).toEqual([]);
  });

  it("omits an edge whose blocker is not in the payload", () => {
    const { model, beads } = build([raw("b")], [blocks("b", "ghost")]);

    const result = applyLens(model, beads, { lens: "full" });

    expect(ids(result)).toEqual(["b"]);
    expect(result.edges).toEqual([]);
    expect(result.nodes[0].blocked).toBe(true);
  });

  it("omits a bead the model knows but the payload has no metadata for", () => {
    const { model } = build([raw("a"), raw("b")], [blocks("b", "a")]);

    const result = applyLens(model, [{ id: "a", status: "open", type: "task" }], { lens: "full" });

    expect(ids(result)).toEqual(["a"]);
    expect(result.omitted).toBe(1);
  });

  it("carries the derived facts a node is drawn from", () => {
    const { model, beads } = build([raw("a"), raw("b")], [blocks("b", "a")]);

    const result = applyLens(model, beads, { lens: "full" });
    const a = result.nodes.find((node) => node.id === "a");
    const b = result.nodes.find((node) => node.id === "b");

    expect(a).toMatchObject({ label: "Bead a", ready: true, blocked: false, leverage: 1, rank: 0 });
    expect(b).toMatchObject({ ready: false, blocked: true, rank: 1 });
  });

  it("falls back to the id when a bead has no title", () => {
    const { model } = build([raw("a")]);
    const result = applyLens(model, [{ id: "a", status: "open", title: "" }], { lens: "full" });
    expect(result.nodes[0].label).toBe("a");
  });

  it("marks the beads tangled in a cycle", () => {
    const { model, beads } = build([raw("a"), raw("b")], [blocks("a", "b"), blocks("b", "a")]);

    const result = applyLens(model, beads, { lens: "full" });

    expect(result.nodes.every((node) => node.inCycle)).toBe(true);
    expect(pairs(result)).toEqual(["a->b", "b->a"]);
  });
});

describe("blast-radius lens", () => {
  // up1 <- up2 gate down1, which gates down2 and down3. `other` is a separate
  // component entirely.
  const project = build(
    [
      raw("up1"),
      raw("up2"),
      raw("focus"),
      raw("down1"),
      raw("down2"),
      raw("down3"),
      raw("other1"),
      raw("other2"),
    ],
    [
      blocks("focus", "up1"),
      blocks("up1", "up2"),
      blocks("down1", "focus"),
      blocks("down2", "down1"),
      blocks("down3", "focus"),
      blocks("other2", "other1"),
    ]
  );

  it("returns the focus with its two upstream and three downstream beads", () => {
    const result = applyLens(project.model, project.beads, {
      lens: "blast-radius",
      focusId: "focus",
    });

    expect(ids(result)).toEqual(["down1", "down2", "down3", "focus", "up1", "up2"]);
    expect(result.nodes).toHaveLength(6);
    expect(result.focusId).toBe("focus");
    expect(result.omitted).toBe(2);
  });

  it("excludes an unrelated component", () => {
    const result = applyLens(project.model, project.beads, {
      lens: "blast-radius",
      focusId: "focus",
    });

    expect(ids(result)).not.toContain("other1");
    expect(pairs(result)).not.toContain("other1->other2");
  });

  it("signs distance upstream and downstream", () => {
    const result = applyLens(project.model, project.beads, {
      lens: "blast-radius",
      focusId: "focus",
    });
    const distance = Object.fromEntries(result.nodes.map((node) => [node.id, node.distance]));

    expect(distance).toEqual({
      focus: 0,
      up1: -1,
      up2: -2,
      down1: 1,
      down3: 1,
      down2: 2,
    });
  });

  it("honours a hop limit", () => {
    const result = applyLens(project.model, project.beads, {
      lens: "blast-radius",
      focusId: "focus",
      depth: 1,
    });

    expect(ids(result)).toEqual(["down1", "down3", "focus", "up1"]);
  });

  it("draws only the edges between beads it kept", () => {
    const result = applyLens(project.model, project.beads, {
      lens: "blast-radius",
      focusId: "focus",
    });

    expect(pairs(result)).toEqual([
      "down1->down2",
      "focus->down1",
      "focus->down3",
      "up1->focus",
      "up2->up1",
    ]);
  });

  it("has nothing to draw without a focus", () => {
    const empty = applyLens(project.model, project.beads, { lens: "blast-radius" });
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.focusId).toBeUndefined();
    expect(empty.omitted).toBe(8);
  });

  it("has nothing to draw when the focus is not a visible bead", () => {
    const result = applyLens(project.model, project.beads, {
      lens: "blast-radius",
      focusId: "ghost",
    });
    expect(result.nodes).toEqual([]);
  });

  it("returns the focus alone when nothing connects to it", () => {
    const { model, beads } = build([raw("solo"), raw("elsewhere")]);
    const result = applyLens(model, beads, { lens: "blast-radius", focusId: "solo" });

    expect(ids(result)).toEqual(["solo"]);
    expect(result.edges).toEqual([]);
  });

  it("terminates on a cycle through the focus", () => {
    const { model, beads } = build(
      [raw("a"), raw("b"), raw("c")],
      [blocks("a", "b"), blocks("b", "c"), blocks("c", "a")]
    );

    const result = applyLens(model, beads, { lens: "blast-radius", focusId: "a" });

    expect(ids(result)).toEqual(["a", "b", "c"]);
  });
});

describe("lens purity", () => {
  const project = build(
    [
      raw("e1", { issue_type: "epic" }),
      raw("t1", { parent: "e1" }),
      raw("t2", { parent: "e1" }),
      raw("loose"),
    ],
    [blocks("t2", "t1"), blocks("loose", "t1")]
  );

  it.each(GRAPH_LENSES)("is deterministic for %s", (lens) => {
    const options = { lens, focusId: "t1" };
    const first = applyLens(project.model, project.beads, options);
    const second = applyLens(project.model, project.beads, options);

    expect(second).toEqual(first);
  });

  it("mutates neither the model nor the bead list", () => {
    const modelBefore = JSON.stringify(project.model);
    const beadsBefore = JSON.stringify(project.beads);

    for (const lens of GRAPH_LENSES) {
      applyLens(project.model, project.beads, { lens, focusId: "t1" });
    }

    expect(JSON.stringify(project.model)).toBe(modelBefore);
    expect(JSON.stringify(project.beads)).toBe(beadsBefore);
  });

  it("orders nodes shallowest-first, then by id, and edges by endpoint", () => {
    const result = applyLens(project.model, project.beads, { lens: "full" });

    // e1 and t1 are unblocked (rank 0); loose and t2 both wait on t1 (rank 1).
    expect(result.nodes.map((node) => node.id)).toEqual(["e1", "t1", "loose", "t2"]);
    expect(
      result.edges
        .filter((edge) => edge.kind === "blocks")
        .map((edge) => [edge.blocker, edge.blocked])
    ).toEqual([
      ["t1", "loose"],
      ["t1", "t2"],
    ]);
  });

  it("accepts an explicit hidden-type list in place of the coordination default", () => {
    const { model, beads } = build([raw("a"), raw("b", { issue_type: "bug" })]);

    const result = applyLens(model, beads, { lens: "full", hiddenTypes: ["bug"] });

    expect(ids(result)).toEqual(["a"]);
  });

  it("shows a coordination bead when the hidden list is emptied", () => {
    const { model, beads } = build([raw("a"), raw("g", { issue_type: "gate" })]);

    const result = applyLens(model, beads, { lens: "full", hiddenTypes: [] });

    expect(ids(result)).toEqual(["a", "g"]);
  });
});

describe("chooseInitialLens", () => {
  it("opens on the epic lens when the project has an epic to open up", () => {
    const { model, beads } = build(
      [
        raw("e1", { issue_type: "epic" }),
        raw("a", { parent: "e1" }),
        raw("b", { parent: "e1" }),
      ],
      [blocks("b", "a")]
    );

    expect(chooseInitialLens(model, beads)).toBe("epic");
  });

  it("falls through to the full graph when there are no epics", () => {
    // Nothing for the epic lens to draw; orphans belong to the full lens.
    const { model, beads } = build([raw("a"), raw("b")], [blocks("b", "a")]);

    expect(chooseInitialLens(model, beads)).toBe("full");
  });

  it("counts an implicit container - containment is fact, typing is convention", () => {
    const { model, beads } = build([raw("t"), raw("sub", { parent: "t" })]);

    expect(chooseInitialLens(model, beads)).toBe("epic");
  });

  it("offers an empty epic as a destination rather than falling to the hairball", () => {
    const { model, beads } = build([raw("e1", { issue_type: "epic" }), raw("loose")]);

    expect(chooseInitialLens(model, beads)).toBe("epic");
  });
});

describe("epic lens", () => {
  // One epic with a nested container inside it, one bead outside it, and a
  // dependency crossing the epic boundary.
  const project = build(
    [
      raw("e1", { issue_type: "epic" }),
      raw("s1", { parent: "e1" }),
      raw("t1", { parent: "s1", status: "closed" }),
      raw("t2", { parent: "e1" }),
      raw("out"),
    ],
    // t2 waits on s1 - both open members. (An edge from the closed t1 would
    // not draw: the derivation only keeps open blockers.)
    [blocks("t2", "s1"), blocks("out", "t2")]
  );

  it("draws the epic and every descendant, tethered so the subtree converges on it", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic", epicId: "e1" });

    expect(ids(result)).toEqual(["e1", "s1", "t1", "t2"]);
    expect(result.focusId).toBe("e1");
    // Tethers run member -> container, the reverse of the full lens, so a
    // left-to-right layout puts the epic where the work flows to.
    expect(
      result.edges
        .filter((edge) => edge.kind === "contains")
        .map((edge) => `${edge.blocker}->${edge.blocked}`)
        .sort()
    ).toEqual(["s1->e1", "t1->s1", "t2->e1"]);
  });

  it("keeps blocking edges among members and drops those crossing the boundary", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic", epicId: "e1" });

    expect(
      result.edges
        .filter((edge) => edge.kind === "blocks")
        .map((edge) => `${edge.blocker}->${edge.blocked}`)
    ).toEqual(["s1->t2"]);
    // `out` is not represented at all, so the count says so.
    expect(result.omitted).toBe(1);
  });

  it("puts the subtree's progress on the epic's own card", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic", epicId: "e1" });
    const epic = result.nodes.find((node) => node.id === "e1");
    const member = result.nodes.find((node) => node.id === "t2");

    expect(epic?.progress).toEqual({ closed: 1, total: 3 });
    expect(member?.progress).toBeUndefined();
  });

  it("has nothing to draw without an epic", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic" });

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.omitted).toBe(5);
  });

  it("has nothing to draw when the epic id is not a visible bead", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic", epicId: "nope" });

    expect(result.nodes).toEqual([]);
  });

  it("draws a childless epic alone rather than pretending it does not exist", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic", epicId: "t2" });

    // t2 contains nothing, so the lens is one node with no progress line.
    expect(ids(result)).toEqual(["t2"]);
    expect(result.nodes[0].progress).toBeUndefined();
  });

  it("terminates on a parent cycle instead of looping", () => {
    const { model, beads } = build([
      raw("a", { parent: "b" }),
      raw("b", { parent: "a" }),
      raw("e", { issue_type: "epic" }),
    ]);

    const result = applyLens(model, beads, { lens: "epic", epicId: "e" });

    // Neither ring member reaches e; the walk must not hang deciding that.
    expect(ids(result)).toEqual(["e"]);
  });
});

describe("listEpics", () => {
  it("offers typed epics and implicit containers, with subtree progress", () => {
    const { model, beads } = build([
      raw("e1", { issue_type: "epic" }),
      raw("s1", { parent: "e1" }),
      raw("t1", { parent: "s1", status: "closed" }),
      raw("t2", { parent: "e1" }),
      raw("loose"),
    ]);

    expect(listEpics(model, beads)).toEqual([
      { id: "e1", label: "Bead e1", total: 3, closed: 1 },
      { id: "s1", label: "Bead s1", total: 1, closed: 1 },
    ]);
  });

  it("offers an empty epic - it is still a place work will go", () => {
    const { model, beads } = build([raw("e1", { issue_type: "epic" }), raw("loose")]);

    expect(listEpics(model, beads)).toEqual([{ id: "e1", label: "Bead e1", total: 0, closed: 0 }]);
  });

  it("never offers a coordination bead as an epic", () => {
    const { model, beads } = build([
      raw("g", { issue_type: "gate" }),
      raw("t", { parent: "g" }),
    ]);

    expect(listEpics(model, beads)).toEqual([]);
  });

  it("returns nothing for a flat project", () => {
    const { model, beads } = build([raw("a"), raw("b")]);

    expect(listEpics(model, beads)).toEqual([]);
  });
});
