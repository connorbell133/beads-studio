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
import {
  ContainerOption,
  GraphLens,
  GRAPH_LENSES,
  LENS_DESCRIPTIONS,
  LENS_LABELS,
} from "../../graph/lens";
import { Dropdown, DropdownItem } from "./Dropdown";

export interface GraphToolbarProps {
  lens: GraphLens;
  onLensChange: (lens: GraphLens) => void;
  /** Blast radius needs a bead to radiate from; without one its button explains why. */
  anchored: boolean;

  /**
   * What the container lens can anchor on, already filtered. Empty disables
   * that lens's tab. Epics, milestones, and anything else holding work.
   */
  containers: ContainerOption[];
  /** The container the container lens is anchored on. */
  containerId: string | null;
  onContainerChange: (containerId: string) => void;
  /** Whether finished containers are being listed alongside the live ones. */
  showCompleted: boolean;
  onShowCompletedChange: (showCompleted: boolean) => void;
  /** Finished containers the default filter is holding back. 0 hides the toggle. */
  hiddenContainerCount: number;

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

  /**
   * The filter controls, rendered inline after the lens group so the preset
   * shares the toolbar row instead of floating detached beneath it. Wraps
   * with the rest of the row when the panel narrows.
   */
  children?: React.ReactNode;
}

export function GraphToolbar({
  lens,
  onLensChange,
  anchored,
  containers,
  containerId,
  onContainerChange,
  showCompleted,
  onShowCompletedChange,
  hiddenContainerCount,
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
  children,
}: GraphToolbarProps): React.ReactElement {
  const active = query.trim().length > 0;

  return (
    <div className="graph-canvas-toolbar">
      <div className="graph-canvas-lenses" role="group" aria-label="Graph lens">
        {GRAPH_LENSES.map((option) => {
          const disabled =
            (option === "blast-radius" && !anchored) ||
            (option === "epic" && containers.length === 0);
          return (
            <button
              key={option}
              type="button"
              className={`graph-canvas-lens${option === lens ? " active" : ""}`}
              aria-pressed={option === lens}
              disabled={disabled}
              title={
                option === "blast-radius" && !anchored
                  ? "Select a bead to see what it touches"
                  : option === "epic" && containers.length === 0
                    ? "Nothing holds work in this project yet"
                    : LENS_DESCRIPTIONS[option]
              }
              onClick={() => onLensChange(option)}
            >
              {LENS_LABELS[option]}
            </button>
          );
        })}
      </div>

      {/* Which container, but only while the answer matters. The picker names
          the container rather than labelling itself - the active tab already
          says what kind of thing it is. */}
      {lens === "epic" && containers.length > 0 && (
        <Dropdown
          className="graph-canvas-epic-picker"
          triggerClassName="graph-canvas-epic-trigger"
          title="Choose which container to draw"
          trigger={
            <span className="graph-canvas-epic-label">
              {containers.find((container) => container.id === containerId)?.label ??
                "Choose a container"}
            </span>
          }
        >
          {containers.map((container) => (
            <DropdownItem
              key={container.id}
              active={container.id === containerId}
              onClick={() => onContainerChange(container.id)}
              title={`${container.id} — ${container.label}`}
            >
              <span className="graph-canvas-epic-option">{container.label}</span>
              <span className="graph-canvas-epic-progress">
                {container.closed}/{container.total}
              </span>
            </DropdownItem>
          ))}

          {/* Not a DropdownItem: that closes the menu on click, and the point
              of the toggle is to see the list it just changed. Named with its
              count so the omission is visible rather than inferred from a
              shorter list than you remembered. */}
          {hiddenContainerCount > 0 && (
            <button
              type="button"
              className="dropdown-item graph-canvas-epic-toggle"
              aria-pressed={showCompleted}
              title={
                showCompleted
                  ? "List only containers with work still open"
                  : "Also list containers whose every bead has closed"
              }
              onClick={() => onShowCompletedChange(!showCompleted)}
            >
              <span className="graph-canvas-epic-toggle-box" aria-hidden="true">
                {showCompleted ? "✓" : ""}
              </span>
              <span className="graph-canvas-epic-option">
                Show completed ({hiddenContainerCount})
              </span>
            </button>
          )}
        </Dropdown>
      )}

      {children}

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
