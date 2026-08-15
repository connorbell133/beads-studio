/**
 * IssuesView
 *
 * The Issues surface: a Linear-style list (LinearList) grouped by epic, plus
 * the kanban board. TanStack Table stays underneath purely as the filter,
 * search, and facet engine — presentation belongs to LinearList.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  createColumnHelper,
} from "@tanstack/react-table";
import {
  Bead,
  BeadWriteExpectation,
  BeadsGraphModel,
  BeadStatus,
  BeadPriority,
  BeadType,
  STATUS_LABELS,
  STATUS_COLORS,
  UNKNOWN_STATUS_COLOR,
  PRIORITY_COLORS,
  TYPE_LABELS,
  TYPE_COLORS,
  TYPE_SORT_ORDER,
  getTypeSortOrder,
  vscode,
} from "../types";
import { projectKeyFor } from "../../graph/tree";
import { StatusBadge } from "../common/StatusBadge";
import { PriorityBadge } from "../common/PriorityBadge";
import { TypeBadge } from "../common/TypeBadge";
import { LabelBadge } from "../common/LabelBadge";
import { FilterChip } from "../common/FilterChip";
import { Kanban, List } from "lucide-react";
import { ErrorMessage } from "../common/ErrorMessage";
import { Loading } from "../common/Loading";
import { Dropdown, DropdownItem } from "../common/Dropdown";
import { AutocompleteInput, AutocompleteOption } from "../common/AutocompleteInput";
import { Markdown } from "../common/Markdown";
import { getLabelColorStyle } from "../utils/label-colors";
import { useClickOutside } from "../hooks/useClickOutside";
import { useColumnState } from "../hooks/useColumnState";
import { FILTER_PRESETS, presetStatuses } from "../common/filter-presets";
import { KanbanBoard } from "./KanbanBoard";
import { LinearList } from "./LinearList";

interface IssuesViewProps {
  beads: Bead[];
  /**
   * The derived graph, when the host has sent one. Tree mode reads hierarchy
   * from here rather than hydrating each bead's dependencies; without it the
   * panel stays in flat list mode and the tree toggle is disabled.
   */
  graph?: BeadsGraphModel | null;
  loading: boolean;
  error: string | null;
  selectedBeadId: string | null;
  /** External preset request (dashboard stat strip); a bump re-applies it. */
  presetId?: string | null;
  presetRequests?: number;
  tooltipHoverDelay: number; // 0 = disabled
  /** Bumped when a write was refused; the board drops its optimistic move. */
  writeConflicts?: number;
  onSelectBead: (beadId: string) => void;
  onUpdateBead: (
    beadId: string,
    updates: Partial<Bead>,
    expect?: BeadWriteExpectation
  ) => void;
  onRetry: () => void;
}

type ViewMode = "list" | "board";

const VIEW_MODES: readonly ViewMode[] = ["list", "board"];

// Issue types sorted by TYPE_SORT_ORDER (epic first)
const ISSUE_TYPES = Object.keys(TYPE_SORT_ORDER).sort(
  (a, b) => getTypeSortOrder(a) - getTypeSortOrder(b)
);

const DEFAULT_PRESET_ID = "not-closed";

const columnHelper = createColumnHelper<Bead>();

export function IssuesView({
  beads,
  graph,
  loading,
  error,
  selectedBeadId,
  presetId = null,
  presetRequests = 0,
  tooltipHoverDelay,
  writeConflicts = 0,
  onSelectBead,
  onUpdateBead,
  onRetry,
}: IssuesViewProps): React.ReactElement {
  // The webview is not told the project id, so the bead-id prefix stands in for
  // it. Group expansion is a per-project fact and must not cross over.
  const projectKey = useMemo(() => projectKeyFor(beads), [beads]);
  const {
    viewMode: persistedViewMode,
    setViewMode,
    expanded,
    setExpanded,
    // Persisted, not local: a manual refresh empties the bead list, which drops
    // the panel to <Loading /> and unmounts this view. Local filter state died
    // there on every Refresh (vsbeads-fvl).
    columnFilters,
    setColumnFilters,
    globalFilter,
    setGlobalFilter,
    activePreset,
    setActivePreset,
  } = useColumnState({
    defaultViewMode: "list",
    viewModes: VIEW_MODES,
    projectKey,
    // Derived from the preset so the two cannot drift. A hardcoded list here
    // silently hid deferred/pinned/hooked beads while the UI showed the
    // "Not Closed" preset as active.
    defaultColumnFilters: [{ id: "status", value: presetStatuses(DEFAULT_PRESET_ID) }],
    defaultActivePreset: DEFAULT_PRESET_ID,
  });

  // Live width of the list, so right-side meta hiding tracks the panel as the
  // user drags the sidebar. A callback ref survives the wrapper mounting and
  // unmounting across view-mode switches.
  const [tableWidth, setTableWidth] = useState<number | null>(null);
  const widthObserverRef = useRef<ResizeObserver | null>(null);
  const tableWrapperRef = useCallback((node: HTMLDivElement | null) => {
    widthObserverRef.current?.disconnect();
    widthObserverRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setTableWidth(width);
    });
    observer.observe(node);
    widthObserverRef.current = observer;
  }, []);

  // UI state
  const viewMode = persistedViewMode as ViewMode;
  // Closed until asked for: the preset dropdown lives in the toolbar, so the
  // second row only exists when there are custom chips to show.
  const [filterBarOpen, setFilterBarOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);

  // Tooltip state
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get hovered bead content for tooltip
  const hoveredBead = useMemo(() => {
    if (!hoveredRowId) return null;
    return beads.find((b) => b.id === hoveredRowId);
  }, [hoveredRowId, beads]);

  const handleRowMouseEnter = useCallback((e: React.MouseEvent<HTMLElement>, beadId: string) => {
    // Skip if tooltips are disabled
    if (tooltipHoverDelay === 0) return;

    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const tooltipWidth = 300;
    const tooltipMaxHeight = 200;
    const padding = 8;

    // Position below the row, left-aligned with some offset
    let left = rect.left + 20;
    let top = rect.bottom + padding;

    // Keep tooltip within viewport horizontally
    if (left + tooltipWidth > window.innerWidth - padding) {
      left = window.innerWidth - tooltipWidth - padding;
    }

    // Check if tooltip would overflow below viewport
    const spaceBelow = window.innerHeight - rect.bottom - padding;
    const spaceAbove = rect.top - padding;

    if (spaceBelow < tooltipMaxHeight && spaceAbove > spaceBelow) {
      // Position above the row when there's more space above
      top = rect.top - tooltipMaxHeight - padding;
      // Clamp to viewport top
      if (top < padding) {
        top = padding;
      }
    }

    tooltipTimeoutRef.current = setTimeout(() => {
      setHoveredRowId(beadId);
      setTooltipPosition({ top, left });
    }, tooltipHoverDelay);
  }, [tooltipHoverDelay]);

  const handleRowMouseLeave = useCallback(() => {
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
    setHoveredRowId(null);
    setTooltipPosition(null);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
      }
    };
  }, []);

  // Click outside to close menus
  useClickOutside(filterMenuRef, () => setFilterMenuOpen(null), !!filterMenuOpen);

  // Column definitions. Nothing here renders — LinearList owns presentation —
  // but each filterable field needs a column so filterFns and facet counts
  // keep one source of truth.
  const columns = useMemo(
    () => [
      columnHelper.accessor("type", {
        id: "type",
        filterFn: (row, columnId, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as string | undefined;
          return val !== undefined && filterValue.includes(val);
        },
      }),
      columnHelper.accessor("status", {
        filterFn: (row, columnId, filterValue: BeadStatus[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          return filterValue.includes(row.getValue(columnId));
        },
      }),
      columnHelper.accessor("priority", {
        filterFn: (row, columnId, filterValue: BeadPriority[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as BeadPriority | undefined;
          return val !== undefined && filterValue.includes(val);
        },
      }),
      columnHelper.accessor("labels", {
        filterFn: (row, columnId, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const labels = row.getValue(columnId) as string[] | undefined;
          if (!labels || labels.length === 0) {
            // Special handling for "Unlabeled" filter
            return filterValue.includes("__unlabeled__");
          }
          // Match if any of the issue's labels are in the filter
          return labels.some((label) => filterValue.includes(label));
        },
      }),
      columnHelper.accessor("assignee", {
        filterFn: (row, columnId, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as string | undefined;
          // Special handling for "Unassigned" filter
          if (filterValue.includes("__unassigned__")) {
            if (!val) return true;
          }
          return val !== undefined && filterValue.includes(val);
        },
      }),
    ],
    []
  );

  const table = useReactTable({
    data: beads,
    columns,
    state: {
      columnFilters,
      globalFilter,
    },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const search = filterValue.toLowerCase();
      const bead = row.original;
      return (
        bead.id.toLowerCase().includes(search) ||
        bead.title.toLowerCase().includes(search) ||
        (bead.description?.toLowerCase().includes(search) ?? false) ||
        (bead.labels?.some((l) => l.toLowerCase().includes(search)) ?? false)
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  // The one place filtering, faceting and counting happen. LinearList reads
  // its match set from here rather than re-deciding the predicate, so the
  // list and the counts can never disagree about what a filter means.
  const filteredRows = table.getFilteredRowModel().rows;
  const matched = useMemo(() => filteredRows.map((row) => row.original.id), [filteredRows]);

  const handleCopyId = useCallback((beadId: string) => {
    vscode.postMessage({ type: "copyBeadId", beadId });
    setCopiedId(beadId);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  // Filter helpers
  const statusFilter = (columnFilters.find((f) => f.id === "status")?.value || []) as BeadStatus[];
  const priorityFilter = (columnFilters.find((f) => f.id === "priority")?.value || []) as BeadPriority[];
  const typeFilter = (columnFilters.find((f) => f.id === "type")?.value || []) as string[];
  const assigneeFilter = (columnFilters.find((f) => f.id === "assignee")?.value || []) as string[];
  const labelFilter = (columnFilters.find((f) => f.id === "labels")?.value || []) as string[];
  const hasActiveFilters = statusFilter.length > 0 || priorityFilter.length > 0 || typeFilter.length > 0 || assigneeFilter.length > 0 || labelFilter.length > 0;
  // Filters beyond the preset — the chips the user placed themselves. The
  // preset already reads from its dropdown; re-stating it as six chips cost
  // two rows of panel.
  const hasCustomFilters =
    (activePreset === "" && statusFilter.length > 0) ||
    priorityFilter.length > 0 ||
    typeFilter.length > 0 ||
    assigneeFilter.length > 0 ||
    labelFilter.length > 0;

  const applyPreset = (presetId: string) => {
    const preset = FILTER_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setColumnFilters((prev) =>
        prev
          .filter((f) => f.id !== "status")
          .concat(preset.statuses.length > 0 ? [{ id: "status", value: preset.statuses }] : [])
      );
      setActivePreset(presetId);
    }
  };

  // An external request (the dashboard's stat strip) applies a preset the same
  // way a toolbar click would; the request counter makes repeats re-apply.
  useEffect(() => {
    if (presetRequests > 0 && presetId) applyPreset(presetId);
  }, [presetRequests]);

  const addStatusFilter = (status: BeadStatus) => {
    if (!statusFilter.includes(status)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "status");
        return [...others, { id: "status", value: [...statusFilter, status] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removeStatusFilter = (status: BeadStatus) => {
    const newStatuses = statusFilter.filter((s) => s !== status);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "status");
      return newStatuses.length > 0
        ? [...others, { id: "status", value: newStatuses }]
        : others;
    });
    setActivePreset("");
  };

  const addPriorityFilter = (priority: BeadPriority) => {
    if (!priorityFilter.includes(priority)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "priority");
        return [...others, { id: "priority", value: [...priorityFilter, priority] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const addTypeFilter = (type: string) => {
    if (!typeFilter.includes(type)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "type");
        return [...others, { id: "type", value: [...typeFilter, type] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removePriorityFilter = (priority: BeadPriority) => {
    const newPriorities = priorityFilter.filter((p) => p !== priority);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "priority");
      return newPriorities.length > 0
        ? [...others, { id: "priority", value: newPriorities }]
        : others;
    });
    setActivePreset("");
  };

  const removeTypeFilter = (type: string) => {
    const newTypes = typeFilter.filter((t) => t !== type);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "type");
      return newTypes.length > 0
        ? [...others, { id: "type", value: newTypes }]
        : others;
    });
    setActivePreset("");
  };

  const addAssigneeFilter = (assignee: string) => {
    if (!assigneeFilter.includes(assignee)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "assignee");
        return [...others, { id: "assignee", value: [...assigneeFilter, assignee] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removeAssigneeFilter = (assignee: string) => {
    const newAssignees = assigneeFilter.filter((a) => a !== assignee);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "assignee");
      return newAssignees.length > 0
        ? [...others, { id: "assignee", value: newAssignees }]
        : others;
    });
    setActivePreset("");
  };

  const addLabelFilter = (label: string) => {
    if (!labelFilter.includes(label)) {
      setColumnFilters((prev) => {
        const others = prev.filter((f) => f.id !== "labels");
        return [...others, { id: "labels", value: [...labelFilter, label] }];
      });
      setActivePreset("");
    }
    setFilterMenuOpen(null);
  };

  const removeLabelFilter = (label: string) => {
    const newLabels = labelFilter.filter((l) => l !== label);
    setColumnFilters((prev) => {
      const others = prev.filter((f) => f.id !== "labels");
      return newLabels.length > 0
        ? [...others, { id: "labels", value: newLabels }]
        : others;
    });
    setActivePreset("");
  };

  const clearAllFilters = () => {
    setColumnFilters([]);
    setGlobalFilter("");
    setActivePreset("all");
  };

  const filteredCount = filteredRows.length;
  const totalCount = beads.length;

  // Get faceted counts for filters (counts based on OTHER active filters, not this column)
  const statusFacets = table.getColumn("status")?.getFacetedUniqueValues() ?? new Map();
  const priorityFacets = table.getColumn("priority")?.getFacetedUniqueValues() ?? new Map();
  const typeFacets = table.getColumn("type")?.getFacetedUniqueValues() ?? new Map();
  const assigneeFacets = table.getColumn("assignee")?.getFacetedUniqueValues() ?? new Map();

  // Unfiltered counts per status (for kanban empty-state messaging). Tallies
  // every status present, including custom ones.
  const unfilteredStatusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const bead of beads) {
      counts[bead.status] = (counts[bead.status] ?? 0) + 1;
    }
    return counts;
  }, [beads]);

  // Get unique assignees from facets for filter menu
  const uniqueAssignees = useMemo(() => {
    const assignees = Array.from(assigneeFacets.keys()).filter((a): a is string => typeof a === "string" && a !== "");
    return assignees.sort();
  }, [assigneeFacets]);

  // Count unassigned issues
  const unassignedCount = useMemo(() => {
    // Count null/undefined/empty assignees
    let count = 0;
    for (const [key, value] of assigneeFacets.entries()) {
      if (!key || key === "") {
        count += value;
      }
    }
    return count;
  }, [assigneeFacets]);

  // Get unique labels and counts from filtered rows (labels are arrays, so facets don't work directly)
  const { uniqueLabels, labelCounts, unlabeledCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let unlabeled = 0;
    const filteredRows = table.getFilteredRowModel().rows;
    for (const row of filteredRows) {
      const labels = row.original.labels;
      if (!labels || labels.length === 0) {
        unlabeled++;
      } else {
        for (const label of labels) {
          counts.set(label, (counts.get(label) || 0) + 1);
        }
      }
    }
    const sorted = Array.from(counts.keys()).sort();
    return { uniqueLabels: sorted, labelCounts: counts, unlabeledCount: unlabeled };
  }, [table.getFilteredRowModel().rows]);

  // Build label autocomplete options
  const labelOptions = useMemo((): AutocompleteOption[] => {
    const options: AutocompleteOption[] = [];
    // Add "Unlabeled" option first if available
    if (!labelFilter.includes("__unlabeled__") && unlabeledCount > 0) {
      options.push({
        value: "__unlabeled__",
        label: "Unlabeled",
        count: unlabeledCount,
      });
    }
    // Add all unique labels not already filtered
    for (const label of uniqueLabels) {
      if (!labelFilter.includes(label)) {
        options.push({
          value: label,
          label: label,
          count: labelCounts.get(label) ?? 0,
          render: () => (
            <>
              <LabelBadge label={label} />
              <span className="autocomplete-option-count">({labelCounts.get(label) ?? 0})</span>
            </>
          ),
        });
      }
    }
    return options;
  }, [uniqueLabels, labelCounts, unlabeledCount, labelFilter]);

  return (
    <div className="beads-panel">
      {/* Row 1: search + filter toggle */}
      <div className="panel-toolbar-compact">
        <div className="search-input-wrapper">
          <input
            type="text"
            className="search-input-compact"
            placeholder="Search..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
          />
          {globalFilter && (
            <button
              className="search-clear-btn"
              onClick={() => setGlobalFilter("")}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <Dropdown
          trigger={FILTER_PRESETS.find((p) => p.id === activePreset)?.label || "Custom"}
          className="preset-dropdown"
          triggerClassName="preset-dropdown-btn"
          menuClassName="preset-dropdown-menu"
        >
          {FILTER_PRESETS.map((preset) => (
            <DropdownItem
              key={preset.id}
              className="preset-option"
              active={activePreset === preset.id}
              onClick={() => applyPreset(preset.id)}
            >
              {preset.label}
            </DropdownItem>
          ))}
        </Dropdown>
        <button
          className={`filter-toggle ${filterBarOpen || hasCustomFilters ? "active" : ""}`}
          onClick={() => setFilterBarOpen(!filterBarOpen)}
          title="Filter"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6 10.5v-1h4v1H6zm-2-3v-1h8v1H4zm-2-3v-1h12v1H2z" />
          </svg>
        </button>
        <div className="view-toggle">
          <button
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List size={14} />
          </button>
          <button
            className={viewMode === "board" ? "active" : ""}
            onClick={() => setViewMode("board")}
            title="Board view"
          >
            <Kanban size={14} />
          </button>
        </div>
      </div>

      {/* Row 2: custom filter chips. The preset speaks through its dropdown in
          the toolbar; chips here are only what the user added beyond it. */}
      {(filterBarOpen || hasCustomFilters) && (
        <div className="filter-bar">
          {activePreset === "" &&
            statusFilter.map((status) => (
              <FilterChip
                key={`status-${status}`}
                label={STATUS_LABELS[status] ?? status}
                accentColor={STATUS_COLORS[status] ?? UNKNOWN_STATUS_COLOR}
                onRemove={() => removeStatusFilter(status)}
              />
            ))}
          {priorityFilter.map((priority) => (
            <FilterChip
              key={`priority-${priority}`}
              label={`p${priority}`}
              accentColor={PRIORITY_COLORS[priority]}
              onRemove={() => removePriorityFilter(priority)}
            />
          ))}
          {typeFilter.map((type) => (
            <FilterChip
              key={`type-${type}`}
              label={TYPE_LABELS[type as BeadType] || type}
              accentColor={TYPE_COLORS[type as BeadType]}
              onRemove={() => removeTypeFilter(type)}
            />
          ))}
          {assigneeFilter.map((assignee) => (
            <FilterChip
              key={`assignee-${assignee}`}
              label={assignee === "__unassigned__" ? "Unassigned" : assignee}
              accentColor={UNKNOWN_STATUS_COLOR}
              onRemove={() => removeAssigneeFilter(assignee)}
            />
          ))}
          {labelFilter.map((label) => (
            <FilterChip
              key={`label-${label}`}
              label={label === "__unlabeled__" ? "Unlabeled" : label}
              accentColor={label === "__unlabeled__" ? UNKNOWN_STATUS_COLOR : getLabelColorStyle(label).backgroundColor}
              onRemove={() => removeLabelFilter(label)}
            />
          ))}

          {/* Add filter dropdown with faceted counts */}
          <div className="filter-add-wrapper" ref={filterMenuRef}>
            <button
              className="filter-add-btn"
              onClick={() => setFilterMenuOpen(filterMenuOpen === "main" ? null : "main")}
            >
              + Filter
            </button>

            {filterMenuOpen === "main" && (
              <div className="filter-menu">
                <button onClick={() => setFilterMenuOpen("status")}>Status <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("priority")}>Priority <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("type")}>Type <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("assignee")}>Assignee <span className="menu-chevron">›</span></button>
                <button onClick={() => setFilterMenuOpen("label")}>Label <span className="menu-chevron">›</span></button>
              </div>
            )}

            {filterMenuOpen === "status" && (
              <div className="filter-menu">
                {/* Built-in statuses plus any custom status present in the data */}
                {([
                  ...Object.keys(STATUS_LABELS),
                  ...[...statusFacets.keys()].filter(
                    (s): s is string => typeof s === "string" && !(s in STATUS_LABELS)
                  ),
                ] as BeadStatus[])
                  .filter((s) => !statusFilter.includes(s))
                  .map((status) => {
                    const count = statusFacets.get(status) ?? 0;
                    return (
                      <button key={status} onClick={() => addStatusFilter(status)}>
                        <StatusBadge status={status} size="small" />
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "priority" && (
              <div className="filter-menu">
                {([0, 1, 2, 3, 4] as BeadPriority[])
                  .filter((p) => !priorityFilter.includes(p))
                  .map((priority) => {
                    const count = priorityFacets.get(priority) ?? 0;
                    return (
                      <button key={priority} onClick={() => addPriorityFilter(priority)}>
                        <PriorityBadge priority={priority} size="small" />
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "type" && (
              <div className="filter-menu">
                {ISSUE_TYPES
                  .filter((t) => !typeFilter.includes(t))
                  .map((type) => {
                    const count = typeFacets.get(type) ?? 0;
                    return (
                      <button key={type} onClick={() => addTypeFilter(type)}>
                        <TypeBadge type={type as BeadType} size="small" />
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "assignee" && (
              <div className="filter-menu">
                {!assigneeFilter.includes("__unassigned__") && unassignedCount > 0 && (
                  <button onClick={() => addAssigneeFilter("__unassigned__")}>
                    <span className="assignee-name">Unassigned</span>
                    <span className="facet-count">({unassignedCount})</span>
                  </button>
                )}
                {uniqueAssignees
                  .filter((a) => !assigneeFilter.includes(a))
                  .map((assignee) => {
                    const count = assigneeFacets.get(assignee) ?? 0;
                    return (
                      <button key={assignee} onClick={() => addAssigneeFilter(assignee)}>
                        <span className="assignee-name">{assignee}</span>
                        <span className="facet-count">({count})</span>
                      </button>
                    );
                  })}
                {uniqueAssignees.length === 0 && unassignedCount === 0 && (
                  <span className="filter-menu-empty">No assignees</span>
                )}
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}

            {filterMenuOpen === "label" && (
              <div className="filter-menu filter-menu-label">
                <AutocompleteInput
                  placeholder="Search labels..."
                  options={labelOptions}
                  onSelect={(value) => {
                    addLabelFilter(value);
                    setFilterMenuOpen(null);
                  }}
                  autoFocus
                  showAllOnFocus
                />
                <button className="back-btn" onClick={() => setFilterMenuOpen("main")}>← Back</button>
              </div>
            )}
          </div>

          {hasCustomFilters && (
            <button className="filter-reset" onClick={clearAllFilters}>
              Clear
            </button>
          )}
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <ErrorMessage
          message={error}
          onRetry={onRetry}
        />
      )}

      {/* The Linear-style list, grouped by epic */}
      {!error && viewMode === "list" && (
        <div className="beads-table-wrapper" ref={tableWrapperRef}>
          {loading && (
            <div className="issues-loading-state">
              <Loading />
            </div>
          )}
          <LinearList
            beads={beads}
            graph={graph ?? null}
            matched={matched}
            width={tableWidth}
            selectedBeadId={selectedBeadId}
            copiedId={copiedId}
            expanded={expanded}
            setExpanded={setExpanded}
            forceOpen={!!globalFilter}
            emptyText={loading ? "Loading..." : "No issues matching filter"}
            onSelectBead={onSelectBead}
            onUpdateBead={onUpdateBead}
            onCopyId={handleCopyId}
            onRowMouseEnter={handleRowMouseEnter}
            onRowMouseLeave={handleRowMouseLeave}
          />
          {/* Filtered count overlay */}
          {(hasActiveFilters || globalFilter) && filteredCount !== totalCount && (
            <div className="filter-count-overlay">
              {filteredCount} of {totalCount}
            </div>
          )}
        </div>
      )}

      {/* Kanban Board */}
      {!error && viewMode === "board" && (
        <>
          {loading && (
            <div className="issues-loading-state">
              <Loading />
            </div>
          )}
          <KanbanBoard
            beads={table.getFilteredRowModel().rows.map((r) => r.original)}
            selectedBeadId={selectedBeadId}
            onSelectBead={onSelectBead}
            onUpdateBead={onUpdateBead}
            writeConflicts={writeConflicts}
            hasActiveFilters={hasActiveFilters}
            unfilteredCounts={unfilteredStatusCounts}
          />
        </>
      )}

      {/* Markdown tooltip */}
      {hoveredBead && tooltipPosition && (hoveredBead.description || hoveredBead.title) &&
        createPortal(
          <div
            className="markdown-tooltip"
            style={{
              top: tooltipPosition.top,
              left: tooltipPosition.left,
            }}
          >
            <Markdown
              content={hoveredBead.description || hoveredBead.title}
              className="markdown-tooltip-content"
            />
          </div>,
          document.body
        )}
    </div>
  );
}
