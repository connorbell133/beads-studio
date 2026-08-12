/**
 * Semantic colour, derived from VS Code's own theme tokens.
 *
 * The palette this replaces was bd's dark-TUI colours applied against every
 * theme. Measured against a white editor background, `pinned` and `hooked` sat
 * at 1.98:1 and `open` at 2.54:1, and six of fourteen type badges fell below AA
 * at the 10-13px they actually render at.
 *
 * The rule here comes from measuring VS Code's own defaults across its four
 * built-in themes (Dark Modern, Light Modern, Dark High Contrast, Light High
 * Contrast):
 *
 *   Text-safe (>= 4.5:1 in all four): foreground, charts.blue, charts.purple,
 *   charts.red.
 *
 *   Graphic-only (>= 3:1 but under 4.5:1 somewhere): charts.green bottoms out
 *   at 4.33:1 on light, charts.yellow at 3.12:1. Fine for a dot, a border, or
 *   an icon; not fine for a label.
 *
 *   Unusable: charts.orange resolves to editor.findMatchHighlightBackground -
 *   #EA5C0055, a 33%-alpha background - and is null in both high-contrast
 *   themes. It never carries meaning here.
 *
 * So hue lives in dots, icons, and borders, and every label reads in a
 * text-safe token. That also satisfies the rule that no state is signalled by
 * colour alone: the dot is reinforcement, the label is the message.
 */

/** Safe for text at any size, in any built-in theme. */
export const TEXT_TOKENS = {
  primary: "var(--vscode-foreground)",
  muted: "var(--vscode-descriptionForeground)",
  danger: "var(--vscode-charts-red)",
  info: "var(--vscode-charts-blue)",
  accent: "var(--vscode-charts-purple)",
} as const;

/** Safe for dots, borders, icons and graph strokes - not for labels. */
export const GRAPHIC_TOKENS = {
  ...TEXT_TOKENS,
  success: "var(--vscode-charts-green)",
  warning: "var(--vscode-charts-yellow)",
  neutral: "var(--vscode-charts-lines)",
} as const;

export type GraphicToken = keyof typeof GRAPHIC_TOKENS;

/**
 * The dot beside a status label.
 *
 * bd's built-in statuses plus whatever a project defines through
 * `bd config set status.custom`, which is why the lookup is open-ended and
 * falls back rather than throwing.
 */
const STATUS_HUE: Record<string, GraphicToken> = {
  open: "success",
  in_progress: "info",
  blocked: "danger",
  deferred: "muted",
  closed: "muted",
  pinned: "accent",
  hooked: "info",
};

export function statusHue(status: string): string {
  return GRAPHIC_TOKENS[STATUS_HUE[status] ?? "neutral"];
}

/**
 * Node hue for graph surfaces, where what matters is the *derived* state.
 *
 * `open` is where raw status lies: an open bead with open blockers is not
 * available, and painting it ready's green tells the user the opposite of what
 * the edges into it say. So on the canvas, green is earned by being unblocked,
 * and an open bead still waiting on its blockers wears warning yellow, the
 * "not yet" of this palette. Keyed on blockage rather than the ready flag,
 * because an unblocked coordination bead is not-ready (it is not work) but is
 * not waiting on anything either. Every other status keeps its badge hue:
 * in_progress is already about what is happening, not what could.
 */
export function readinessHue(status: string, blocked: boolean): string {
  if (status === "open") {
    return blocked ? GRAPHIC_TOKENS.warning : GRAPHIC_TOKENS.success;
  }
  return statusHue(status);
}

/**
 * Hue families for bead types.
 *
 * Six usable hues cannot uniquely encode fourteen types, and pretending
 * otherwise produces colours nobody can tell apart. Type already carries an
 * icon, so hue groups types into families and the icon disambiguates within
 * one. Coordination beads read deliberately quiet - they are infrastructure,
 * not work.
 */
const TYPE_HUE: Record<string, GraphicToken> = {
  // Planning scope
  epic: "accent",
  milestone: "accent",
  story: "accent",
  // Work
  feature: "info",
  task: "info",
  chore: "info",
  spike: "info",
  // Defects
  bug: "danger",
  // Calls to make and integrations
  decision: "warning",
  "merge-request": "warning",
  // Coordination infrastructure
  gate: "neutral",
  agent: "neutral",
  role: "neutral",
  message: "neutral",
  event: "neutral",
  molecule: "neutral",
};

export function typeHue(type: string | undefined): string {
  return GRAPHIC_TOKENS[TYPE_HUE[type ?? ""] ?? "neutral"];
}

/**
 * Priority as weight and colour on the numeral itself.
 *
 * The filled pills this replaces failed AA on four of five levels. Priority is
 * ordinal, not categorical, so hue was the wrong encoding anyway - rank reads
 * as a numeral, and only the top of the scale earns an alert colour.
 */
export interface PriorityStyle {
  color: string;
  fontWeight: number;
}

export function priorityStyle(priority: number | undefined): PriorityStyle {
  switch (priority) {
    case 0:
      return { color: TEXT_TOKENS.danger, fontWeight: 700 };
    case 1:
      return { color: TEXT_TOKENS.primary, fontWeight: 600 };
    case 2:
      return { color: TEXT_TOKENS.primary, fontWeight: 400 };
    default:
      // P3, P4, and anything unset are de-emphasized rather than coloured.
      return { color: TEXT_TOKENS.muted, fontWeight: 400 };
  }
}

/** "P0".."P4", or "P?" when a bead carries no priority at all. */
export function priorityLabel(priority: number | undefined): string {
  return priority === undefined || priority === null ? "P?" : `P${priority}`;
}
