/**
 * LeverageBadge Component
 *
 * "unblocks N" - how many beads this bead's closure would free, counted
 * transitively. Nothing else in the ecosystem sorts a backlog this way, and it
 * costs nothing once the graph exists.
 *
 * A bead that unblocks nothing renders no badge at all rather than "unblocks
 * 0": the absence is the information, and a column of zeroes would drown the
 * numbers that matter.
 *
 * Two variants because two surfaces want different weight from the same fact.
 * `dot` suits a dense row where a hue pip reads faster than a border; `chip`
 * suits a looser row that needs an outline to hold its own. Both keep the label
 * in the editor foreground - the hue never sits behind the text.
 */

import React from "react";
import { GRAPHIC_TOKENS } from "../theme/tokens";

interface LeverageBadgeProps {
  leverage: number;
  variant?: "dot" | "chip";
}

export function LeverageBadge({
  leverage,
  variant = "chip",
}: LeverageBadgeProps): React.ReactElement | null {
  if (!leverage || leverage <= 0) {
    return null;
  }

  const title = `Closing this unblocks ${leverage} ${leverage === 1 ? "bead" : "beads"}`;

  if (variant === "dot") {
    return (
      <span className="leverage-badge leverage-badge-dot" title={title}>
        <span
          className="leverage-dot"
          style={{ backgroundColor: GRAPHIC_TOKENS.success }}
          aria-hidden="true"
        />
        unblocks {leverage}
      </span>
    );
  }

  return (
    <span className="leverage-badge leverage-badge-chip" title={title}>
      unblocks {leverage}
    </span>
  );
}
