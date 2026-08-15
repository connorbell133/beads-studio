/**
 * PlanNodeRow - one issue being composed: title, type, priority.
 *
 * The epic and every task are the same three fields, so they are the same
 * component; only what surrounds a row (blockers, a remove button) differs, and
 * that arrives as children.
 *
 * Type and priority go through ColoredSelect rather than a native <select>, so
 * the composer looks like the rest of the extension in every VS Code theme.
 */

import React, { ReactNode } from "react";
import {
  BeadPriority,
  BeadType,
  PRIORITY_COLORS,
  TYPE_COLORS,
  TYPE_LABELS,
  getTypeSortOrder,
} from "../types";
import { ColoredSelect, ColoredSelectOption } from "./ColoredSelect";
import { PriorityBadge } from "./PriorityBadge";
import { TypeBadge } from "./TypeBadge";

const TYPE_OPTIONS: ColoredSelectOption<BeadType>[] = (Object.keys(TYPE_LABELS) as BeadType[])
  .sort((a, b) => getTypeSortOrder(a) - getTypeSortOrder(b))
  .map((type) => ({ value: type, label: TYPE_LABELS[type], color: TYPE_COLORS[type] }));

const PRIORITY_OPTIONS: ColoredSelectOption<BeadPriority>[] = (
  [0, 1, 2, 3, 4] as BeadPriority[]
).map((priority) => ({
  value: priority,
  label: `P${priority}`,
  color: PRIORITY_COLORS[priority],
}));

interface PlanNodeRowProps {
  title: string;
  type: string;
  priority: number;
  placeholder: string;
  /** Labels the title field for screen readers; the row has no visible label. */
  titleLabel: string;
  /** Focuses the title field on mount - used for a freshly added task. */
  autoFocus?: boolean;
  invalid?: boolean;
  onTitleChange: (title: string) => void;
  onTypeChange: (type: string) => void;
  onPriorityChange: (priority: number) => void;
  /** Trailing controls: blockers, a remove button, whatever the row needs. */
  children?: ReactNode;
}

export function PlanNodeRow({
  title,
  type,
  priority,
  placeholder,
  titleLabel,
  autoFocus,
  invalid,
  onTitleChange,
  onTypeChange,
  onPriorityChange,
  children,
}: PlanNodeRowProps): React.ReactElement {
  return (
    <div className={`plan-node-row${invalid ? " invalid" : ""}`}>
      <input
        type="text"
        className="text-input plan-node-title"
        value={title}
        placeholder={placeholder}
        aria-label={titleLabel}
        autoFocus={autoFocus}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <ColoredSelect
        value={type as BeadType}
        options={TYPE_OPTIONS}
        onChange={(next) => onTypeChange(next)}
        renderTrigger={(option) => <TypeBadge type={option.value} size="small" />}
      />
      <ColoredSelect
        value={priority as BeadPriority}
        options={PRIORITY_OPTIONS}
        onChange={(next) => onPriorityChange(next)}
        renderTrigger={(option) => <PriorityBadge priority={option.value} size="small" />}
      />
      {children}
    </div>
  );
}
