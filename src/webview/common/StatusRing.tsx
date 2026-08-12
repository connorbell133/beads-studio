/**
 * StatusRing Component
 *
 * Linear-style status glyph: the geometry says where the work stands — dashed
 * ring = open, half-disc = in progress, ring with a core = blocked, filled
 * check = closed, hollow ring = anything else — and the hue is the status
 * colour. The name lives in the hover title and the aria-label.
 */

import React from "react";
import { STATUS_COLORS, STATUS_LABELS, UNKNOWN_STATUS_COLOR } from "../types";

/** Check/urgent strokes cut out of the glyph in the surface's own colour. */
const SURFACE = "var(--vscode-sideBar-background, var(--vscode-editor-background))";

interface StatusRingProps {
  status: string;
  size?: number;
}

export function StatusRing({ status, size = 14 }: StatusRingProps): React.ReactElement {
  const color = STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? UNKNOWN_STATUS_COLOR;
  const label = STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status;
  return (
    <span className="status-ring" title={label} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
        {glyph(status, color)}
      </svg>
    </span>
  );
}

function glyph(status: string, color: string): React.ReactElement {
  switch (status) {
    case "open":
      return (
        <circle
          cx="7"
          cy="7"
          r="5.25"
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeDasharray="2.2 1.7"
          strokeLinecap="round"
        />
      );
    case "in_progress":
      return (
        <>
          <circle cx="7" cy="7" r="5.25" fill="none" stroke={color} strokeWidth="1.5" />
          <path d="M7 3.75 A3.25 3.25 0 0 1 7 10.25 Z" fill={color} />
        </>
      );
    case "blocked":
      return (
        <>
          <circle cx="7" cy="7" r="5.25" fill="none" stroke={color} strokeWidth="1.5" />
          <circle cx="7" cy="7" r="2.1" fill={color} />
        </>
      );
    case "closed":
      return (
        <>
          <circle cx="7" cy="7" r="6" fill={color} />
          <path
            d="M4.2 7.3 L6.2 9.2 L9.8 5.1"
            fill="none"
            stroke={SURFACE}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    default:
      return <circle cx="7" cy="7" r="5.25" fill="none" stroke={color} strokeWidth="1.5" />;
  }
}
