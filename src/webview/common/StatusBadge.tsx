/**
 * StatusBadge Component
 *
 * A hue dot plus a label. The dot carries the hue at the 3:1 graphic bar, the
 * label reads in the editor's own foreground at full contrast, and the status
 * is never signalled by colour alone.
 *
 * This replaces a filled pill with white text, which put 11px labels on
 * saturated backgrounds - `open` measured 2.54:1 against a white editor.
 */

import React from "react";
import { BeadStatus, STATUS_LABELS, statusHue } from "../types";

interface StatusBadgeProps {
  status: BeadStatus;
  size?: "small" | "medium" | "large";
}

export function StatusBadge({
  status,
  size = "medium",
}: StatusBadgeProps): React.ReactElement {
  const label = STATUS_LABELS[status] || status;

  return (
    <span className={`status-badge status-badge-${size}`} title={label}>
      <span
        className="status-dot"
        style={{ backgroundColor: statusHue(status) }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
