/**
 * BeadFilterBar - the filter row, extracted so every surface that filters
 * beads (the Issues list, the dependency graph) offers the same controls:
 * a status preset dropdown, chips for hand-picked filters, a "+ Filter" menu
 * with faceted counts, and Clear. State lives in the host as a BeadFilters
 * value; this component only renders and edits it. Filtering itself is
 * beadMatchesFilters, so a filter means the same thing on every surface.
 */

import React, { useMemo, useRef, useState } from "react";
import {
  Bead,
  BeadPriority,
  BeadStatus,
  BeadType,
  PRIORITY_COLORS,
  STATUS_COLORS,
  STATUS_LABELS,
  TYPE_COLORS,
  TYPE_LABELS,
  TYPE_SORT_ORDER,
  UNKNOWN_STATUS_COLOR,
  getTypeSortOrder,
  sortLabels,
} from "../types";
import {
  BeadFilters,
  FILTER_PRESETS,
  UNASSIGNED,
  UNLABELED,
  beadMatchesFilters,
  defaultBeadFilters,
  presetStatuses,
} from "./filter-presets";
import { Dropdown, DropdownItem } from "./Dropdown";
import { FilterChip } from "./FilterChip";
import { StatusBadge } from "./StatusBadge";
import { PriorityBadge } from "./PriorityBadge";
import { TypeBadge } from "./TypeBadge";
import { LabelBadge } from "./LabelBadge";
import { AutocompleteInput, AutocompleteOption } from "./AutocompleteInput";
import { getLabelColorStyle } from "../utils/label-colors";
import { useClickOutside } from "../hooks/useClickOutside";

const ISSUE_TYPES = Object.keys(TYPE_SORT_ORDER).sort(
  (a, b) => getTypeSortOrder(a) - getTypeSortOrder(b)
);

const PRIORITIES: readonly BeadPriority[] = [0, 1, 2, 3, 4];

interface BeadFilterBarProps {
  /** The unfiltered set; facet counts are computed from it. */
  beads: Bead[];
  filters: BeadFilters;
  onChange: (filters: BeadFilters) => void;
}

/** Do the hand-picked filters (beyond the preset) have anything in them? */
export function hasCustomFilters(filters: BeadFilters): boolean {
  return (
    (filters.presetId === "" && filters.statuses.length > 0) ||
    filters.priorities.length > 0 ||
    filters.types.length > 0 ||
    filters.assignees.length > 0 ||
    filters.labels.length > 0
  );
}

export function BeadFilterBar({
  beads,
  filters,
  onChange,
}: BeadFilterBarProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef, () => setMenuOpen(null), !!menuOpen);

  // Counts per dimension, each judged against every OTHER dimension's filter,
  // so a menu says how many beads picking that value would actually show.
  const facets = useMemo(() => {
    const status = new Map<string, number>();
    const priority = new Map<BeadPriority, number>();
    const type = new Map<string, number>();
    const assignee = new Map<string, number>();
    const label = new Map<string, number>();
    let unassigned = 0;
    let unlabeled = 0;
    const except = (dim: keyof BeadFilters): BeadFilters =>
      ({ ...filters, [dim]: [] }) as BeadFilters;
    const forStatus = except("statuses");
    const forPriority = except("priorities");
    const forType = except("types");
    const forAssignee = except("assignees");
    const forLabel = except("labels");
    for (const bead of beads) {
      if (beadMatchesFilters(bead, forStatus)) {
        status.set(bead.status, (status.get(bead.status) ?? 0) + 1);
      }
      if (bead.priority !== undefined && beadMatchesFilters(bead, forPriority)) {
        priority.set(bead.priority, (priority.get(bead.priority) ?? 0) + 1);
      }
      if (bead.type && beadMatchesFilters(bead, forType)) {
        type.set(bead.type, (type.get(bead.type) ?? 0) + 1);
      }
      if (beadMatchesFilters(bead, forAssignee)) {
        if (bead.assignee) assignee.set(bead.assignee, (assignee.get(bead.assignee) ?? 0) + 1);
        else unassigned++;
      }
      if (beadMatchesFilters(bead, forLabel)) {
        if (bead.labels && bead.labels.length > 0) {
          for (const l of bead.labels) label.set(l, (label.get(l) ?? 0) + 1);
        } else {
          unlabeled++;
        }
      }
    }
    return { status, priority, type, assignee, label, unassigned, unlabeled };
  }, [beads, filters]);

  // Custom statuses live in the data, not the built-in list; offer both.
  const statusChoices = useMemo(() => {
    const known = Object.keys(STATUS_LABELS);
    const seen = new Set(known);
    for (const s of facets.status.keys()) {
      if (!seen.has(s)) {
        seen.add(s);
        known.push(s);
      }
    }
    return known;
  }, [facets.status]);

  const toggleInto = (dim: keyof BeadFilters, value: string | BeadPriority) => {
    const list = filters[dim] as (string | BeadPriority)[];
    const next = list.includes(value) ? list : [...list, value];
    const patch: Partial<BeadFilters> = { [dim]: next };
    // Touching statuses by hand dissolves the preset into a custom pick.
    if (dim === "statuses") patch.presetId = "";
    onChange({ ...filters, ...patch });
    setMenuOpen(null);
  };

  const removeFrom = (dim: keyof BeadFilters, value: string | BeadPriority) => {
    const list = filters[dim] as (string | BeadPriority)[];
    const patch: Partial<BeadFilters> = { [dim]: list.filter((v) => v !== value) };
    if (dim === "statuses") patch.presetId = "";
    onChange({ ...filters, ...patch });
  };

  const labelOptions = useMemo(() => {
    const options: AutocompleteOption[] = [];
    if (!filters.labels.includes(UNLABELED) && facets.unlabeled > 0) {
      options.push({ value: UNLABELED, label: "Unlabeled", count: facets.unlabeled });
    }
    for (const label of sortLabels([...facets.label.keys()])) {
      if (filters.labels.includes(label)) continue;
      const count = facets.label.get(label) ?? 0;
      options.push({
        value: label,
        label,
        count,
        render: () => (
          <>
            <LabelBadge label={label} />
            <span className="autocomplete-option-count">({count})</span>
          </>
        ),
      });
    }
    return options;
  }, [facets, filters.labels]);

  const assigneeChoices = useMemo(
    () => [...facets.assignee.keys()].sort(),
    [facets.assignee]
  );

  return (
    <div className="filter-bar bead-filter-bar">
      <Dropdown
        className="preset-dropdown"
        triggerClassName="preset-dropdown-btn"
        menuClassName="preset-dropdown-menu"
        title="Filter beads by status"
        trigger={FILTER_PRESETS.find((p) => p.id === filters.presetId)?.label ?? "Custom"}
      >
        {FILTER_PRESETS.map((preset) => (
          <DropdownItem
            key={preset.id}
            className="preset-option"
            active={preset.id === filters.presetId}
            onClick={() =>
              onChange({ ...filters, presetId: preset.id, statuses: presetStatuses(preset.id) })
            }
          >
            {preset.label}
          </DropdownItem>
        ))}
      </Dropdown>

      {/* Chips: only what the user placed by hand. A preset speaks through
          its dropdown, not as a row of chips. */}
      {filters.presetId === "" &&
        filters.statuses.map((status) => (
          <FilterChip
            key={`status-${status}`}
            label={STATUS_LABELS[status] ?? status}
            accentColor={STATUS_COLORS[status] ?? UNKNOWN_STATUS_COLOR}
            onRemove={() => removeFrom("statuses", status)}
          />
        ))}
      {filters.priorities.map((priority) => (
        <FilterChip
          key={`priority-${priority}`}
          label={`p${priority}`}
          accentColor={PRIORITY_COLORS[priority]}
          onRemove={() => removeFrom("priorities", priority)}
        />
      ))}
      {filters.types.map((type) => (
        <FilterChip
          key={`type-${type}`}
          label={TYPE_LABELS[type as BeadType] || type}
          accentColor={TYPE_COLORS[type as BeadType]}
          onRemove={() => removeFrom("types", type)}
        />
      ))}
      {filters.assignees.map((assignee) => (
        <FilterChip
          key={`assignee-${assignee}`}
          label={assignee === UNASSIGNED ? "Unassigned" : assignee}
          accentColor={UNKNOWN_STATUS_COLOR}
          onRemove={() => removeFrom("assignees", assignee)}
        />
      ))}
      {filters.labels.map((label) => (
        <FilterChip
          key={`label-${label}`}
          label={label === UNLABELED ? "Unlabeled" : label}
          accentColor={
            label === UNLABELED ? UNKNOWN_STATUS_COLOR : getLabelColorStyle(label).backgroundColor
          }
          onRemove={() => removeFrom("labels", label)}
        />
      ))}

      <div className="filter-add-wrapper" ref={menuRef}>
        <button
          className="filter-add-btn"
          onClick={() => setMenuOpen(menuOpen === "main" ? null : "main")}
        >
          + Filter
        </button>

        {menuOpen === "main" && (
          <div className="filter-menu">
            <button onClick={() => setMenuOpen("status")}>
              Status <span className="menu-chevron">›</span>
            </button>
            <button onClick={() => setMenuOpen("priority")}>
              Priority <span className="menu-chevron">›</span>
            </button>
            <button onClick={() => setMenuOpen("type")}>
              Type <span className="menu-chevron">›</span>
            </button>
            <button onClick={() => setMenuOpen("assignee")}>
              Assignee <span className="menu-chevron">›</span>
            </button>
            <button onClick={() => setMenuOpen("label")}>
              Label <span className="menu-chevron">›</span>
            </button>
          </div>
        )}

        {menuOpen === "status" && (
          <div className="filter-menu">
            {statusChoices
              .filter((s) => !(filters.presetId === "" && filters.statuses.includes(s as BeadStatus)))
              .map((status) => (
                <button key={status} onClick={() => toggleInto("statuses", status)}>
                  <StatusBadge status={status as BeadStatus} size="small" />
                  <span className="facet-count">({facets.status.get(status) ?? 0})</span>
                </button>
              ))}
            <button className="back-btn" onClick={() => setMenuOpen("main")}>
              ← Back
            </button>
          </div>
        )}

        {menuOpen === "priority" && (
          <div className="filter-menu">
            {PRIORITIES.filter((p) => !filters.priorities.includes(p)).map((priority) => (
              <button key={priority} onClick={() => toggleInto("priorities", priority)}>
                <PriorityBadge priority={priority} size="small" />
                <span className="facet-count">({facets.priority.get(priority) ?? 0})</span>
              </button>
            ))}
            <button className="back-btn" onClick={() => setMenuOpen("main")}>
              ← Back
            </button>
          </div>
        )}

        {menuOpen === "type" && (
          <div className="filter-menu">
            {ISSUE_TYPES.filter((t) => !filters.types.includes(t)).map((type) => (
              <button key={type} onClick={() => toggleInto("types", type)}>
                <TypeBadge type={type as BeadType} size="small" />
                <span className="facet-count">({facets.type.get(type) ?? 0})</span>
              </button>
            ))}
            <button className="back-btn" onClick={() => setMenuOpen("main")}>
              ← Back
            </button>
          </div>
        )}

        {menuOpen === "assignee" && (
          <div className="filter-menu">
            {!filters.assignees.includes(UNASSIGNED) && facets.unassigned > 0 && (
              <button onClick={() => toggleInto("assignees", UNASSIGNED)}>
                Unassigned
                <span className="facet-count">({facets.unassigned})</span>
              </button>
            )}
            {assigneeChoices
              .filter((a) => !filters.assignees.includes(a))
              .map((assignee) => (
                <button key={assignee} onClick={() => toggleInto("assignees", assignee)}>
                  {assignee}
                  <span className="facet-count">({facets.assignee.get(assignee) ?? 0})</span>
                </button>
              ))}
            {assigneeChoices.length === 0 && facets.unassigned === 0 && (
              <span className="filter-menu-empty">No assignees</span>
            )}
            <button className="back-btn" onClick={() => setMenuOpen("main")}>
              ← Back
            </button>
          </div>
        )}

        {menuOpen === "label" && (
          <div className="filter-menu filter-menu-label">
            <AutocompleteInput
              placeholder="Search labels..."
              options={labelOptions}
              onSelect={(value) => toggleInto("labels", value)}
              autoFocus
              showAllOnFocus
            />
            <button className="back-btn" onClick={() => setMenuOpen("main")}>
              ← Back
            </button>
          </div>
        )}
      </div>

      {hasCustomFilters(filters) && (
        <button className="filter-reset" onClick={() => onChange(defaultBeadFilters("all"))}>
          Clear
        </button>
      )}
    </div>
  );
}
