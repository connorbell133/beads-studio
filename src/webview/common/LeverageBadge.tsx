/**
 * LeverageBadge Component
 *
 * "unblocks N" - how many beads this bead's closure would free, counted
 * transitively. Nothing else in the ecosystem sorts a backlog this way, and it
 * costs nothing once the graph exists.
 *
 * A bead that unblocks nothing renders no badge at all rather than "unblocks
 * 0": the absence is the information, and a row of zeroes would drown the
 * numbers that matter.
 */

import React from "react";

interface LeverageBadgeProps {
  leverage: number;
  size?: "small" | "medium";
}

export function LeverageBadge({
  leverage,
  size = "medium",
}: LeverageBadgeProps): React.ReactElement | null {
  if (!leverage || leverage <= 0) {
    return null;
  }

  return (
    <span
      className={`leverage-badge leverage-badge-${size}`}
      title={`Closing this unblocks ${leverage} ${leverage === 1 ? "bead" : "beads"}`}
    >
      unblocks {leverage}
    </span>
  );
}
