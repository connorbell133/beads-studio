/**
 * CriticalPath Component
 *
 * The longest blocker chain inside an epic. "This epic is nine sequential beads
 * deep" is the most actionable planning fact the graph carries: it is the one
 * number that does not improve by adding people.
 *
 * Depth 1 means nothing inside the epic blocks anything else, so the chain is
 * stated rather than drawn - there is no sequence to show.
 */

import React, { useState } from "react";

interface CriticalPathProps {
  depth: number;
  /** Ids along the longest chain, nearest blocker first. Optional. */
  chain?: string[];
  onSelectBead?: (beadId: string) => void;
}

export function CriticalPath({
  depth,
  chain,
  onSelectBead,
}: CriticalPathProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  if (!depth || depth <= 0) {
    return null;
  }

  const expandable = Boolean(chain && chain.length > 0);

  return (
    <span className="critical-path">
      <button
        type="button"
        className="critical-path-summary"
        onClick={() => expandable && setExpanded((v) => !v)}
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
        title={
          depth === 1
            ? "Nothing inside this epic blocks anything else"
            : `Longest chain: ${depth} beads deep`
        }
      >
        {depth === 1 ? "no internal sequence" : `${depth} deep`}
      </button>

      {expanded && chain && (
        <span className="critical-path-chain">
          {chain.map((id, i) => (
            <React.Fragment key={id}>
              {i > 0 && <span className="critical-path-arrow" aria-hidden="true"> → </span>}
              <button
                type="button"
                className="critical-path-link"
                onClick={() => onSelectBead?.(id)}
              >
                {id}
              </button>
            </React.Fragment>
          ))}
        </span>
      )}
    </span>
  );
}
