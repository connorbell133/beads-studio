/**
 * PriorityIcon Component
 *
 * Linear-style priority glyph: P0 is a filled urgent block with an
 * exclamation mark, P1–P3 are signal bars with 3/2/1 lit, and P4 or unset is
 * the whole row faint. Hue per level comes from PRIORITY_COLORS; the name
 * lives in the hover title and the aria-label.
 */

import React from "react";
import { BeadPriority, PRIORITY_COLORS, PRIORITY_LABELS } from "../types";

const MUTED = "var(--vscode-descriptionForeground)";
const SURFACE = "var(--vscode-sideBar-background, var(--vscode-editor-background))";

const BARS = [
  { x: 1.5, y: 8, h: 4.5 },
  { x: 5.75, y: 5.5, h: 7 },
  { x: 10, y: 2.5, h: 10 },
];

interface PriorityIconProps {
  priority?: BeadPriority;
  size?: number;
}

export function PriorityIcon({ priority, size = 14 }: PriorityIconProps): React.ReactElement {
  const label =
    priority !== undefined ? `P${priority} ${PRIORITY_LABELS[priority]}` : "no priority";
  return (
    <span className="priority-icon" title={label} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
        {glyph(priority)}
      </svg>
    </span>
  );
}

function glyph(priority?: BeadPriority): React.ReactElement {
  if (priority === 0) {
    return (
      <>
        <rect x="1" y="1" width="12" height="12" rx="3" fill={PRIORITY_COLORS[0]} />
        <rect x="6.25" y="3.25" width="1.5" height="4.75" rx="0.75" fill={SURFACE} />
        <circle cx="7" cy="10.25" r="0.95" fill={SURFACE} />
      </>
    );
  }
  const lit = priority === 1 ? 3 : priority === 2 ? 2 : priority === 3 ? 1 : 0;
  const color = priority !== undefined && priority !== 4 ? PRIORITY_COLORS[priority] : MUTED;
  return (
    <>
      {BARS.map((bar, i) => (
        <rect
          key={i}
          x={bar.x}
          y={bar.y}
          width="2.5"
          height={bar.h}
          rx="1"
          fill={i < lit ? color : MUTED}
          opacity={i < lit ? 1 : 0.35}
        />
      ))}
    </>
  );
}
