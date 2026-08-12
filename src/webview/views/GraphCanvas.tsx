/**
 * GraphCanvas - the dependency DAG as laid-out SVG.
 *
 * Sits above GraphView's adjacency list rather than replacing it. The list is
 * the accessible representation; this is the picture. That split is why the SVG
 * is a single `role="img"` with a counted label instead of a tree of focusable
 * shapes: a screen reader gets the relationships as real text below, and the
 * canvas does not make the user tab through five hundred `<g>` elements to find
 * what the list already gives them in one stop.
 *
 * Three lenses share one render path, because the lens is a filter applied
 * before layout (src/graph/lens.ts) and layout is pure (src/graph/layout.ts).
 * It opens on the epic rollup - a five-hundred-node hairball on open is a
 * decision-paralysis surface with no entry point.
 *
 * Past that opening, four affordances keep it usable at the sizes real projects
 * reach, each answering a question the user has at a specific scale:
 *
 *   Where am I?          Fit-to-selection. One action frames the selected bead
 *                        and what it links to. Not a minimap: a minimap is a
 *                        second rendering to keep legible for the same job.
 *   Where is bd-a1b2?    Find, filtering as you type over id and title, with
 *                        matches marked in place and non-matches dimmed. Never
 *                        removed - removing re-runs dagre and moves everything.
 *   Why is this a
 *   hairball?            A density threshold (src/graph/density.ts). Above a
 *                        node count the canvas collapses to the rollup and says
 *                        so, with an explicit override.
 *   What connects to
 *   what?                Hover, or the keyboard cursor, dims everything outside
 *                        that bead's blocker and blocked chains.
 *
 * Keyboard: the canvas is ONE tab stop with an internal cursor, not a tree of
 * tab stops. Arrows follow blocking edges rather than the DOM, which is the
 * only traversal that means anything in a DAG, and each move is spoken through
 * a live region. `aria-activedescendant` was the alternative and was rejected:
 * it needs focusable, id-bearing SVG descendants under a composite role, and
 * its mapping out of SVG is inconsistent across screen readers. A live region
 * says the same thing everywhere, and leaves `role="img"` - and therefore the
 * existing screen-reader story - exactly as it was.
 *
 * Colour rules, from the design language:
 *   - Every value is a VS Code theme token. No literals.
 *   - Status hue fills the node body at low opacity and paints its rail at
 *     full strength; labels read in `--vscode-foreground`, never on a chart
 *     hue, which is what keeps the 4.5:1 text bar while the 3:1 graphic bar
 *     carries the colour.
 *   - Type is carried by the icon, not by the fill. Six usable hues cannot
 *     encode fourteen types and should not try.
 *
 * Only blocking edges are drawn. parent-child is how the rollup groups, never
 * a line - drawing containment alongside blockage is what makes a dependency
 * graph unreadable.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bead, BeadsGraphModel } from "../types";
import { GRAPHIC_TOKENS, statusHue, typeHue } from "../theme/tokens";
import { icons } from "../icons";
import { GraphToolbar } from "../common/GraphToolbar";
import {
  applyLens,
  DEFAULT_LENS,
  GraphLens,
  LENS_LABELS,
  LensNode,
} from "../../graph/lens";
import {
  chainFilter,
  chainsFrom,
  findMatches,
  neighboursOf,
  stepFocus,
  TraverseDirection,
} from "../../graph/find";
import { resolveDensity } from "../../graph/density";
import {
  GraphLayoutEdgePath,
  GraphLayoutPosition,
  layoutBounds,
  layoutGraph,
} from "../../graph/layout";

export interface GraphCanvasProps {
  /** Bead metadata: titles, types, statuses. Beads missing here are not drawn. */
  beads: Bead[];
  /** The derived model. `null` renders the empty state rather than a blank canvas. */
  graph: BeadsGraphModel | null;
  /**
   * Controlled lens. Omit to let the canvas own it, in which case it opens on
   * the epic rollup.
   */
  lens?: GraphLens;
  /** Called on every lens change, whether the lens is controlled or not. */
  onLensChange?: (lens: GraphLens) => void;
  /**
   * Anchor for the blast-radius lens. Falls back to the selected bead, so
   * "show me what this touches" needs no second selection.
   */
  focusId?: string | null;
  /** The one selected bead, shared across surfaces. */
  selectedBeadId?: string | null;
  onSelectBead?: (beadId: string) => void;
  /**
   * Bump to move focus into the find field - this is how the extension's
   * `beads.findInGraph` command reaches the canvas. Any change in the value
   * triggers it, so a counter incremented per `focusGraphFind` message works
   * and repeated invocations are not swallowed.
   */
  focusFindToken?: number;
  className?: string;
}

const NODE_WIDTH = 208;
const NODE_HEIGHT = 52;
/** Rolled nodes carry a third line: how many of their members have closed. */
const ROLLED_NODE_HEIGHT = 68;
const ICON_SIZE = 13;
const RAIL_WIDTH = 4;
const CORNER = 4;

/** Zoom bounds, as a multiple of the fitted view. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;

/** Graph units kept between a cursor node and the edge of the viewport. */
const CURSOR_MARGIN = 32;
/** Padding around a fit-to-selection frame. */
const FRAME_PADDING = 48;

/**
 * Marker ids have to be unique per mounted canvas: two canvases sharing an id
 * would both point at whichever `<defs>` rendered last.
 */
let canvasSequence = 0;

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const NO_POSITIONS = new Map<string, GraphLayoutPosition>();

export function GraphCanvas({
  beads,
  graph,
  lens,
  onLensChange,
  focusId,
  selectedBeadId,
  onSelectBead,
  focusFindToken,
  className,
}: GraphCanvasProps): React.ReactElement {
  const [ownLens, setOwnLens] = useState<GraphLens>(DEFAULT_LENS);
  const requestedLens = lens ?? ownLens;

  /** Set once the user has read the density notice and asked for it anyway. */
  const [densityOverride, setDensityOverride] = useState(false);
  const [query, setQuery] = useState("");
  /** The node under the pointer, and the node under the keyboard cursor. */
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const svgRef = useRef<SVGSVGElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const markerId = useMemo(() => `graph-canvas-${++canvasSequence}`, []);

  const anchor = focusId ?? selectedBeadId ?? null;

  // The requested lens is evaluated first so the density decision has a real
  // node count to judge. Only the lens that survives that decision is laid out,
  // so a 500-node request never pays for a dagre pass nobody can read.
  const view = useMemo(() => {
    if (!graph) return null;
    const requested = applyLens(graph, beads, { lens: requestedLens, focusId: anchor });
    const density = resolveDensity({
      requested: requestedLens,
      nodeCount: requested.nodes.length,
      override: densityOverride,
    });
    const result =
      density.lens === requestedLens
        ? requested
        : applyLens(graph, beads, { lens: density.lens, focusId: anchor });

    const sized = result.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: node.rolled ? ROLLED_NODE_HEIGHT : NODE_HEIGHT,
    }));
    const laidOut = layoutGraph(
      sized,
      result.edges.map((edge) => ({ source: edge.blocker, target: edge.blocked })),
      { direction: "LR" }
    );
    return { result, density, sized, laidOut };
  }, [graph, beads, requestedLens, anchor, densityOverride]);

  const nodes = view?.result.nodes ?? [];
  const edges = view?.result.edges ?? [];
  const drawnLens = view?.result.lens ?? requestedLens;
  const bounds = view?.laidOut.bounds;
  const positions = view?.laidOut.positions ?? NO_POSITIONS;

  const drawn = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const sizes = useMemo(
    () => new Map((view?.sized ?? []).map((node) => [node.id, node])),
    [view]
  );
  const tangled = useMemo(
    () => new Set(nodes.filter((node) => node.inCycle).map((node) => node.id)),
    [nodes]
  );

  // Find marks in place and dims the rest; the node set is untouched, so the
  // layout the user has already read stays exactly where it was.
  const find = useMemo(
    () =>
      findMatches(
        nodes.map((node) => ({ id: node.id, label: node.label, members: node.members })),
        query
      ),
    [nodes, query]
  );
  const matched = useMemo(() => new Set(find.matches), [find]);

  // Hover - or the keyboard cursor, which is the same affordance without a
  // mouse - isolates one bead's blocker and blocked chains.
  const isolateId = hoverId ?? cursorId;
  const chains = useMemo(() => {
    if (!isolateId || !drawn.has(isolateId)) return null;
    return chainsFrom(edges, isolateId);
  }, [edges, isolateId, drawn]);
  const connected = useMemo(() => (chains ? new Set(chains.connected) : null), [chains]);
  const onChain = useMemo(() => (chains ? chainFilter(chains) : null), [chains]);

  // Refit whenever the picture itself changes - a new lens, a new project, a
  // refresh that adds beads. Keyed on the measured box rather than on its
  // object identity, so a poll that returns the same graph leaves the user's
  // pan and zoom exactly where they left it.
  const fitKey = bounds ? `${bounds.minX}|${bounds.minY}|${bounds.width}|${bounds.height}` : "";
  const fit: ViewBox | null = useMemo(() => {
    if (!fitKey) return null;
    const [x, y, width, height] = fitKey.split("|").map(Number);
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  }, [fitKey]);
  const [viewBox, setViewBox] = useState<ViewBox | null>(fit);
  useEffect(() => setViewBox(fit), [fit]);

  // A cursor pointing at a bead this lens no longer draws is a cursor pointing
  // at nothing; drop it rather than isolating an invisible chain.
  useEffect(() => {
    setCursorId((current) => (current && drawn.has(current) ? current : null));
    setHoverId((current) => (current && drawn.has(current) ? current : null));
  }, [drawn]);

  // Only a *change* in the token moves focus. Acting on the value present at
  // mount would let a graph opening for any other reason steal the caret.
  const seenFindToken = useRef(focusFindToken);
  useEffect(() => {
    if (focusFindToken === undefined || focusFindToken === seenFindToken.current) return;
    seenFindToken.current = focusFindToken;
    findRef.current?.focus();
    findRef.current?.select();
  }, [focusFindToken]);

  /** Client point -> graph coordinates, exact under any preserveAspectRatio. */
  const toGraphPoint = useCallback((clientX: number, clientY: number): GraphLayoutPosition => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM?.();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const zoomBy = useCallback(
    (factor: number, focal?: GraphLayoutPosition) => {
      setViewBox((current) => {
        if (!current || !fit) return current;
        const next = clampZoom(current.width * factor, fit.width);
        if (next === current.width) return current;
        const scale = next / current.width;
        const at = focal ?? { x: current.x + current.width / 2, y: current.y + current.height / 2 };
        return {
          x: at.x - (at.x - current.x) * scale,
          y: at.y - (at.y - current.y) * scale,
          width: next,
          height: current.height * scale,
        };
      });
    },
    [fit]
  );

  // React's onWheel is passive, so the zoom listener is attached by hand -
  // otherwise the wheel scrolls the editor tab out from under the graph.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoomBy(Math.exp(event.deltaY * 0.0015), toGraphPoint(event.clientX, event.clientY));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomBy, toGraphPoint]);

  /**
   * Pan - never zoom - just far enough that a node is inside the viewport.
   * Zooming to follow the cursor would change the scale the user chose on every
   * keystroke, which makes the picture unreadable in the act of navigating it.
   */
  const ensureVisible = useCallback(
    (id: string) => {
      const position = positions.get(id);
      const size = sizes.get(id);
      if (!position || !size) return;
      setViewBox((current) => {
        if (!current) return current;
        let { x, y } = current;
        const left = position.x - CURSOR_MARGIN;
        const right = position.x + size.width + CURSOR_MARGIN;
        const top = position.y - CURSOR_MARGIN;
        const bottom = position.y + size.height + CURSOR_MARGIN;
        if (left < x) x = left;
        else if (right > x + current.width) x = right - current.width;
        if (top < y) y = top;
        else if (bottom > y + current.height) y = bottom - current.height;
        return x === current.x && y === current.y ? current : { ...current, x, y };
      });
    },
    [positions, sizes]
  );

  /**
   * Fit to selection: the bead plus one hop in each direction.
   *
   * One hop rather than the whole chain, because the question this answers is
   * "where am I", and a frame that includes a twelve-deep chain answers a
   * different one. The blast-radius lens is where the whole chain lives.
   */
  const frameNode = useCallback(
    (id: string) => {
      if (!view || !fit || !drawn.has(id)) return;
      const wanted = new Set([id, ...neighboursOf(view.result.edges, id).all]);
      const subset = view.sized.filter((node) => wanted.has(node.id));
      if (subset.length === 0) return;

      const box = layoutBounds(subset, view.laidOut.positions, FRAME_PADDING);
      if (box.width <= 0 || box.height <= 0) return;

      // Respect the zoom ceiling: framing one isolated node should not blow it
      // up to fill an editor tab.
      const width = clampZoom(box.width, fit.width);
      const scale = width / box.width;
      const height = box.height * scale;
      setViewBox({
        x: box.minX + box.width / 2 - width / 2,
        y: box.minY + box.height / 2 - height / 2,
        width,
        height,
      });
    },
    [view, fit, drawn]
  );

  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  /** A pan that ends over a node must not also select it. */
  const suppressClick = useRef(false);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    const point = toGraphPoint(event.clientX, event.clientY);
    drag.current = { pointerId: event.pointerId, x: point.x, y: point.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const point = toGraphPoint(event.clientX, event.clientY);
    const dx = point.x - state.x;
    const dy = point.y - state.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) state.moved = true;
    setViewBox((current) => (current ? { ...current, x: current.x - dx, y: current.y - dy } : current));
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    // The click that follows this pointerup belongs to the pan, not to a node.
    if (state.moved) suppressClick.current = true;
  };

  const selectNode = (node: LensNode): void => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setCursorId(node.id);
    onSelectBead?.(node.id);
  };

  const chooseLens = (next: GraphLens): void => {
    if (lens === undefined) setOwnLens(next);
    onLensChange?.(next);
  };

  /** What the live region says when the cursor lands somewhere. */
  const describeNode = useCallback(
    (id: string): string => {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node) return id;
      const neighbours = neighboursOf(edges, id);
      const blockers =
        neighbours.blockers.length === 0
          ? "no blockers"
          : `${neighbours.blockers.length} ${plural(neighbours.blockers.length, "blocker")}`;
      const blocked =
        neighbours.blocked.length === 0
          ? "blocks nothing"
          : `blocks ${neighbours.blocked.length}`;
      return `${node.id}, ${node.label}. ${blockers}, ${blocked}.`;
    },
    [nodes, edges]
  );

  /**
   * Arrow keys walk the graph, not the DOM. The first press only reveals the
   * cursor - on the selected bead when there is one - so a user who arrows into
   * the canvas by accident has not lost their place.
   */
  const moveCursor = useCallback(
    (direction: TraverseDirection) => {
      if (nodes.length === 0) return;

      if (!cursorId || !drawn.has(cursorId)) {
        const start = selectedBeadId && drawn.has(selectedBeadId) ? selectedBeadId : nodes[0].id;
        setCursorId(start);
        ensureVisible(start);
        setAnnouncement(describeNode(start));
        return;
      }

      const next = stepFocus(edges, cursorId, direction);
      if (!next) {
        setAnnouncement(deadEnd(direction, cursorId));
        return;
      }
      setCursorId(next);
      ensureVisible(next);
      setAnnouncement(describeNode(next));
    },
    [nodes, cursorId, drawn, selectedBeadId, edges, ensureVisible, describeNode]
  );

  const onCanvasKeyDown = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    const step: Record<string, TraverseDirection> = {
      ArrowLeft: "blocker",
      ArrowRight: "blocked",
      ArrowUp: "previous",
      ArrowDown: "next",
    };

    if (step[event.key]) {
      event.preventDefault();
      moveCursor(step[event.key]);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      if (!cursorId) return;
      event.preventDefault();
      onSelectBead?.(cursorId);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setCursorId(null);
      setAnnouncement("");
      return;
    }

    if (event.key === "f" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      findRef.current?.focus();
      findRef.current?.select();
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setViewBox(fit);
    }
  };

  const onFindKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      svgRef.current?.focus();
      return;
    }
    // Enter hands the first match to the rest of the extension: it becomes the
    // cursor, gets framed, and - as the one selection - follows to every other
    // surface.
    if (event.key === "Enter" && find.matches.length > 0) {
      event.preventDefault();
      const first = find.matches[0];
      setCursorId(first);
      frameNode(first);
      onSelectBead?.(first);
      setAnnouncement(describeNode(first));
    }
  };

  const edgeByPair = new Map(edges.map((edge) => [`${edge.blocker}\t${edge.blocked}`, edge]));

  const label = `Dependency graph, ${LENS_LABELS[drawnLens].toLowerCase()} lens: ${
    nodes.length
  } ${nodes.length === 1 ? "bead" : "beads"}, ${edges.length} blocking ${
    edges.length === 1 ? "link" : "links"
  }`;

  const fitTarget = cursorId ?? (selectedBeadId && drawn.has(selectedBeadId) ? selectedBeadId : null);

  return (
    <div className={`graph-canvas${className ? ` ${className}` : ""}`}>
      <GraphToolbar
        lens={requestedLens}
        onLensChange={chooseLens}
        anchored={Boolean(anchor)}
        query={query}
        onQueryChange={setQuery}
        onQueryKeyDown={onFindKeyDown}
        findInputRef={findRef}
        matchCount={find.active ? find.matches.length : null}
        nodeCount={nodes.length}
        edgeCount={edges.length}
        omitted={view?.result.omitted ?? 0}
        onZoomIn={() => zoomBy(1 / 1.25)}
        onZoomOut={() => zoomBy(1.25)}
        onFitAll={() => setViewBox(fit)}
        onFitSelection={() => fitTarget && frameNode(fitTarget)}
        canFit={Boolean(fit)}
        canFitSelection={Boolean(fitTarget)}
      />

      {view && <DensityNotice view={view} onOverride={setDensityOverride} />}

      {graph && !graph.complete && (
        <p className="graph-canvas-degraded" role="status">
          Some beads could not be loaded, so this graph may be missing links.
        </p>
      )}

      {edges.length === 0 || !viewBox ? (
        <EmptyCanvas lens={drawnLens} nodeCount={nodes.length} anchored={Boolean(anchor)} />
      ) : (
        <svg
          ref={svgRef}
          className={`graph-canvas-svg${connected ? " isolating" : ""}`}
          role="img"
          tabIndex={0}
          aria-label={label}
          aria-describedby={`${markerId}-help`}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          preserveAspectRatio="xMidYMid meet"
          onKeyDown={onCanvasKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHoverId(null)}
          // Node handlers run before this one, so clearing here only ever
          // discards a suppression the pan set and no node consumed.
          onClick={() => {
            suppressClick.current = false;
          }}
        >
          <defs>
            <marker
              id={`${markerId}-arrow`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill={GRAPHIC_TOKENS.neutral} />
            </marker>
            <marker
              id={`${markerId}-arrow-cycle`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill={GRAPHIC_TOKENS.warning} />
            </marker>
          </defs>

          <g className="graph-canvas-edges">
            {view?.laidOut.edges.map((path) => {
              const edge = edgeByPair.get(`${path.source}\t${path.target}`);
              const cycle = tangled.has(path.source) && tangled.has(path.target);
              const offChain = Boolean(onChain && edge && !onChain(edge));
              const offMatch = find.active && !(matched.has(path.source) && matched.has(path.target));
              return (
                <path
                  key={`${path.source}\t${path.target}`}
                  className={`graph-canvas-edge${cycle ? " in-cycle" : ""}${
                    offChain || offMatch ? " dimmed" : ""
                  }`}
                  d={edgePath(path)}
                  fill="none"
                  stroke={cycle ? GRAPHIC_TOKENS.warning : GRAPHIC_TOKENS.neutral}
                  strokeWidth={edge && edge.weight > 1 ? 2.5 : 1.25}
                  strokeDasharray={cycle ? "5 4" : undefined}
                  markerEnd={`url(#${markerId}-${cycle ? "arrow-cycle" : "arrow"})`}
                />
              );
            })}
          </g>

          <g className="graph-canvas-nodes">
            {nodes.map((node) => {
              const position = positions.get(node.id);
              const size = sizes.get(node.id);
              if (!position || !size) return null;
              return (
                <GraphNode
                  key={node.id}
                  node={node}
                  x={position.x}
                  y={position.y}
                  width={size.width}
                  height={size.height}
                  selected={node.id === selectedBeadId}
                  focused={node.id === anchor && drawnLens === "blast-radius"}
                  cursor={node.id === cursorId}
                  matched={find.active && matched.has(node.id)}
                  dimmed={
                    (find.active && !matched.has(node.id)) ||
                    Boolean(connected && !connected.has(node.id))
                  }
                  onSelect={selectNode}
                  onHover={setHoverId}
                />
              );
            })}
          </g>
        </svg>
      )}

      {/* The keyboard model, spoken. Hidden text rather than a visible hint:
          the picture already carries every pixel it can afford. */}
      <p id={`${markerId}-help`} className="graph-canvas-offscreen">
        Arrow left and right follow blocking links to a blocker or to a blocked bead. Arrow up and
        down move between beads sharing a link. Enter selects. F finds a bead by id or title.
      </p>
      <p className="graph-canvas-offscreen" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/**
 * What the canvas did about density, and how to undo it.
 *
 * Three states, and the notice is absent in the ordinary one. Silently
 * rendering something other than the lens the user pressed would read as a bug
 * in the lens; silently rendering five hundred overlapping nodes would read as
 * a bug in the layout. Saying which, and offering the other, is the only honest
 * option.
 */
function DensityNotice({
  view,
  onOverride,
}: {
  view: { density: ReturnType<typeof resolveDensity> };
  onOverride: (override: boolean) => void;
}): React.ReactElement | null {
  const { density } = view;

  if (density.autoCollapsed) {
    return (
      <p className="graph-canvas-density" role="status">
        {LENS_LABELS[density.requested]} would draw {density.nodeCount} beads at once, past what
        stays legible here. Showing {LENS_LABELS["epic-rollup"].toLowerCase()} instead.{" "}
        <button type="button" className="graph-canvas-density-action" onClick={() => onOverride(true)}>
          Draw all {density.nodeCount} anyway
        </button>
      </p>
    );
  }

  if (density.overridden) {
    return (
      <p className="graph-canvas-density" role="status">
        Drawing all {density.nodeCount} beads. Zoom in, or find a bead by id.{" "}
        <button
          type="button"
          className="graph-canvas-density-action"
          onClick={() => onOverride(false)}
        >
          Collapse to {LENS_LABELS["epic-rollup"].toLowerCase()}
        </button>
      </p>
    );
  }

  if (density.dense) {
    return (
      <p className="graph-canvas-density" role="status">
        {density.nodeCount} beads is past what this layout keeps legible. Find one by id, or select
        one and switch to {LENS_LABELS["blast-radius"]}.
      </p>
    );
  }

  return null;
}

interface GraphNodeProps {
  node: LensNode;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  focused: boolean;
  /** Under the keyboard cursor. Distinct from selected: this one is transient. */
  cursor: boolean;
  matched: boolean;
  dimmed: boolean;
  onSelect: (node: LensNode) => void;
  onHover: (id: string | null) => void;
}

function GraphNode({
  node,
  x,
  y,
  width,
  height,
  selected,
  focused,
  cursor,
  matched,
  dimmed,
  onSelect,
  onHover,
}: GraphNodeProps): React.ReactElement {
  const hue = statusHue(node.status);
  const classes = [
    "graph-canvas-node",
    selected ? "selected" : "",
    focused ? "focused" : "",
    cursor ? "cursor" : "",
    matched ? "matched" : "",
    dimmed ? "dimmed" : "",
    node.inCycle ? "in-cycle" : "",
    node.ready ? "ready" : "",
    node.coordination ? "coordination" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g
      className={classes}
      // Position via CSS transform rather than the transform attribute so a
      // lens change interpolates the node to its new place instead of cutting
      // to a different picture. Reduced motion turns the transition off.
      style={{ transform: `translate(${x}px, ${y}px)` }}
      onClick={() => onSelect(node)}
      onPointerEnter={() => onHover(node.id)}
      onPointerLeave={() => onHover(null)}
    >
      <rect
        className="graph-canvas-node-body"
        width={width}
        height={height}
        rx={CORNER}
        ry={CORNER}
        fill={hue}
        stroke={hue}
      />
      <rect className="graph-canvas-node-rail" width={RAIL_WIDTH} height={height} fill={hue} />

      {/* Outside the body so the cursor ring never competes with the selection
          stroke or the dashed cycle stroke for the same edge. */}
      {cursor && (
        <rect
          className="graph-canvas-node-cursor"
          x={-3}
          y={-3}
          width={width + 6}
          height={height + 6}
          rx={CORNER + 2}
          ry={CORNER + 2}
          fill="none"
        />
      )}

      {/* Centred on the id line rather than on the node: the glyph and the id
          read as one label. */}
      <TypeGlyph type={node.type} x={14} y={height / 2 - 9 - ICON_SIZE / 2} />

      <text className="graph-canvas-node-id" x={34} y={height / 2 - 9}>
        {node.id}
      </text>
      {node.ready && (
        <text className="graph-canvas-node-flag" x={width - 12} y={height / 2 - 9} textAnchor="end">
          ready
        </text>
      )}
      {!node.ready && node.leverage > 0 && (
        <text className="graph-canvas-node-flag" x={width - 12} y={height / 2 - 9} textAnchor="end">
          unblocks {node.leverage}
        </text>
      )}

      <text className="graph-canvas-node-title" x={14} y={height / 2 + 8}>
        {truncate(node.label, width - 26)}
      </text>

      {node.progress && (
        <text className="graph-canvas-node-meta" x={14} y={height / 2 + 24}>
          {node.progress.closed} of {node.progress.total} closed
        </text>
      )}

      {/* One text node: a <title> with element children renders as markup. */}
      <title>
        {`${node.id} — ${node.label}${node.rolled ? ` (${node.members.length} beads)` : ""}`}
      </title>
    </g>
  );
}

/**
 * The type icon, inlined from the Font Awesome set the rest of the extension
 * uses. Nested `<svg>` keeps each icon's own viewBox intact, so one sizing rule
 * covers glyphs drawn on 384-, 448-, and 512-wide grids.
 */
function TypeGlyph({
  type,
  x,
  y,
}: {
  type?: string;
  x: number;
  y: number;
}): React.ReactElement | null {
  const markup = useMemo(() => {
    const source = icons[(type ?? "") as keyof typeof icons] ?? icons.notdef;
    return source
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(
        /<svg/,
        `<svg x="${x}" y="${y}" width="${ICON_SIZE}" height="${ICON_SIZE}" fill="${typeHue(type)}"`
      );
  }, [type, x, y]);

  return (
    <g
      className="graph-canvas-node-glyph"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function EmptyCanvas({
  lens,
  nodeCount,
  anchored,
}: {
  lens: GraphLens;
  nodeCount: number;
  anchored: boolean;
}): React.ReactElement {
  if (lens === "blast-radius" && !anchored) {
    return (
      <div className="graph-canvas-empty">
        <p>Select a bead to see what it blocks and what blocks it.</p>
      </div>
    );
  }

  if (nodeCount === 0) {
    return (
      <div className="graph-canvas-empty">
        <p>Nothing to draw at this lens.</p>
        <p className="graph-canvas-empty-hint">
          Switch to <strong>{LENS_LABELS.full}</strong> to see every bead.
        </p>
      </div>
    );
  }

  return (
    <div className="graph-canvas-empty">
      <p>
        {nodeCount} {nodeCount === 1 ? "bead" : "beads"}, no blocking links between them.
      </p>
      <p className="graph-canvas-empty-hint">
        Link two with <code>bd dep add &lt;blocked&gt; &lt;blocker&gt;</code>, or read the list
        below.
      </p>
    </div>
  );
}

/** A rounded polyline through dagre's routed points. */
function edgePath(path: GraphLayoutEdgePath): string {
  const points = path.points;
  if (points.length === 0) return "";
  if (points.length < 3) {
    return `M ${points[0].x} ${points[0].y} L ${points[points.length - 1].x} ${
      points[points.length - 1].y
    }`;
  }

  // Quadratic through each interior point, ending on the midpoints either side,
  // which rounds the corners without inventing a route dagre did not choose.
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function clampZoom(width: number, fitWidth: number): number {
  const min = fitWidth / MAX_ZOOM;
  const max = fitWidth / MIN_ZOOM;
  return Math.min(max, Math.max(min, width));
}

/** Why the cursor did not move. Silence would read as a dropped keystroke. */
function deadEnd(direction: TraverseDirection, from: string): string {
  switch (direction) {
    case "blocker":
      return `Nothing blocks ${from}.`;
    case "blocked":
      return `${from} blocks nothing.`;
    default:
      return `No other bead shares a link with ${from}.`;
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * SVG text has no ellipsis, so titles are cut to fit. The 6.2px estimate is one
 * character at the editor's default 12px UI font; a wider theme font cuts a
 * little early, which is the safe direction - overflowing text would sit on top
 * of the next node.
 */
function truncate(text: string, availableWidth: number): string {
  const max = Math.max(4, Math.floor(availableWidth / 6.2));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
