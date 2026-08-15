/**
 * EstimateBadge
 *
 * The summed estimate across everything inside a container. bd has recorded
 * `estimated_minutes` per bead since long before this extension existed and no
 * surface ever added two of them together; this is that sum, wearing the same
 * pill shape as the dependency chips beside it.
 *
 * A partial sum is marked, not rounded off. When only eleven of twenty members
 * carry an estimate, the badge reads `11h+` and says so on hover - a floor
 * presented as a total is the single most common way an estimate starts lying,
 * and the coverage is already in the data.
 *
 * Deliberately not a forecast. There is no velocity here, no burn-down, and no
 * date: minutes recorded is a fact, minutes remaining by Friday is a guess.
 */

import React from "react";
import { TreeEstimate } from "../../graph/tree";
import { Icon } from "./Icon";

interface EstimateBadgeProps {
  estimate: TreeEstimate;
  className?: string;
}

export function EstimateBadge({ estimate, className }: EstimateBadgeProps): React.ReactElement {
  const coverage = estimate.partial
    ? `${estimate.counted} of ${estimate.total} members estimated, so this is a floor`
    : `all ${estimate.total} ${estimate.total === 1 ? "member" : "members"} estimated`;
  const text = estimate.partial ? `${estimate.label}+` : estimate.label;

  return (
    <span
      className={`lin-chip lin-chip-estimate${estimate.partial ? " partial" : ""}${
        className ? ` ${className}` : ""
      }`}
      title={`Estimated ${estimate.label} of work inside — ${coverage}`}
      role="img"
      aria-label={`Estimated ${estimate.label} of work inside, ${coverage}`}
    >
      <Icon name="clock" size={9} />
      {text}
    </span>
  );
}
