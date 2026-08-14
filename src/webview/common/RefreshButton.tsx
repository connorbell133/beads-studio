/**
 * RefreshButton - "read it again, now".
 *
 * Surfaces that poll still need a manual refresh: the poll answers "is this
 * current?" only on its own schedule, and a user who just ran `bd close` in a
 * terminal wants the answer immediately rather than up to an interval later.
 *
 * The icon spins for a beat even when the read returns instantly, because a
 * refresh that changes nothing visible and shows no motion reads as a dead
 * button. Reduced-motion themes drop the spin globally; the disabled state
 * still marks the work.
 */

import React, { useEffect, useState } from "react";
import { Icon } from "./Icon";

/** Long enough to register as motion, short enough not to gate a second click. */
const MIN_SPIN_MS = 600;

interface RefreshButtonProps {
  onRefresh: () => void;
  /** True while the surface is loading; keeps the icon spinning. */
  busy?: boolean;
  /** Visible text. Omit for an icon-only button. */
  label?: string;
  title?: string;
  className?: string;
}

export function RefreshButton({
  onRefresh,
  busy = false,
  label,
  title = "Refresh",
  className = "",
}: RefreshButtonProps): React.ReactElement {
  // Keyed on a click counter, not on the spinning flag, so a second click while
  // the first spin is still running restarts the beat rather than being eaten.
  const [clicks, setClicks] = useState(0);
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    if (clicks === 0) return;
    setSpinning(true);
    const timer = setTimeout(() => setSpinning(false), MIN_SPIN_MS);
    return () => clearTimeout(timer);
  }, [clicks]);

  const active = spinning || busy;

  return (
    <button
      type="button"
      className={`refresh-button${active ? " spinning" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      aria-label={label ? undefined : title}
      onClick={() => {
        setClicks((count) => count + 1);
        onRefresh();
      }}
    >
      <Icon name="arrows-rotate" size={12} />
      {label && <span className="refresh-button-label">{label}</span>}
    </button>
  );
}
