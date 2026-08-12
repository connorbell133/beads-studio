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
import {
  applyLens,
  DEFAULT_LENS,
  GRAPH_LENSES,
  GraphLens,
  LENS_LABELS,
  LensNode,
} from "../../graph/lens";
import { GraphLayoutEdgePath, GraphLayoutPosition, layoutGraph } from "../../graph/layout";

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

export function GraphCanvas({
  beads,
  graph,
  lens,
  onLensChange,
  focusId,
  selectedBeadId,
  onSelectBead,
  className,
}: GraphCanvasProps): React.ReactElement {
  const [ownLens, setOwnLens] = useState<GraphLens>(DEFAULT_LENS);
  const activeLens = lens ?? ownLens;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const markerId = useMemo(() => `graph-canvas-${++canvasSequence}`, []);

  const anchor = focusId ?? selectedBeadId ?? null;

  const view = useMemo(() => {
    if (!graph) return null;
    const result = applyLens(graph, beads, { lens: activeLens, focusId: anchor });
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
    return { result, sized, laidOut };
  }, [graph, beads, activeLens, anchor]);

  const nodes = view?.result.nodes ?? [];
  const edges = view?.result.edges ?? [];
  const bounds = view?.laidOut.bounds;

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
    onSelectBead?.(node.id);
  };

  const chooseLens = (next: GraphLens): void => {
    if (lens === undefined) setOwnLens(next);
    onLensChange?.(next);
  };

  const positions = view?.laidOut.positions ?? new Map<string, GraphLayoutPosition>();
  const sizes = new Map(view?.sized.map((node) => [node.id, node]) ?? []);
  const edgeByPair = new Map(edges.map((edge) => [`${edge.blocker}\t${edge.blocked}`, edge]));

  const label = `Dependency graph, ${LENS_LABELS[activeLens].toLowerCase()} lens: ${
    nodes.length
  } ${nodes.length === 1 ? "bead" : "beads"}, ${edges.length} blocking ${
    edges.length === 1 ? "link" : "links"
  }`;

  return (
    <div className={`graph-canvas${className ? ` ${className}` : ""}`}>
      <div className="graph-canvas-toolbar">
        <div className="graph-canvas-lenses" role="group" aria-label="Graph lens">
          {GRAPH_LENSES.map((option) => (
            <button
              key={option}
              type="button"
              className={`graph-canvas-lens${option === activeLens ? " active" : ""}`}
              aria-pressed={option === activeLens}
              disabled={option === "blast-radius" && !anchor}
              title={
                option === "blast-radius" && !anchor
                  ? "Select a bead to see what it touches"
                  : undefined
              }
              onClick={() => chooseLens(option)}
            >
              {LENS_LABELS[option]}
            </button>
          ))}
        </div>

        <p className="graph-canvas-count">
          {nodes.length} {nodes.length === 1 ? "node" : "nodes"} · {edges.length}{" "}
          {edges.length === 1 ? "link" : "links"}
          {view && view.result.omitted > 0 && ` · ${view.result.omitted} not shown`}
        </p>

        <div className="graph-canvas-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => setViewBox(fit)} disabled={!fit}>
            Fit
          </button>
        </div>
      </div>

      {graph && !graph.complete && (
        <p className="graph-canvas-degraded" role="status">
          Some beads could not be loaded, so this graph may be missing links.
        </p>
      )}

      {edges.length === 0 || !viewBox ? (
        <EmptyCanvas lens={activeLens} nodeCount={nodes.length} anchored={Boolean(anchor)} />
      ) : (
        <svg
          ref={svgRef}
          className="graph-canvas-svg"
          role="img"
          aria-label={label}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
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
              const cycle = isCycleEdge(path, nodes);
              return (
                <path
                  key={`${path.source}\t${path.target}`}
                  className={`graph-canvas-edge${cycle ? " in-cycle" : ""}`}
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
                  focused={node.id === anchor && activeLens === "blast-radius"}
                  onSelect={selectNode}
                />
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

interface GraphNodeProps {
  node: LensNode;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  focused: boolean;
  onSelect: (node: LensNode) => void;
}

function GraphNode({
  node,
  x,
  y,
  width,
  height,
  selected,
  focused,
  onSelect,
}: GraphNodeProps): React.ReactElement {
  const hue = statusHue(node.status);
  const classes = [
    "graph-canvas-node",
    selected ? "selected" : "",
    focused ? "focused" : "",
    node.inCycle ? "in-cycle" : "",
    node.ready ? "ready" : "",
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

function isCycleEdge(path: GraphLayoutEdgePath, nodes: LensNode[]): boolean {
  const tangled = (id: string): boolean => nodes.some((node) => node.id === id && node.inCycle);
  return tangled(path.source) && tangled(path.target);
}

function clampZoom(width: number, fitWidth: number): number {
  const min = fitWidth / MAX_ZOOM;
  const max = fitWidth / MIN_ZOOM;
  return Math.min(max, Math.max(min, width));
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
