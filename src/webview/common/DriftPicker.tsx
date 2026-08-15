/**
 * DriftPicker - choosing the moment the graph is compared against.
 *
 * The whole point of the drift lens is answering "does Monday's roadmap still
 * exist", and nobody knows Monday's Dolt commit hash. So the picker leads with
 * durations - since yesterday, last week - and keeps the raw commit list below
 * them for the case where a specific point matters.
 *
 * A duration is not a ref. `bd diff` takes commit hashes and branch names only;
 * it rejects dates and relative refs outright. The extension resolves a
 * duration to a real commit and sends its timestamp back, which is why the
 * trigger reads "Since yesterday · 14 Aug 10:11" rather than only the label the
 * user pressed: the moment being drawn is a fact about the history, not about
 * the phrase.
 */

import React from "react";
import { DRIFT_PRESETS } from "../../graph/drift";
import type { DriftReport, DriftRefOption } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";

export interface DriftChoice {
  presetId?: string;
  commit?: string;
}

export interface DriftPickerProps {
  /** The running comparison, or null when none is set. */
  drift: DriftReport | null;
  pending: boolean;
  /** Commits on offer. Empty until the extension answers `onOpen`. */
  refs: DriftRefOption[];
  onChange: (choice: DriftChoice) => void;
  /** Asked once per open, so the commit listing is not read on every graph poll. */
  onOpen: () => void;
}

/** Dolt hashes are 32 characters of noise; eight distinguishes them fine. */
function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** "14 Aug 10:11" - enough to place a commit in the week without a full ISO string. */
export function formatCommitMoment(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DriftPicker({
  drift,
  pending,
  refs,
  onChange,
  onOpen,
}: DriftPickerProps): React.ReactElement {
  const moment = formatCommitMoment(drift?.fromAt);
  const label = pending
    ? "Reading history…"
    : drift
      ? `${drift.fromLabel}${moment ? ` · ${moment}` : ""}`
      : "Compare against…";

  return (
    <Dropdown
      className="graph-canvas-drift-picker"
      triggerClassName="graph-canvas-drift-trigger"
      title="Choose the point in history the graph is compared against"
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
      trigger={<span className="graph-canvas-drift-label">{label}</span>}
    >
      {DRIFT_PRESETS.map((preset) => (
        <DropdownItem
          key={preset.id}
          active={drift?.fromLabel.startsWith(preset.label) ?? false}
          onClick={() => onChange({ presetId: preset.id })}
          title={`Compare the graph against ${preset.label.toLowerCase()}`}
        >
          <span className="graph-canvas-drift-option">{preset.label}</span>
        </DropdownItem>
      ))}

      {drift && (
        <DropdownItem
          onClick={() => onChange({})}
          title="Stop comparing and go back to the plain graph"
        >
          <span className="graph-canvas-drift-option">Clear comparison</span>
        </DropdownItem>
      )}

      {/* The exact-commit list. Below the durations because it is the rarer
          need, and named by moment first because a hash alone tells nobody
          which commit they are choosing. */}
      {refs.length > 0 && (
        <p className="graph-canvas-drift-heading">Or a specific commit</p>
      )}
      {refs.map((ref) => (
        <DropdownItem
          key={ref.hash}
          active={drift?.fromRef === ref.hash}
          onClick={() => onChange({ commit: ref.hash })}
          title={ref.hash}
        >
          <span className="graph-canvas-drift-option">{formatCommitMoment(ref.at)}</span>
          <span className="graph-canvas-drift-hash">{shortHash(ref.hash)}</span>
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
