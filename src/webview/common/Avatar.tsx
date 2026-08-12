/**
 * Avatar Component
 *
 * Initials in a badge-coloured circle; the full name lives in the hover title.
 * Shared by the issues list and the kanban board so an assignee reads the
 * same on both surfaces.
 */

import React from "react";

export function Avatar({ assignee }: { assignee: string }): React.ReactElement {
  const initials = assignee
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="lin-avatar" title={assignee}>
      {initials || "?"}
    </span>
  );
}
