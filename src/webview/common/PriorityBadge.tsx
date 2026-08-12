/**
 * PriorityBadge Component
 *
 * Priority is ordinal, not categorical, so it reads as a numeral with weight
 * rather than a coloured pill. The pills this replaces failed AA on four of
 * five levels - P1 measured 2.39:1 and P3 2.97:1 with their declared text
 * colours, at 11px.
 *
 * Only the top of the scale earns an alert colour; the rest lean on weight and
 * de-emphasis, so rank survives a greyscale render.
 */

import React from "react";
import { BeadPriority, PRIORITY_LABELS, priorityLabel, priorityStyle } from "../types";

interface PriorityBadgeProps {
  priority: BeadPriority | undefined;
  size?: "small" | "medium" | "large";
}

export function PriorityBadge({
  priority,
  size = "medium",
}: PriorityBadgeProps): React.ReactElement {
  const style = priorityStyle(priority);
  const name = priority !== undefined ? PRIORITY_LABELS[priority] : "unset";

  return (
    <span
      className={`priority-badge priority-badge-${size}`}
      style={{ color: style.color, fontWeight: style.fontWeight }}
      title={`Priority: ${name}`}
    >
      {priorityLabel(priority)}
    </span>
  );
}
