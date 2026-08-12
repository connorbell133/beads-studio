/**
 * StatusPriorityPill Component
 *
 * Status and priority together, used in dependency lists where space is tight.
 * Follows the same rule as the standalone badges: hue in the dot, rank in the
 * numeral, label text at full editor contrast.
 */

import React from "react";
import {
  BeadStatus,
  BeadPriority,
  STATUS_LABELS,
  priorityLabel,
  priorityStyle,
  statusHue,
} from "../types";

interface StatusPriorityPillProps {
  status?: BeadStatus;
  priority?: BeadPriority;
}

export function StatusPriorityPill({
  status,
  priority,
}: StatusPriorityPillProps): React.ReactElement | null {
  // Need at least one value to render
  if (!status && priority === undefined) return null;

  // Custom statuses have no label entry; fall back to the raw text.
  const statusLabel = status ? (STATUS_LABELS[status] ?? status) : null;
  const rank = priorityStyle(priority);

  return (
    <span className="status-priority-pill">
      {status && (
        <span className="pill-status">
          <span
            className="status-dot"
            style={{ backgroundColor: statusHue(status) }}
            aria-hidden="true"
          />
          {statusLabel}
        </span>
      )}
      <span
        className="pill-priority"
        style={{ color: rank.color, fontWeight: rank.fontWeight }}
      >
        {priorityLabel(priority)}
      </span>
    </span>
  );
}
