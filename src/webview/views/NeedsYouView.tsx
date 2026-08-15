/**
 * NeedsYouView
 *
 * The human inbox: everything waiting on a person, most expensive wait first.
 *
 * The ordering is the feature. A chronological inbox asks its reader to answer
 * the oldest question; this one asks them to answer the one holding up the most
 * work for the longest, which is almost never the same question. Every row
 * therefore leads with the two numbers that produced its position - how many
 * beads are frozen behind it, and how long it has been waiting - because a rank
 * whose basis is invisible is a rank nobody trusts.
 *
 * All ordering and cost logic lives in `src/graph/human-inbox.ts`. This file
 * has markup, an open composer, and nothing to decide.
 */

import React, { useMemo, useState } from "react";
import {
  Bead,
  BeadsGraphModel,
  BeadType,
  HumanNeededState,
} from "../types";
import { buildHumanInbox, InboxRow } from "../../graph/human-inbox";
import { ErrorMessage } from "../common/ErrorMessage";
import { Loading } from "../common/Loading";
import { Icon } from "../common/Icon";
import { PriorityIcon } from "../common/PriorityIcon";
import { TypeIcon } from "../common/TypeIcon";
import { Timestamp } from "../common/Timestamp";
import { GRAPHIC_TOKENS } from "../theme/tokens";

interface NeedsYouViewProps {
  beads: Bead[];
  graph: BeadsGraphModel | null;
  humanNeeded: HumanNeededState | null;
  loading: boolean;
  error: string | null;
  selectedBeadId: string | null;
  onSelectBead: (beadId: string) => void;
  onRespond: (beadId: string, text: string) => void;
  onDismiss: (beadId: string, reason?: string) => void;
  onRetry: () => void;
}

/** Which composer, if any, a row has open. Only one row composes at a time. */
type Composer = { beadId: string; mode: "respond" | "dismiss" } | null;

export function NeedsYouView({
  beads,
  graph,
  humanNeeded,
  loading,
  error,
  selectedBeadId,
  onSelectBead,
  onRespond,
  onDismiss,
  onRetry,
}: NeedsYouViewProps): React.ReactElement {
  const [composer, setComposer] = useState<Composer>(null);
  const [draft, setDraft] = useState("");

  // `now` is captured per render rather than ticked on a timer: the wait times
  // shown are hours and days, and a re-render every second to move a "3h" label
  // is cost for no legibility. A refresh re-reads the clock.
  const inbox = useMemo(
    () =>
      buildHumanInbox(graph, beads, {
        now: Date.now(),
        humanIds: humanNeeded?.supported ? humanNeeded.ids : undefined,
      }),
    [graph, beads, humanNeeded]
  );

  const openComposer = (beadId: string, mode: "respond" | "dismiss"): void => {
    setComposer({ beadId, mode });
    setDraft("");
  };

  const closeComposer = (): void => {
    setComposer(null);
    setDraft("");
  };

  const submit = (): void => {
    if (!composer) return;
    const text = draft.trim();
    if (composer.mode === "respond") {
      if (!text) return;
      onRespond(composer.beadId, text);
    } else {
      onDismiss(composer.beadId, text || undefined);
    }
    closeComposer();
  };

  if (error && !loading) {
    return (
      <div className="needs-you">
        <ErrorMessage message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (loading && inbox.rows.length === 0) {
    return <Loading />;
  }

  if (inbox.rows.length === 0) {
    return (
      <div className="needs-you">
        <div className="ready-lane-empty">
          <p className="ready-lane-empty-line">Nothing needs you.</p>
          <p className="ready-lane-empty-hint">
            Beads labelled <code>human</code> and open gates awaiting a manual resolve
            land here, ranked by what the wait is costing.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="needs-you">
      <header className="needs-you-header">
        <h3 className="needs-you-title">
          Needs you <span className="needs-you-count">{inbox.rows.length}</span>
        </h3>
        {inbox.totalFrozen > 0 && (
          <p className="needs-you-subtitle">
            {inbox.totalFrozen} {inbox.totalFrozen === 1 ? "bead is" : "beads are"} frozen
            behind these
          </p>
        )}
      </header>

      {inbox.degraded && (
        <p className="ready-lane-degraded" role="status">
          This bd build has no <code>bd human list</code>, so membership was read from the{" "}
          <code>human</code> label directly. Gates are unaffected.
        </p>
      )}

      <div className="needs-you-rows">
        {inbox.rows.map((row) => (
          <InboxRowView
            key={row.bead.id}
            row={row}
            selected={row.bead.id === selectedBeadId}
            composer={composer?.beadId === row.bead.id ? composer.mode : null}
            draft={draft}
            onDraftChange={setDraft}
            onOpenComposer={openComposer}
            onCloseComposer={closeComposer}
            onSubmit={submit}
            onSelectBead={onSelectBead}
          />
        ))}
      </div>
    </div>
  );
}

function InboxRowView({
  row,
  selected,
  composer,
  draft,
  onDraftChange,
  onOpenComposer,
  onCloseComposer,
  onSubmit,
  onSelectBead,
}: {
  row: InboxRow<Bead>;
  selected: boolean;
  composer: "respond" | "dismiss" | null;
  draft: string;
  onDraftChange: (text: string) => void;
  onOpenComposer: (beadId: string, mode: "respond" | "dismiss") => void;
  onCloseComposer: () => void;
  onSubmit: () => void;
  onSelectBead: (beadId: string) => void;
}): React.ReactElement {
  const { bead, frozen, waitedMs } = row;
  const frozenTitle =
    frozen > 0
      ? `${frozen} open ${frozen === 1 ? "bead is" : "beads are"} frozen behind this: ${row.frozenIds
          .slice(0, 8)
          .join(", ")}${row.frozenIds.length > 8 ? ", …" : ""}`
      : "Nothing is waiting on this one";

  return (
    <div className={`needs-you-row${selected ? " needs-you-row-selected" : ""}`}>
      <div
        className="needs-you-row-main"
        role="button"
        tabIndex={0}
        title={bead.title}
        onClick={() => onSelectBead(bead.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelectBead(bead.id);
          }
        }}
      >
        <PriorityIcon priority={bead.priority} />
        <span className="ready-lane-id">{bead.id}</span>
        <TypeIcon type={(bead.type ?? "task") as BeadType} size={13} />
        <span className="ready-lane-title">{bead.title}</span>
      </div>

      {/* The two numbers that produced this row's rank, in the order they
          multiply. Frozen leads because it is the one a list cannot infer. */}
      <div className="needs-you-metrics">
        <span
          className={`needs-you-frozen${frozen > 0 ? "" : " needs-you-frozen-none"}`}
          title={frozenTitle}
        >
          <span
            className="needs-you-frozen-dot"
            style={{
              backgroundColor: frozen > 0 ? GRAPHIC_TOKENS.warning : GRAPHIC_TOKENS.neutral,
            }}
            aria-hidden="true"
          />
          {frozen} frozen
        </span>
        <span className="needs-you-wait" title={`Waiting since ${waitingSince(bead)}`}>
          waiting {waitedFor(waitedMs)}
        </span>
        {row.source === "gate" && (
          <span className="needs-you-kind" title="A gate: bd will not release the blocked step until this is resolved">
            <Icon name="gate" size={10} />
            gate
          </span>
        )}
        {bead.updatedAt && (
          <span className="needs-you-updated">
            <Timestamp value={bead.updatedAt} format="relative" />
          </span>
        )}
      </div>

      {composer === null ? (
        <div className="needs-you-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onOpenComposer(bead.id, "respond")}
          >
            Respond
          </button>
          <button
            type="button"
            className="btn btn-sm needs-you-dismiss"
            onClick={() => onOpenComposer(bead.id, "dismiss")}
          >
            Dismiss
          </button>
        </div>
      ) : (
        <div className="needs-you-composer">
          <textarea
            className="needs-you-composer-input"
            value={draft}
            autoFocus
            rows={2}
            placeholder={
              composer === "respond"
                ? "Your answer - added as a comment, then the bead closes"
                : "Why this no longer needs an answer (optional)"
            }
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCloseComposer();
              }
              // Both actions close a bead, so neither fires on a bare Enter -
              // a newline in an answer must not be a submit.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className="needs-you-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={composer === "respond" && !draft.trim()}
              onClick={onSubmit}
            >
              {composer === "respond" ? "Send answer" : "Dismiss permanently"}
            </button>
            <button type="button" className="btn btn-sm" onClick={onCloseComposer}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "3d", "5h", "40m" - a duration, not a timestamp. */
function waitedFor(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

function waitingSince(bead: Bead): string {
  const raw = bead.createdAt ?? bead.updatedAt;
  if (!raw) return "an unknown time";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : raw;
}
