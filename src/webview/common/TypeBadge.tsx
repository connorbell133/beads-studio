/**
 * TypeBadge Component
 *
 * An outlined chip: the hue lives in the border and a leading dot, the label
 * reads in the editor foreground. Six usable hues cannot uniquely encode
 * fourteen bead types, so hue groups them into families and the label (or the
 * TypeIcon beside it) disambiguates.
 *
 * Replaces a filled badge with fixed text colours, where six of fourteen types
 * fell below AA at their rendered size - `molecule` measured 2.49:1.
 */

import React from "react";
import { TYPE_LABELS, typeHue } from "../types";

interface TypeBadgeProps {
  type: string;
  size?: "small" | "medium" | "large";
}

export function TypeBadge({
  type,
  size = "medium",
}: TypeBadgeProps): React.ReactElement {
  const label = TYPE_LABELS[type as keyof typeof TYPE_LABELS] || type;
  const hue = typeHue(type);

  return (
    <span
      className={`type-badge type-badge-${size}`}
      style={{ borderColor: hue }}
      title={`Type: ${label}`}
    >
      <span className="type-dot" style={{ backgroundColor: hue }} aria-hidden="true" />
      {label}
    </span>
  );
}
