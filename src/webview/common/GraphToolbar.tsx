/**
 * GraphToolbar - the controls above the dependency DAG.
 *
 * Grouped by the question each one answers, left to right: which beads am I
 * looking at (lens), where is the one I mean (find), how many are there
 * (count), and how do I frame them (viewport). Nothing here holds state; the
 * canvas owns all of it, so the toolbar can be read as a description of what
 * the graph currently is.
 *
 * The find field reports its result as text rather than only as dimming, so the
 * "no matches" case is a sentence and not an unexplained grey canvas.
 */

import React from "react";
import { GraphLens, GRAPH_LENSES, LENS_LABELS } from "../../graph/lens";

export interface GraphToolbarProps {
  lens: GraphLens;
  onLensChange: (lens: GraphLens) => void;
  /** Blast radius needs a bead to radiate from; without one its button explains why. */
  anchored: boolean;

  query: string;
  onQueryChange: (query: string) => void;
  onQueryKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  findInputRef?: React.RefObject<HTMLInputElement>;
  /** How many nodes the query hit. `null` while the find is inactive. */
  matchCount: number | null;

  nodeCount: number;
  edgeCount: number;
  /** Beads in the model this lens does not represent at all. */
  omitted: number;

  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitAll: () => void;
  onFitSelection: () => void;
  canFit: boolean;
  /** False when nothing is selected, or the selection is not on this lens. */
  canFitSelection: boolean;
}

export function GraphToolbar({
  lens,
  onLensChange,
  anchored,
  query,
  onQueryChange,
  onQueryKeyDown,
  findInputRef,
  matchCount,
  nodeCount,
  edgeCount,
  omitted,
  onZoomIn,
  onZoomOut,
  onFitAll,
  onFitSelection,
  canFit,
  canFitSelection,
}: GraphToolbarProps): React.ReactElement {
  const active = query.trim().length > 0;

  return (
    <div className="graph-canvas-toolbar">
      <div className="graph-canvas-lenses" role="group" aria-label="Graph lens">
        {GRAPH_LENSES.map((option) => (
          <button
            key={option}
            type="button"
            className={`graph-canvas-lens${option === lens ? " active" : ""}`}
            aria-pressed={option === lens}
            disabled={option === "blast-radius" && !anchored}
            title={
              option === "blast-radius" && !anchored
                ? "Select a bead to see what it touches"
                : undefined
            }
            onClick={() => onLensChange(option)}
          >
            {LENS_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="graph-canvas-find">
        <input
          ref={findInputRef}
          type="text"
          className="graph-canvas-find-input"
          value={query}
          placeholder="Find by id or title"
          aria-label="Find in graph"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onQueryKeyDown}
        />
        {active && (
          <button
            type="button"
            className="graph-canvas-find-clear"
            aria-label="Clear find"
            onClick={() => onQueryChange("")}
          >
            ×
          </button>
        )}
      </div>

      <p className="graph-canvas-count" role="status">
        {active
          ? matchCount === 0
            ? `No beads match “${query.trim()}”`
            : `${matchCount} of ${nodeCount} match “${query.trim()}”`
          : `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} · ${edgeCount} ${
              edgeCount === 1 ? "link" : "links"
            }${omitted > 0 ? ` · ${omitted} not shown` : ""}`}
      </p>

      <div className="graph-canvas-zoom" role="group" aria-label="Viewport">
        <button
          type="button"
          onClick={onFitSelection}
          disabled={!canFitSelection}
          title={
            canFitSelection
              ? "Frame the selected bead and what it links to"
              : "Select a bead to frame it"
          }
        >
          Fit selection
        </button>
        <button type="button" onClick={onFitAll} disabled={!canFit}>
          Fit all
        </button>
        <button type="button" onClick={onZoomIn} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={onZoomOut} aria-label="Zoom out">
          −
        </button>
      </div>
    </div>
  );
}
