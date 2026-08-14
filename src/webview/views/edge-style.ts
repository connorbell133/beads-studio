/**
 * How one edge on the dependency canvas is drawn.
 *
 * Pure and separately tested, because the canvas has no render test and four
 * overlapping states decide a single line: sequencing vs containment, tangled
 * vs not, met vs still in the way, and in or out of the current focus. Inline
 * ternaries for that got unreadable and untestable at the same moment.
 *
 * The four dash patterns have to stay tellable apart at a glance, so they are
 * fixed here rather than chosen at each call site:
 *
 *   live blocker    solid          this is in your way
 *   satisfied       3 3, faded     this was in your way, and is not now
 *   cycle           5 4            long dashes; bad data, not a state of work
 *   containment     1 4            sparse dots, no arrowhead; membership
 *
 * Opacity, not hue, is what recedes a satisfied edge. It keeps the same neutral
 * stroke as a live one, so the two read as the same kind of thing in different
 * tenses - a second colour would make a met dependency look like a third
 * category of relationship.
 */

import { GRAPHIC_TOKENS } from "../theme/tokens";

/** Which arrowhead a line points at. `null` means it has no head. */
export type EdgeMarker = "arrow" | "arrow-cycle" | "arrow-satisfied";

export interface EdgeStyleInput {
  /** Absent when the layout produced a path with no matching lens edge. */
  kind?: "blocks" | "contains";
  /** The blocker has closed. Ignored for containment, which never satisfies. */
  satisfied?: boolean;
  /** Both endpoints are tangled in a dependency cycle. */
  cycle?: boolean;
  /** Outside the hovered chain or the active find. */
  dimmed?: boolean;
}

export interface EdgeStyle {
  className: string;
  stroke: string;
  strokeWidth: number;
  /** Undefined draws a solid line. */
  strokeDasharray?: string;
  marker: EdgeMarker | null;
}

export function edgeStyle(input: EdgeStyleInput): EdgeStyle {
  const contains = input.kind === "contains";
  // Containment is not sequencing, so it is never tangled and never satisfied.
  const cycle = !contains && Boolean(input.cycle);
  // A cycle outranks satisfaction: bad data the user needs to see beats the
  // quiet treatment that would hide it.
  const satisfied = !contains && !cycle && Boolean(input.satisfied);

  const className = [
    "graph-canvas-edge",
    cycle ? "in-cycle" : "",
    contains ? "contains" : "",
    satisfied ? "satisfied" : "",
    input.dimmed ? "dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    className,
    stroke: cycle ? GRAPHIC_TOKENS.warning : GRAPHIC_TOKENS.neutral,
    strokeWidth: contains ? 1 : 1.25,
    strokeDasharray: cycle ? "5 4" : contains ? "1 4" : satisfied ? "3 3" : undefined,
    marker: contains ? null : cycle ? "arrow-cycle" : satisfied ? "arrow-satisfied" : "arrow",
  };
}
