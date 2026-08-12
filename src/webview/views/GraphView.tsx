/**
 * GraphView - the dependency graph in an editor tab.
 *
 * This is the text layer: an adjacency list naming each bead and its blockers.
 * It is not a fallback bolted on after the picture - it is the accessible
 * representation the SVG layer will sit on top of, so a screen reader gets the
 * same relationships a sighted user reads off the diagram. A DAG that exists
 * only as <path> elements conveys nothing to assistive technology.
 */

import React, { useMemo } from "react";
import { Bead, BeadsGraphModel } from "../types";
import { StatusBadge } from "../common/StatusBadge";
import { TypeIcon } from "../common/TypeIcon";
import { Loading } from "../common/Loading";
import { ErrorMessage } from "../common/ErrorMessage";

interface GraphViewProps {
  beads: Bead[];
  graph: BeadsGraphModel | null;
  loading: boolean;
  error: string | null;
  selectedBeadId: string | null;
  onSelectBead: (beadId: string) => void;
  onRetry: () => void;
}

export function GraphView({
  beads,
  graph,
  loading,
  error,
  selectedBeadId,
  onSelectBead,
  onRetry,
}: GraphViewProps): React.ReactElement {
  const byId = useMemo(() => new Map(beads.map((b) => [b.id, b])), [beads]);

  // Deepest-first: a bead nothing blocks reads as the root of its chain, and
  // the order matches the sequence work would actually be done in.
  const ordered = useMemo(() => {
    if (!graph) return [];
    return Object.values(graph.nodes)
      .filter((node) => byId.has(node.id))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          b.leverage - a.leverage ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
  }, [graph, byId]);

  const edgeCount = useMemo(
    () => (graph ? Object.values(graph.nodes).reduce((n, x) => n + x.blockedBy.length, 0) : 0),
    [graph]
  );

  if (error) {
    return <ErrorMessage message={error} onRetry={onRetry} />;
  }

  if (loading && !graph) {
    return <Loading />;
  }

  if (!graph || ordered.length === 0) {
    return (
      <div className="empty-state">
        <p>No beads to graph yet.</p>
        <p className="empty-state-hint">
          Create one with <code>bd create</code>, then link it with{" "}
          <code>bd dep add</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="graph-view">
      <header className="graph-header">
        <h1 className="graph-title">Dependency graph</h1>
        <p className="graph-summary">
          {ordered.length} beads, {edgeCount} blocking {edgeCount === 1 ? "link" : "links"}
          {graph.hasCycle && (
            <>
              {" · "}
              <span className="graph-cycle-warning">
                {graph.cycles.length} {graph.cycles.length === 1 ? "cycle" : "cycles"}
              </span>
            </>
          )}
        </p>
        {!graph.complete && (
          <p className="summary-degraded" role="status">
            Some beads could not be loaded, so blocking links may be incomplete.
          </p>
        )}
      </header>

      <ul className="graph-adjacency" aria-label="Beads and their blockers">
        {ordered.map((node) => {
          const bead = byId.get(node.id);
          if (!bead) return null;
          const isSelected = node.id === selectedBeadId;

          return (
            <li
              key={node.id}
              className={`graph-row${isSelected ? " selected" : ""}${
                node.inCycle ? " in-cycle" : ""
              }`}
            >
              <button
                type="button"
                className="graph-row-main"
                onClick={() => onSelectBead(node.id)}
                aria-current={isSelected ? "true" : undefined}
              >
                <TypeIcon type={bead.type ?? ""} />
                <span className="graph-row-id">{node.id}</span>
                <span className="graph-row-title">{bead.title}</span>
                <StatusBadge status={bead.status} />
                {node.ready && <span className="graph-chip ready">ready</span>}
                {node.leverage > 0 && (
                  <span className="graph-chip" title="Beads unblocked when this closes">
                    unblocks {node.leverage}
                  </span>
                )}
              </button>

              {node.blockedBy.length > 0 && (
                <p className="graph-row-blockers">
                  <span className="graph-blockers-label">blocked by</span>{" "}
                  {node.blockedBy.map((blockerId, i) => (
                    <React.Fragment key={blockerId}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        className="graph-blocker-link"
                        onClick={() => onSelectBead(blockerId)}
                      >
                        {blockerId}
                        {byId.get(blockerId) ? "" : " (not loaded)"}
                      </button>
                    </React.Fragment>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
