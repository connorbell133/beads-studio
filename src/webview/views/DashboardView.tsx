/**
 * DashboardView
 *
 * The glance surface. Its user opens the sidebar between agent runs to answer,
 * in seconds: is anything on fire, and what can be started right now? The
 * dashboard answers with numbers and one recommendation, then routes - the
 * stat strip opens the Issues list pre-filtered rather than repeating its rows
 * here, because in a stacked sidebar every row this view renders is height
 * taken from the list that does rows better.
 */

import React, { useMemo } from "react";
import {
  Bead,
  BeadsGraphModel,
  BeadsProject,
  BeadsSummary,
  BeadType,
  STATUS_COLORS,
  STATUS_LABELS,
  UNKNOWN_STATUS_COLOR,
} from "../types";
import { buildReadyLane } from "../../graph/readyLane";
import { computePulse } from "../../graph/pulse";
import { ErrorMessage } from "../common/ErrorMessage";
import { Timestamp } from "../common/Timestamp";
import { Loading } from "../common/Loading";
import { ProjectDropdown } from "../common/ProjectDropdown";
import { Dropdown, DropdownItem } from "../common/Dropdown";
import { StatusRing } from "../common/StatusRing";
import { PriorityIcon } from "../common/PriorityIcon";
import { TypeIcon } from "../common/TypeIcon";
import { LeverageBadge } from "../common/LeverageBadge";
import { GRAPHIC_TOKENS, TEXT_TOKENS } from "../theme/tokens";

/** Built-ins draw in lifecycle order; customs follow, busiest first. */
const STATUS_ORDER = ["open", "in_progress", "blocked", "deferred", "closed"];

/** Statuses the stat strip already accounts for (open = ready + blocked). */
const STRIP_STATUSES = ["open", "in_progress", "blocked"];

interface DashboardViewProps {
  summary: BeadsSummary | null;
  beads: Bead[];
  /** When ids became ready, recorded by the provider across its loads. */
  pulseEvents: { id: string; at: number }[];
  /** Null until the first derive lands. */
  graph: BeadsGraphModel | null;
  selectedBeadId: string | null;
  loading: boolean;
  error: string | null;
  projects: BeadsProject[];
  activeProject: BeadsProject | null;
  onSelectProject: (project: BeadsProject) => void;
  onSelectBead: (beadId: string) => void;
  onShowStatus: () => void;
  onStartDolt: () => void;
  onStopDolt: () => void;
  onOpenDoltLog: () => void;
  onOpenProjectFolder: () => void;
  onOpenIssuesPreset: (presetId: string) => void;
  onOpenGraph: () => void;
  onRetry: () => void;
}

export function DashboardView({
  summary,
  beads,
  pulseEvents,
  graph,
  selectedBeadId,
  loading,
  error,
  projects,
  activeProject,
  onSelectProject,
  onSelectBead,
  onShowStatus,
  onStartDolt,
  onStopDolt,
  onOpenDoltLog,
  onOpenProjectFolder,
  onOpenIssuesPreset,
  onOpenGraph,
  onRetry,
}: DashboardViewProps): React.ReactElement {
  const distribution = summary
    ? Object.entries(summary.byStatus)
        .filter(([, count]) => count > 0)
        .sort(([aStatus, aCount], [bStatus, bCount]) => {
          const ai = STATUS_ORDER.indexOf(aStatus);
          const bi = STATUS_ORDER.indexOf(bStatus);
          if (ai !== -1 || bi !== -1) {
            return (ai === -1 ? STATUS_ORDER.length : ai) - (bi === -1 ? STATUS_ORDER.length : bi);
          }
          return bCount - aCount;
        })
    : [];

  // The one thing the graph knows that a list cannot say: the best pick-up
  // right now, or - when nothing is ready - the bead gating the most work.
  const lane = useMemo(
    () => (graph ? buildReadyLane(graph, beads) : null),
    [graph, beads]
  );
  const pick = lane?.ready[0] ?? null;
  const gate = !pick ? lane?.topBlocker ?? null : null;

  // What happened while the operator wasn't looking - the reason this surface
  // exists. Recomputed whenever a Dolt poll lands new beads or events.
  const pulse = useMemo(() => computePulse(beads, pulseEvents), [beads, pulseEvents]);

  const progressCaption = ((): string | null => {
    if (!summary) return null;
    const parts: string[] = [];
    const closedCount = summary.byStatus["closed"] ?? 0;
    if (closedCount > 0) parts.push(`${closedCount} of ${summary.total} closed`);
    for (const [status, count] of distribution) {
      if (status === "closed" || STRIP_STATUSES.includes(status)) continue;
      parts.push(`${count} ${STATUS_LABELS[status] ?? status}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  })();

  return (
    <div className="dashboard dashboard-compact">
      <div className="dashboard-toolbar">
        <ProjectDropdown
          projects={projects}
          activeProject={activeProject}
          onSelectProject={onSelectProject}
        />
        {activeProject && (
          <button
            type="button"
            className="dashboard-menu-btn dashboard-graph-btn"
            title="Open Dependency Graph (Ctrl/Cmd+Alt+G)"
            aria-label="Open dependency graph"
            onClick={onOpenGraph}
          >
            {/* The extension's own mark: two strands converging on a goal. */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="6.5" r="3" />
              <circle cx="5.5" cy="18.5" r="2.5" />
              <circle cx="18.5" cy="18.5" r="2.5" />
              <path d="M 6.9 16.2 L 10.6 9.2 M 17.1 16.2 L 13.4 9.2" />
            </svg>
          </button>
        )}
        {activeProject && (
          <Dropdown
            trigger={<span className="dashboard-menu-trigger">⋮</span>}
            className="dashboard-actions-dropdown"
            triggerClassName="dashboard-menu-btn"
            menuClassName="dashboard-actions-menu"
            title="Project actions"
            showChevron={false}
            menuPlacement="bottom-end"
          >
            <DropdownItem onClick={onOpenProjectFolder}>
              <span className="dashboard-menu-item" title={activeProject.rootPath}><span className="dashboard-menu-item-icon">▤</span><span>Open Project Folder</span></span>
            </DropdownItem>
            <DropdownItem onClick={onRetry}>
              <span className="dashboard-menu-item"><span className="dashboard-menu-item-icon">↻</span><span>Refresh</span></span>
            </DropdownItem>
            <DropdownItem onClick={onShowStatus}>
              <span className="dashboard-menu-item"><span className="dashboard-menu-item-icon">i</span><span>Show Dolt Status</span></span>
            </DropdownItem>
            <DropdownItem onClick={onStartDolt}>
              <span className="dashboard-menu-item"><span className="dashboard-menu-item-icon">▶</span><span>Start Dolt</span></span>
            </DropdownItem>
            <DropdownItem onClick={onStopDolt}>
              <span className="dashboard-menu-item"><span className="dashboard-menu-item-icon">■</span><span>Stop Dolt</span></span>
            </DropdownItem>
            <DropdownItem onClick={onOpenDoltLog}>
              <span className="dashboard-menu-item"><span className="dashboard-menu-item-icon">≡</span><span>Open Dolt Log</span></span>
            </DropdownItem>
          </Dropdown>
        )}
      </div>

      {error && !loading && <ErrorMessage message={error} onRetry={onRetry} />}

      {loading && !error && <Loading />}

      {summary && !error && (
        <>
          {/* Numbers at 18px bold count as large text, where the graphic-only
              tokens still clear 3:1 - the label below stays in muted text. */}
          <div className="dash-stats" role="group" aria-label="Project summary">
            <button
              type="button"
              className="dash-stat dash-stat-btn"
              title="All beads - open the Issues list"
              onClick={() => onOpenIssuesPreset("all")}
            >
              <span className="dash-stat-value">{summary.total || 0}</span>
              <span className="dash-stat-label">Total</span>
            </button>
            <button
              type="button"
              className="dash-stat dash-stat-btn"
              title="Open beads with no unresolved blocker - open the top pick"
              disabled={!pick}
              onClick={() => pick && onSelectBead(pick.bead.id)}
            >
              <span className="dash-stat-value" style={{ color: GRAPHIC_TOKENS.success }}>
                {summary.readyCount || 0}
              </span>
              <span className="dash-stat-label">Ready</span>
            </button>
            <button
              type="button"
              className="dash-stat dash-stat-btn"
              title="Work in flight - open the Issues list on Active"
              onClick={() => onOpenIssuesPreset("active")}
            >
              <span className="dash-stat-value" style={{ color: TEXT_TOKENS.info }}>
                {summary.inProgressCount || 0}
              </span>
              <span className="dash-stat-label">Doing</span>
            </button>
            <button
              type="button"
              className="dash-stat dash-stat-btn"
              title="Open beads waiting on a blocker - open the Issues list on Blocked"
              onClick={() => onOpenIssuesPreset("blocked")}
            >
              <span className="dash-stat-value" style={{ color: TEXT_TOKENS.danger }}>
                {summary.blockedCount || 0}
              </span>
              <span className="dash-stat-label">Blocked</span>
            </button>
          </div>

          {/* The strip owns open/doing/blocked, so the bar is the denominator
              rather than a second summary: its caption names only the statuses
              the strip does not - no number appears on this surface twice. */}
          {distribution.length > 0 && (
            <div className="dash-progress">
              <div
                className="dash-distribution"
                role="img"
                aria-label={distribution
                  .map(([status, count]) => `${STATUS_LABELS[status] ?? status}: ${count}`)
                  .join(", ")}
              >
                {distribution.map(([status, count]) => (
                  <span
                    key={status}
                    className="dash-distribution-segment"
                    style={{
                      flexGrow: count,
                      backgroundColor: STATUS_COLORS[status] ?? UNKNOWN_STATUS_COLOR,
                    }}
                    title={`${STATUS_LABELS[status] ?? status}: ${count}`}
                  />
                ))}
              </div>
              {progressCaption && <p className="dash-progress-caption">{progressCaption}</p>}
            </div>
          )}

          {summary.degraded && (
            // Placed with the counts it qualifies, not at the top of the view:
            // the imprecision lives in "Blocked", so the caveat belongs there.
            <p className="summary-degraded" role="status">
              Blocked may over-report: this bd build cannot list gate and agent
              beads, so some blockers cannot be checked. Upgrade bd for exact counts.
            </p>
          )}

          <section className="dash-section" aria-label="Activity in the last hour">
            <h3 className="dash-section-title">
              Pulse <span className="dash-section-sub">last hour</span>
            </h3>
            {pulse.quiet ? (
              <p className="dash-pulse-quiet">Quiet hour - nothing closed, filed, or unblocked.</p>
            ) : (
              <div className="dash-pulse-line">
                {pulse.closed.length > 0 && (
                  <PulseChip color={GRAPHIC_TOKENS.muted} count={pulse.closed.length} noun="closed" />
                )}
                {pulse.filed.length > 0 && (
                  <PulseChip color={TEXT_TOKENS.info} count={pulse.filed.length} noun="filed" />
                )}
                {pulse.newlyReady.length > 0 && (
                  <PulseChip
                    color={GRAPHIC_TOKENS.success}
                    count={pulse.newlyReady.length}
                    noun="newly ready"
                  />
                )}
              </div>
            )}
          </section>

          {/* An alert is not activity: a claim that stopped moving gets its own
              labeled frame rather than squatting inside "last hour" with a
              timespan that contradicts it. The words carry the meaning; the
              amber dot only reinforces. */}
          {pulse.staleClaims.length > 0 && (
            <section className="dash-section" aria-label="Stalled claims">
              <h3 className="dash-section-title">
                Stalled <span className="dash-section-sub">claimed, but not moving</span>
              </h3>
              {pulse.staleClaims.map(({ bead, heldMs }) => (
                <div
                  key={bead.id}
                  className="ready-lane-row"
                  title={`In progress but untouched for ${heldFor(heldMs)} - if an agent claimed this, it may have crashed. Open it to unclaim or reassign.`}
                  onClick={() => onSelectBead(bead.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectBead(bead.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="ready-lane-row-main">
                    <span
                      className="dash-stale-dot"
                      style={{ backgroundColor: GRAPHIC_TOKENS.warning }}
                      aria-hidden="true"
                    />
                    <span className="ready-lane-id">{bead.id}</span>
                    <span className="ready-lane-title">{bead.title}</span>
                    <span className="dash-stale-held">
                      {bead.assignee ? `${bead.assignee} · ` : ""}idle {heldFor(heldMs)}
                    </span>
                  </div>
                </div>
              ))}
            </section>
          )}

          {(pick || gate) && (
            <section className="dash-section" aria-label="Up next">
              <h3 className="dash-section-title">Up next</h3>
              {pick ? (
                <UpNextRow
                  bead={pick.bead}
                  unblocks={pick.unblocks}
                  selected={pick.bead.id === selectedBeadId}
                  onSelectBead={onSelectBead}
                />
              ) : gate ? (
                <>
                  <p className="dash-upnext-hint">
                    Nothing is ready - this gates the most work:
                  </p>
                  {gate.bead ? (
                    <UpNextRow
                      bead={gate.bead}
                      unblocks={gate.unblocks}
                      selected={gate.bead.id === selectedBeadId}
                      onSelectBead={onSelectBead}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ready-lane-action"
                      onClick={() => onSelectBead(gate.id)}
                    >
                      Open {gate.id}
                    </button>
                  )}
                </>
              ) : null}
            </section>
          )}

          {pulse.activity.length > 0 && (
            <section className="dash-section" aria-label="Recent activity">
              <h3 className="dash-section-title">Activity</h3>
              {pulse.activity.map((bead) => (
                <div
                  key={bead.id}
                  className={`ready-lane-row${bead.id === selectedBeadId ? " ready-lane-row-selected" : ""}`}
                  title={bead.assignee ? `${bead.title} - ${bead.assignee}` : bead.title}
                  onClick={() => onSelectBead(bead.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectBead(bead.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="ready-lane-row-main">
                    <StatusRing status={bead.status} size={13} />
                    <span className="ready-lane-id">{bead.id}</span>
                    <span className="ready-lane-title">{bead.title}</span>
                    {bead.updatedAt && (
                      <span className="dash-activity-time">
                        <Timestamp value={bead.updatedAt} format="relative" />
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}

        </>
      )}
    </div>
  );
}

/** "3h" past the hour mark, "40m" under it - held times, not timestamps. */
function heldFor(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** The dot is reinforcement, the label is the message. */
function PulseChip({
  color,
  count,
  noun,
}: {
  color: string;
  count: number;
  noun: string;
}): React.ReactElement {
  return (
    <span className="dash-pulse-chip">
      <span className="dash-pulse-dot" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="dash-pulse-count">{count}</span> {noun}
    </span>
  );
}

/** One row on the issues list's anatomy: the recommendation, not a list. */
function UpNextRow({
  bead,
  unblocks,
  selected,
  onSelectBead,
}: {
  bead: Bead;
  unblocks: number;
  selected: boolean;
  onSelectBead: (beadId: string) => void;
}): React.ReactElement {
  return (
    <div
      className={`ready-lane-row${selected ? " ready-lane-row-selected" : ""}`}
      onClick={() => onSelectBead(bead.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectBead(bead.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="ready-lane-row-main">
        <PriorityIcon priority={bead.priority} />
        <span className="ready-lane-id">{bead.id}</span>
        <TypeIcon type={(bead.type ?? "task") as BeadType} size={13} />
        <span className="ready-lane-title">{bead.title}</span>
        <LeverageBadge leverage={unblocks} variant="dot" />
      </div>
    </div>
  );
}
