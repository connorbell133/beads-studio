/**
 * Find and traversal, tested over the shapes the canvas actually hands them:
 * lens nodes and lens edges. The invariant every find test asserts in some form
 * is that the node set is unchanged - a find that removes nodes would re-run
 * layout and move the picture.
 */

import {
  chainFilter,
  chainsFrom,
  findMatches,
  findState,
  neighboursOf,
  stepFocus,
  FindTarget,
} from "../find";
import { LensEdge } from "../lens";

const target = (id: string, label: string): FindTarget => ({ id, label });

/** `edge(a, b)` reads "a blocks b". */
const edge = (blocker: string, blocked: string): LensEdge => ({
  blocker,
  blocked,
  kind: "blocks",
});

/** Twenty nodes, two of which mention authentication. */
function twenty(): FindTarget[] {
  const nodes = Array.from({ length: 18 }, (_, i) =>
    target(`bd-${String(i).padStart(2, "0")}`, `Routine chore ${i}`)
  );
  return [
    ...nodes.slice(0, 9),
    target("bd-a1b2", "Rotate the auth token"),
    ...nodes.slice(9),
    target("bd-c3d4", "Authentication audit"),
  ];
}

describe("findMatches", () => {
  it("marks the matches and dims everything else, keeping all twenty nodes", () => {
    const result = findMatches(twenty(), "auth");

    expect(result.matches).toEqual(["bd-a1b2", "bd-c3d4"]);
    expect(result.dimmed).toHaveLength(18);
    expect(result.matches.length + result.dimmed.length).toBe(20);
    expect(result.total).toBe(20);
  });

  it("reports no matches without clearing the graph", () => {
    const result = findMatches(twenty(), "zzzz");

    expect(result.active).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.dimmed).toHaveLength(20);
    expect(result.total).toBe(20);
  });

  it("matches on id, case-insensitively", () => {
    const targets = [target("bd-A1B2", "Nothing relevant"), target("bd-zz", "Also nothing")];

    expect(findMatches(targets, "a1b2").matches).toEqual(["bd-A1B2"]);
    expect(findMatches(targets, "A1B2").matches).toEqual(["bd-A1B2"]);
  });

  it("matches on title, case-insensitively", () => {
    const targets = [target("bd-1", "Rotate the AUTH token"), target("bd-2", "Ship the docs")];

    expect(findMatches(targets, "auth").matches).toEqual(["bd-1"]);
    expect(findMatches(targets, "AUTH").matches).toEqual(["bd-1"]);
  });

  it("matches a substring anywhere in the id, since ids carry a project prefix", () => {
    const targets = [target("vsbeads-4f2", "A bead"), target("vsbeads-9aa", "Another")];

    expect(findMatches(targets, "4f2").matches).toEqual(["vsbeads-4f2"]);
  });

  it("goes inactive on an empty or whitespace query, dimming nothing", () => {
    for (const query of ["", "   ", "\t"]) {
      const result = findMatches(twenty(), query);
      expect(result.active).toBe(false);
      expect(result.matches).toEqual([]);
      expect(result.dimmed).toEqual([]);
      expect(result.total).toBe(20);
    }
  });

  it("returns matches in input order, not id order", () => {
    const targets = [target("bd-z", "auth z"), target("bd-a", "auth a")];

    expect(findMatches(targets, "auth").matches).toEqual(["bd-z", "bd-a"]);
  });

  it("trims and lower-cases the query it reports back", () => {
    expect(findMatches(twenty(), "  AUTH  ").query).toBe("auth");
  });
});

describe("findState", () => {
  it("reports nothing while the find is inactive", () => {
    const result = findMatches(twenty(), "");
    expect(findState(result, "bd-a1b2")).toBe("none");
  });

  it("splits into match and dim while active", () => {
    const result = findMatches(twenty(), "auth");
    expect(findState(result, "bd-a1b2")).toBe("match");
    expect(findState(result, "bd-00")).toBe("dim");
  });
});

describe("neighboursOf", () => {
  const edges = [
    edge("up-b", "mid"),
    edge("up-a", "mid"),
    edge("mid", "down-c"),
    edge("mid", "down-a"),
    edge("mid", "down-b"),
  ];

  it("returns five reachable neighbours in a stable order", () => {
    const neighbours = neighboursOf(edges, "mid");

    expect(neighbours.blockers).toEqual(["up-a", "up-b"]);
    expect(neighbours.blocked).toEqual(["down-a", "down-b", "down-c"]);
    expect(neighbours.all).toEqual(["up-a", "up-b", "down-a", "down-b", "down-c"]);
    expect(neighbours.all).toHaveLength(5);
  });

  it("returns the same order regardless of edge order", () => {
    const shuffled = [edges[4], edges[0], edges[3], edges[1], edges[2]];
    expect(neighboursOf(shuffled, "mid").all).toEqual(neighboursOf(edges, "mid").all);
  });

  it("returns nothing for an isolated node", () => {
    const neighbours = neighboursOf(edges, "lonely");

    expect(neighbours.blockers).toEqual([]);
    expect(neighbours.blocked).toEqual([]);
    expect(neighbours.siblings).toEqual([]);
    expect(neighbours.all).toEqual([]);
  });

  it("counts beads sharing a blocker as siblings", () => {
    // one blocker fans out to three
    const fan = [edge("root", "a"), edge("root", "b"), edge("root", "c")];
    expect(neighboursOf(fan, "b").siblings).toEqual(["a", "c"]);
  });

  it("counts beads sharing a blocked node as siblings", () => {
    const fan = [edge("a", "sink"), edge("b", "sink"), edge("c", "sink")];
    expect(neighboursOf(fan, "b").siblings).toEqual(["a", "c"]);
  });

  it("never reports a node as its own sibling", () => {
    const diamond = [edge("root", "a"), edge("root", "b"), edge("a", "sink"), edge("b", "sink")];
    expect(neighboursOf(diamond, "a").siblings).toEqual(["b"]);
  });
});

describe("stepFocus", () => {
  const edges = [
    edge("up-a", "mid"),
    edge("up-b", "mid"),
    edge("mid", "down-a"),
    edge("mid", "down-b"),
    edge("mid", "down-c"),
  ];

  it("follows an edge upstream to the first blocker", () => {
    expect(stepFocus(edges, "mid", "blocker")).toBe("up-a");
  });

  it("follows an edge downstream to the first blocked bead", () => {
    expect(stepFocus(edges, "mid", "blocked")).toBe("down-a");
  });

  it("does not move focus from an isolated node", () => {
    for (const direction of ["blocker", "blocked", "previous", "next"] as const) {
      expect(stepFocus(edges, "lonely", direction)).toBeNull();
    }
  });

  it("does not move past the ends of a chain", () => {
    expect(stepFocus(edges, "up-a", "blocker")).toBeNull();
    expect(stepFocus(edges, "down-a", "blocked")).toBeNull();
  });

  it("cycles the sibling ring, wrapping at both ends", () => {
    expect(stepFocus(edges, "down-a", "next")).toBe("down-b");
    expect(stepFocus(edges, "down-b", "next")).toBe("down-c");
    expect(stepFocus(edges, "down-c", "next")).toBe("down-a");

    expect(stepFocus(edges, "down-a", "previous")).toBe("down-c");
    expect(stepFocus(edges, "down-c", "previous")).toBe("down-b");
  });

  it("composes: one key into a fan of blockers, another to walk it", () => {
    const first = stepFocus(edges, "mid", "blocker");
    expect(first).toBe("up-a");
    expect(stepFocus(edges, first as string, "next")).toBe("up-b");
  });

  it("stays put when a node has neighbours but no siblings", () => {
    const chain = [edge("a", "b"), edge("b", "c")];
    expect(stepFocus(chain, "b", "next")).toBeNull();
    expect(stepFocus(chain, "b", "blocker")).toBe("a");
  });
});

describe("chainsFrom", () => {
  const edges = [
    edge("root", "up"),
    edge("up", "mid"),
    edge("mid", "down"),
    edge("down", "leaf"),
    edge("elsewhere", "unrelated"),
  ];

  it("walks both chains transitively", () => {
    const chains = chainsFrom(edges, "mid");

    expect(chains.blockers).toEqual(["root", "up"]);
    expect(chains.blocked).toEqual(["down", "leaf"]);
    expect(chains.connected).toEqual(["down", "leaf", "mid", "root", "up"]);
  });

  it("leaves unrelated beads off the chain, which is what hover dims", () => {
    expect(chainsFrom(edges, "mid").connected).not.toContain("elsewhere");
    expect(chainsFrom(edges, "mid").connected).not.toContain("unrelated");
  });

  it("connects an isolated node to nothing but itself", () => {
    const chains = chainsFrom(edges, "lonely");

    expect(chains.blockers).toEqual([]);
    expect(chains.blocked).toEqual([]);
    expect(chains.connected).toEqual(["lonely"]);
  });

  it("terminates on a cycle rather than hanging", () => {
    const ring = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const chains = chainsFrom(ring, "a");

    expect(chains.connected).toEqual(["a", "b", "c"]);
  });

  it("keeps an edge lit when both ends are on the chain", () => {
    const onChain = chainFilter(chainsFrom(edges, "mid"));

    expect(onChain(edge("up", "mid"))).toBe(true);
    expect(onChain(edge("root", "up"))).toBe(true);
    expect(onChain(edge("elsewhere", "unrelated"))).toBe(false);
    expect(onChain(edge("elsewhere", "mid"))).toBe(false);
  });

  it("lights the link between two blockers of the same bead", () => {
    // b1 blocks b2, and both block mid: that ordering is part of the chain.
    const branchy = [edge("b1", "b2"), edge("b1", "mid"), edge("b2", "mid")];
    const onChain = chainFilter(chainsFrom(branchy, "mid"));

    expect(onChain(edge("b1", "b2"))).toBe(true);
  });
});
