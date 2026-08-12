/**
 * ReadyLane
 *
 * Graph-derived readiness as a surface of its own: what can be picked up right
 * now, what each pick-up would release, and - for everything else - the chain
 * of beads standing in the way.
 *
 * A list, not a card grid. A row here is not a container for its own
 * interaction, it *is* the interaction, so card chrome would add weight without
 * meaning. Grouping comes from a header and spacing rather than borders.
 *
 * Every decision this file could make about ordering, grouping, or chain length
 * is made in `src/graph/readyLane.ts` instead, which is where the tests can
 * reach it. What is left here is markup and interaction state.
 */

import React, { useEffect, useMemo, useRef } from "react";
import {
  BlockerChain as BlockerChainModel,
  BlockedRow,
  ReadyRow,
  buildReadyLane,
} from "../../graph/readyLane";
import { Bead, BeadsGraphModel } from "../types";
import { BlockerChain } from "../common/BlockerChain";
import { LeverageBadge } from "../common/LeverageBadge";
import { PriorityBadge } from "../common/PriorityBadge";
import { StatusBadge } from "../common/StatusBadge";
import { TypeIcon } from "../common/TypeIcon";
import { useRovingFocus } from "../hooks/useRovingFocus";
import { GRAPHIC_TOKENS, TEXT_TOKENS } from "../theme/tokens";

export interface ReadyLaneProps {
  beads: Bead[];
  /** Null before the first graph arrives, which reads as loading. */
  graph: BeadsGraphModel | null;
  loading?: boolean;
  /** Rendered inline in the lane rather than as a toast that disappears. */
  error?: string | null;
  /** Named in the error line so the failure says what failed. */
  operation?: string;
  /** Held by the extension and broadcast, so it survives focus moving away. */
  selectedId?: string | null;
  chainCap?: number;
  onSelectBead: (beadId: string) => void;
  onRetry?: () => void;
}

/** Enough skeleton rows to fill the lane's usual height without overshooting. */
const SKELETON_ROWS = 5;

interface RowProps {
  bead: Bead;
  selected: boolean;
  tabIndex: 0 | -1;
  /** Graph facts shown on the row: leverage for ready, the chain for blocked. */
  unblocks?: number;
  chain?: BlockerChainModel;
  inCycle: boolean;
  unknownBlockers?: readonly string[];
  onSelect: (beadId: string) => void;
  onFocus: () => void;
}

const Row = React.forwardRef<HTMLDivElement, RowProps>(function Row(
  { bead, selected, tabIndex, unblocks, chain, inCycle, unknownBlockers, onSelect, onFocus },
  ref
): React.ReactElement {
  return (
    <div
      ref={ref}
      className={`ready-lane-row${selected ? " ready-lane-row-selected" : ""}`}
      role="option"
      aria-selected={selected}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={() => onSelect(bead.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(bead.id);
        }
      }}
    >
      <div className="ready-lane-row-main">
        <TypeIcon type={bead.type ?? "task"} size={13} />
        <PriorityBadge priority={bead.priority} size="small" />
        <span className="ready-lane-title">{bead.title}</span>
        <span className="ready-lane-id">{bead.id}</span>
      </div>
      <div className="ready-lane-row-meta">
        <StatusBadge status={bead.status} size="small" />
        <LeverageBadge leverage={unblocks ?? 0} variant="dot" />
        {inCycle && (
          <span className="ready-lane-cycle" title="This bead sits in a dependency cycle">
            <span
              className="ready-lane-cycle-dot"
              style={{ backgroundColor: GRAPHIC_TOKENS.warning }}
              aria-hidden="true"
            />
            in a cycle
          </span>
        )}
      </div>
      {chain && (
        <BlockerChain chain={chain} onSelectBlocker={onSelect} unknownIds={unknownBlockers} />
      )}
    </div>
  );
});

function SkeletonRows(): React.ReactElement {
  // Rows at the real row height rather than a spinner: the lane's length is
  // roughly predictable, and the thing worth avoiding is layout shift on
  // arrival, not the absence of a twirling icon.
  return (
    <div className="ready-lane-skeletons" aria-busy="true" aria-label="Loading ready work">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="ready-lane-skeleton" />
      ))}
    </div>
  );
}

export function ReadyLane({
  beads,
  graph,
  loading = false,
  error = null,
  operation = "Loading beads",
  selectedId = null,
  chainCap,
  onSelectBead,
  onRetry,
}: ReadyLaneProps): React.ReactElement {
  const lane = useMemo(
    () => (graph ? buildReadyLane(graph, beads, { chainCap }) : null),
    [graph, beads, chainCap]
  );

  const rows = useMemo(
    () => [
      ...(lane?.ready ?? []).map((r) => r.bead),
      ...(lane?.blocked ?? []).map((r) => r.bead),
    ],
    [lane]
  );
  const labels = useMemo(() => rows.map((b) => b.title), [rows]);
  const roving = useRovingFocus(rows.length, labels);

  const laneRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Only pull DOM focus when the lane already owns it. Moving focus into a
  // sidebar list the user is not in would steal it from whatever they are
  // actually typing in.
  useEffect(() => {
    const active = document.activeElement;
    if (!laneRef.current || !active || !laneRef.current.contains(active)) return;
    rowRefs.current[roving.activeIndex]?.focus();
  }, [roving.activeIndex]);

  const knownIds = useMemo(() => new Set(beads.map((b) => b.id)), [beads]);

  const body = (): React.ReactElement => {
    if (error) {
      return (
        <div className="ready-lane-error" role="alert">
          <span className="ready-lane-error-op" style={{ color: TEXT_TOKENS.danger }}>
            {operation} failed
          </span>
          <span className="ready-lane-error-detail">{error}</span>
          {onRetry && (
            <button type="button" className="ready-lane-action" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      );
    }

    if (loading || !lane) return <SkeletonRows />;

    if (lane.ready.length === 0 && lane.blocked.length === 0) {
      return lane.noBeads ? (
        <div className="ready-lane-empty">
          <p className="ready-lane-empty-line">No beads in this project yet.</p>
          <p className="ready-lane-empty-hint">
            Create the first one with <code>bd create &quot;title&quot;</code>.
          </p>
        </div>
      ) : (
        <div className="ready-lane-empty">
          <p className="ready-lane-empty-line">Nothing is ready and nothing is blocked.</p>
          <p className="ready-lane-empty-hint">
            Every bead is closed, in progress, or deferred. Reopen one to pick it up.
          </p>
        </div>
      );
    }

    return (
      <>
        <section className="ready-lane-group" aria-labelledby="ready-lane-ready-heading">
          <h3 className="ready-lane-group-header" id="ready-lane-ready-heading">
            Ready
            <span className="ready-lane-group-count">{lane.ready.length}</span>
          </h3>
          {lane.ready.length === 0 ? (
            <EmptyReady topBlocker={lane.topBlocker} onSelectBead={onSelectBead} />
          ) : (
            lane.ready.map((row: ReadyRow<Bead>, i) => (
              <Row
                key={row.bead.id}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                bead={row.bead}
                selected={row.bead.id === selectedId}
                tabIndex={roving.tabIndexFor(i)}
                unblocks={row.unblocks}
                inCycle={row.node?.inCycle ?? false}
                onSelect={onSelectBead}
                onFocus={() => roving.setActiveIndex(i)}
              />
            ))
          )}
        </section>

        {lane.blocked.length > 0 && (
          <section className="ready-lane-group" aria-labelledby="ready-lane-blocked-heading">
            <h3 className="ready-lane-group-header" id="ready-lane-blocked-heading">
              Blocked
              <span className="ready-lane-group-count">{lane.blocked.length}</span>
            </h3>
            {lane.degraded && (
              <p className="ready-lane-degraded">
                Blocked may over-report: this <code>bd</code> build cannot list gate and infra
                beads, so a blocker outside the payload counts as open.
              </p>
            )}
            {lane.blocked.map((row: BlockedRow<Bead>, i) => {
              const index = lane.ready.length + i;
              return (
                <Row
                  key={row.bead.id}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  bead={row.bead}
                  selected={row.bead.id === selectedId}
                  tabIndex={roving.tabIndexFor(index)}
                  chain={row.chain}
                  inCycle={row.node?.inCycle ?? false}
                  unknownBlockers={[...row.chain.head, ...row.chain.tail].filter(
                    (id) => !knownIds.has(id)
                  )}
                  onSelect={onSelectBead}
                  onFocus={() => roving.setActiveIndex(index)}
                />
              );
            })}
          </section>
        )}
      </>
    );
  };

  return (
    <div
      className="ready-lane"
      ref={laneRef}
      role="listbox"
      aria-label="Ready work"
      onKeyDown={(event) => roving.onKeyDown(event)}
    >
      {body()}
    </div>
  );
}

/**
 * The honest and common case: everything is blocked.
 *
 * "No ready work" with no way forward is a dead end, so the lane names the bead
 * gating the most work and offers it as the next action.
 */
function EmptyReady({
  topBlocker,
  onSelectBead,
}: {
  topBlocker: ReturnType<typeof buildReadyLane<Bead>>["topBlocker"];
  onSelectBead: (beadId: string) => void;
}): React.ReactElement {
  if (!topBlocker) {
    return (
      <div className="ready-lane-empty">
        <p className="ready-lane-empty-line">Nothing is ready to pick up.</p>
        <p className="ready-lane-empty-hint">
          No open bead is waiting on a blocker either - the open work is all in progress or
          deferred.
        </p>
      </div>
    );
  }

  const title = topBlocker.bead?.title;
  return (
    <div className="ready-lane-empty">
      <p className="ready-lane-empty-line">
        Nothing is ready. <strong>{topBlocker.id}</strong> gates {topBlocker.unblocks}{" "}
        {topBlocker.unblocks === 1 ? "bead" : "beads"} - more than any other blocker.
      </p>
      {title && <p className="ready-lane-empty-hint">{title}</p>}
      <button
        type="button"
        className="ready-lane-action"
        onClick={() => onSelectBead(topBlocker.id)}
      >
        Open {topBlocker.id}
      </button>
    </div>
  );
}
