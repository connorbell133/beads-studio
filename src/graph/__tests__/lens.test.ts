/**
 * Lens tests run over a real derived model rather than a hand-built one, so a
 * change to readiness or hierarchy shows up here instead of drifting apart from
 * what the views actually draw.
 */

import { deriveGraph } from "../BeadsGraph";
import { applyLens, DEFAULT_LENS, GRAPH_LENSES, LensBead } from "../lens";
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
  it("opens on the epic rollup, never the full graph", () => {
    expect(DEFAULT_LENS).toBe("epic-rollup");
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

  it("draws blocking edges only, never parent-child", () => {
    const { model, beads } = build(
      [raw("epic", { issue_type: "epic" }), raw("child")],
      [
        { from: "child", to: "epic", type: "parent-child" },
        { from: "child", to: "other", type: "related" },
      ]
    );

    const result = applyLens(model, beads, { lens: "full" });

    expect(ids(result)).toEqual(["child", "epic"]);
    expect(result.edges).toEqual([]);
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
    expect(b).toMatchObject({ ready: false, blocked: true, rank: 1, rolled: false });
    expect(a?.members).toEqual(["a"]);
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

describe("epic-rollup lens", () => {
  // Two epics, three members each, with one cross-epic dependency and one
  // inside an epic.
  const project = build(
    [
      raw("e1", { issue_type: "epic" }),
      raw("e2", { issue_type: "epic" }),
      raw("t1", { parent: "e1" }),
      raw("t2", { parent: "e1" }),
      raw("t3", { parent: "e2" }),
      raw("loose"),
    ],
    [blocks("t2", "t1"), blocks("t3", "t1"), blocks("loose", "t3")]
  );

  it("collapses ticket-level edges onto their epics and drops intra-epic ones", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic-rollup" });

    expect(ids(result)).toEqual(["e1", "e2", "loose"]);
    // t2 <- t1 lives inside e1 and disappears; t3 <- t1 becomes e2 <- e1;
    // loose <- t3 becomes loose <- e2.
    expect(pairs(result)).toEqual(["e1->e2", "e2->loose"]);
  });

  it("names the members it stands for and their closed count", () => {
    const result = applyLens(project.model, project.beads, { lens: "epic-rollup" });
    const e1 = result.nodes.find((node) => node.id === "e1");
    const loose = result.nodes.find((node) => node.id === "loose");

    expect(e1?.members).toEqual(["e1", "t1", "t2"]);
    expect(e1?.rolled).toBe(true);
    expect(e1?.progress).toEqual({ closed: 0, total: 3 });
    expect(loose?.rolled).toBe(false);
    expect(loose?.progress).toBeUndefined();
    expect(result.omitted).toBe(0);
  });

  it("counts closed members in a rolled node's progress", () => {
    const { model, beads } = build([
      raw("e1", { issue_type: "epic" }),
      raw("t1", { parent: "e1", status: "closed" }),
      raw("t2", { parent: "e1" }),
    ]);

    const result = applyLens(model, beads, { lens: "epic-rollup" });

    expect(result.nodes[0].progress).toEqual({ closed: 1, total: 3 });
  });

  it("rolls a nested epic up to the top of its chain", () => {
    const { model, beads } = build(
      [
        raw("m", { issue_type: "milestone" }),
        raw("e", { issue_type: "epic", parent: "m" }),
        raw("t", { parent: "e" }),
        raw("other"),
      ],
      [blocks("other", "t")]
    );

    const result = applyLens(model, beads, { lens: "epic-rollup" });

    expect(ids(result)).toEqual(["m", "other"]);
    expect(pairs(result)).toEqual(["m->other"]);
  });

  it("weights a rolled edge by the bead-level edges behind it", () => {
    const { model, beads } = build(
      [
        raw("e1", { issue_type: "epic" }),
        raw("e2", { issue_type: "epic" }),
        raw("t1", { parent: "e1" }),
        raw("t2", { parent: "e1" }),
        raw("t3", { parent: "e2" }),
      ],
      [blocks("t3", "t1"), blocks("t3", "t2")]
    );

    const result = applyLens(model, beads, { lens: "epic-rollup" });

    expect(result.edges).toEqual([{ blocker: "e1", blocked: "e2", weight: 2, rolled: true }]);
  });

  it("stands a bead on its own when its parent is a hidden type", () => {
    const { model, beads } = build([
      raw("g", { issue_type: "gate" }),
      raw("t", { parent: "g" }),
    ]);

    const result = applyLens(model, beads, { lens: "epic-rollup" });

    expect(ids(result)).toEqual(["t"]);
    expect(result.nodes[0].rolled).toBe(false);
  });

  it("survives a parent cycle rather than looping on it", () => {
    const { model, beads } = build([
      raw("a", { parent: "b" }),
      raw("b", { parent: "a" }),
    ]);

    const result = applyLens(model, beads, { lens: "epic-rollup" });

    // The ring elects its lowest id rather than vanishing from the canvas.
    expect(ids(result)).toEqual(["a"]);
    expect(result.nodes.flatMap((node) => node.members).sort()).toEqual(["a", "b"]);
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
    expect(result.edges.map((edge) => [edge.blocker, edge.blocked])).toEqual([
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
