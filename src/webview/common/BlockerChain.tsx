/**
 * BlockerChain Component
 *
 * A blocked bead's reason, rendered as a breadcrumb of the beads in its way
 * rather than as a red "blocked" pill. The pill summarized the relationship
 * away; this shows it, and every hop is a link to that bead.
 *
 * Order is nearest blocker first, so the breadcrumb reads outward from the bead
 * and ends on the root cause. When the chain is longer than the display cap the
 * middle elides, and the count of what was dropped is shown rather than
 * silently swallowed - a shortened chain that does not say it was shortened is
 * a wrong number.
 *
 * Hue lives in the separators and nowhere else here: every id reads in a
 * text-safe token.
 */

import React from "react";
import type { BlockerChain as BlockerChainModel } from "../../graph/readyLane";
import { GRAPHIC_TOKENS } from "../theme/tokens";

interface BlockerChainProps {
  chain: BlockerChainModel;
  /** Opens the hop's details. Every blocker in the chain is navigable. */
  onSelectBlocker: (beadId: string) => void;
  /** Ids the payload never contained, so nothing more is known about them. */
  unknownIds?: readonly string[];
}

/** Points from the bead toward its blockers, which is how the chain reads. */
function Separator(): React.ReactElement {
  return (
    <span
      className="blocker-chain-sep"
      style={{ color: GRAPHIC_TOKENS.neutral }}
      aria-hidden="true"
    >
      ‹
    </span>
  );
}

export function BlockerChain({
  chain,
  onSelectBlocker,
  unknownIds = [],
}: BlockerChainProps): React.ReactElement | null {
  if (chain.total === 0) return null;

  const unknown = new Set(unknownIds);

  // Staggered so chain depth is felt as well as read. Capped at six steps so a
  // long chain does not take a second to finish arriving; reduced-motion
  // collapses the whole thing to an instant state change.
  const hop = (id: string, step: number): React.ReactElement => (
    <button
      key={id}
      type="button"
      className={`blocker-chain-hop${unknown.has(id) ? " blocker-chain-hop-unknown" : ""}`}
      style={{ animationDelay: `${Math.min(step, 5) * 40}ms` }}
      title={unknown.has(id) ? `${id} - not in this project's payload` : `Open ${id}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelectBlocker(id);
      }}
    >
      {id}
    </button>
  );

  const tailStep = chain.head.length + (chain.hiddenCount > 0 ? 1 : 0);
  const label = chain.total === 1 ? "Blocked on 1 bead" : `Blocked on ${chain.total} beads`;

  return (
    <div className="blocker-chain" aria-label={label}>
      <span className="blocker-chain-label">Blocked on</span>
      {chain.head.map((id, i) => (
        <React.Fragment key={id}>
          {i > 0 && <Separator />}
          {hop(id, i)}
        </React.Fragment>
      ))}
      {chain.hiddenCount > 0 && (
        <>
          <Separator />
          <span
            className="blocker-chain-hidden"
            title={`${chain.hiddenCount} more blockers hidden between these`}
          >
            +{chain.hiddenCount} more
          </span>
        </>
      )}
      {chain.tail.map((id, i) => (
        <React.Fragment key={id}>
          <Separator />
          {hop(id, tailStep + i)}
        </React.Fragment>
      ))}
    </div>
  );
}
