/**
 * Minutes, written the way a person reads them.
 *
 * bd records estimates in minutes and nothing else, so every surface that shows
 * one has to make the same choice about how to print it. This is that choice,
 * made once: hours only when there are hours, minutes only when there are
 * minutes, and never a leading `0h`.
 *
 * Pure and free of any React or vscode import, so both the graph layer and the
 * views can call it and jest can test it.
 */

const MINUTES_PER_HOUR = 60;

export function formatMinutes(minutes: number): string {
  // Negative or non-finite input is bad data, not a duration. Say so rather
  // than printing "-1h -30m" as though it meant something.
  if (!Number.isFinite(minutes) || minutes < 0) return "—";

  const whole = Math.round(minutes);
  if (whole === 0) return "0m";

  const hours = Math.floor(whole / MINUTES_PER_HOUR);
  const rest = whole % MINUTES_PER_HOUR;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
