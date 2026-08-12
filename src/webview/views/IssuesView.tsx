/**
 * IssuesView
 *
 * Main table/list view for issues using TanStack Table v8.
 * Features:
 * - Multi-column sorting (shift+click for secondary sort)
 * - Column resizing
 * - Column reordering (drag & drop)
 * - Faceted filtering with counts
 * - Column visibility toggle
 * - State persistence (sort order, column visibility, column order survive reloads)
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getExpandedRowModel,
  flexRender,
  createColumnHelper,
  ColumnFiltersState,
  ColumnResizeMode,
  ColumnSizingState,
  Row,
} from "@tanstack/react-table";
import {
  Bead,
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
  sortLabels,
  vscode,
} from "../types";
import { buildTree, projectKeyFor, TreeBead, TreeRollup } from "../../graph/tree";
import { GRAPHIC_TOKENS } from "../theme/tokens";
import { StatusBadge } from "../common/StatusBadge";
import { PriorityBadge } from "../common/PriorityBadge";
import { TypeBadge } from "../common/TypeBadge";
import { TypeIcon } from "../common/TypeIcon";
import { LabelBadge } from "../common/LabelBadge";
import { FilterChip } from "../common/FilterChip";
import { Table, Kanban, ListTree } from "lucide-react";
import { ErrorMessage } from "../common/ErrorMessage";
import { Loading } from "../common/Loading";
import { Dropdown, DropdownItem } from "../common/Dropdown";
import { Timestamp, timestampSortingFn } from "../common/Timestamp";
import { AutocompleteInput, AutocompleteOption } from "../common/AutocompleteInput";
import { Markdown } from "../common/Markdown";
import { getLabelColorStyle } from "../utils/label-colors";
import { useClickOutside } from "../hooks/useClickOutside";
import { useColumnState } from "../hooks/useColumnState";
import { KanbanBoard } from "./KanbanBoard";

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
  tooltipHoverDelay: number; // 0 = disabled
  onSelectBead: (beadId: string) => void;
  onUpdateBead: (beadId: string, updates: Partial<Bead>) => void;
  onRetry: () => void;
}

type ViewMode = "table" | "tree" | "board";

const VIEW_MODES: readonly ViewMode[] = ["table", "tree", "board"];

/** Indent per tree level, in px. Depth reads as distance, not only as a line. */
const TREE_INDENT = 14;

/** Stable empty data so the tree tables do not rebuild their row model in list mode. */
const EMPTY_ROWS: Bead[] = [];

/** Reserved key for the orphans lane inside the persisted expanded record. */
const ORPHAN_LANE_KEY = "__orphans__";

/**
 * Collapsed points right, expanded points down - the tree convention VS Code's
 * own explorer uses. The shared ChevronIcon only does the dropdown flip.
 */
function TreeChevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      className="tree-chevron"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ transform: open ? "none" : "rotate(-90deg)" }}
    >
      <path fill="currentColor" d="M4.5 5.5L8 9l3.5-3.5L13 7l-5 5-5-5z" />
    </svg>
  );
}

/**
 * Child completion as a partly-filled bar plus its fraction.
 *
 * An unfinished epic is what a planner scans for, and a bar is read faster than
 * a parsed fraction - but the fraction stays visible so completion is never
 * carried by colour alone.
 */
function RollupBar({ rollup }: { rollup: TreeRollup }): React.ReactElement {
  return (
    <span className="tree-rollup" title={`${rollup.label} children closed`}>
      <span className="tree-rollup-track">
        <span
          className="tree-rollup-fill"
          // The hue arrives as a custom property rather than as a background, so
          // a forced-colors theme can still take the fill over.
          style={
            {
              width: `${rollup.percent}%`,
              "--tree-rollup-hue": GRAPHIC_TOKENS.success,
            } as React.CSSProperties
          }
        />
      </span>
      <span className="tree-rollup-label">{rollup.label}</span>
    </span>
  );
}

// Issue types sorted by TYPE_SORT_ORDER (epic first)
const ISSUE_TYPES = Object.keys(TYPE_SORT_ORDER).sort(
  (a, b) => getTypeSortOrder(a) - getTypeSortOrder(b)
);

// Custom sorting function for type columns (epic first)
const typeSortingFn = (rowA: { getValue: (id: string) => unknown }, rowB: { getValue: (id: string) => unknown }) => {
  const a = getTypeSortOrder(rowA.getValue("type") as string | undefined);
  const b = getTypeSortOrder(rowB.getValue("type") as string | undefined);
  return a - b;
};

// Filter presets
interface FilterPreset {
  id: string;
  label: string;
  statuses: BeadStatus[];
}

const FILTER_PRESETS: FilterPreset[] = [
  { id: "all", label: "All", statuses: [] },
  { id: "not-closed", label: "Not Closed", statuses: ["open", "in_progress", "blocked", "deferred", "pinned", "hooked"] },
  { id: "active", label: "Active", statuses: ["in_progress", "blocked", "hooked"] },
  { id: "blocked", label: "Blocked", statuses: ["blocked"] },
  { id: "closed", label: "Closed", statuses: ["closed"] },
];

const DEFAULT_PRESET_ID = "not-closed";

const presetStatuses = (id: string): BeadStatus[] =>
  FILTER_PRESETS.find((p) => p.id === id)?.statuses ?? [];

const columnHelper = createColumnHelper<Bead>();

export function IssuesView({
  beads,
  graph,
  loading,
  error,
  selectedBeadId,
  tooltipHoverDelay,
  onSelectBead,
  onUpdateBead,
  onRetry,
}: IssuesViewProps): React.ReactElement {
  // Persisted column state (sorting, visibility, order, view mode, expansion)
  const defaultVisibility = {
    labels: false,
    assignee: false,
    estimate: false,
  };
  // The webview is not told the project id, so the bead-id prefix stands in for
  // it. Tree expansion is a per-project fact and must not cross over.
  const projectKey = useMemo(() => projectKeyFor(beads), [beads]);
  const {
    sorting,
    setSorting,
    columnVisibility,
    setColumnVisibility,
    columnOrder,
    setColumnOrder,
    viewMode: persistedViewMode,
    setViewMode,
    expanded,
    setExpanded,
    resetVisibility,
  } = useColumnState({
    defaultSorting: [{ id: "updatedAt", desc: true }],
    defaultVisibility,
    defaultViewMode: "table",
    viewModes: VIEW_MODES,
    projectKey,
  });

  // Non-persisted TanStack state
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([
    // Derived from the preset so the two cannot drift. A hardcoded list here
    // silently hid deferred/pinned/hooked beads while the UI showed the
    // "Not Closed" preset as active.
    { id: "status", value: presetStatuses(DEFAULT_PRESET_ID) },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  // Shared across the list and tree tables so a column keeps its width when the
  // mode is toggled.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});

  // UI state
  // Tree mode needs the graph. Without one the persisted mode falls back rather
  // than rendering an empty hierarchy.
  const viewMode: ViewMode =
    persistedViewMode === "tree" && !graph ? "table" : (persistedViewMode as ViewMode);
  const isTree = viewMode === "tree";
  // The lane's open state rides along in the expanded record so it persists per
  // project with everything else. TanStack only reads keys that are row ids, so
  // a reserved one is inert there.
  const expandedRows = expanded === true ? {} : expanded;
  const orphansOpen = !!globalFilter || expandedRows[ORPHAN_LANE_KEY] === true;
  const toggleOrphans = () =>
    setExpanded((prev) => {
      const rows = prev === true ? {} : prev;
      return { ...rows, [ORPHAN_LANE_KEY]: !rows[ORPHAN_LANE_KEY] };
    });
  const [activePreset, setActivePreset] = useState<string>(DEFAULT_PRESET_ID);
  const [filterBarOpen, setFilterBarOpen] = useState(true);
  const [filterMenuOpen, setFilterMenuOpen] = useState<string | null>(null);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const columnMenuRef = useRef<HTMLTableCellElement>(null);

  // Tooltip state
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get hovered bead content for tooltip
  const hoveredBead = useMemo(() => {
    if (!hoveredRowId) return null;
    return beads.find((b) => b.id === hoveredRowId);
  }, [hoveredRowId, beads]);

  const handleRowMouseEnter = useCallback((e: React.MouseEvent<HTMLTableRowElement>, beadId: string) => {
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
  useClickOutside(columnMenuRef, () => setColumnMenuOpen(false), columnMenuOpen);

  // Column definitions
  const columns = useMemo(
    () => [
      columnHelper.accessor("type", {
        id: "icon",
        header: "",
        size: 28,
        minSize: 28,
        maxSize: 28,
        enableResizing: false,
        cell: (info) =>
          info.getValue() ? (
            <TypeIcon type={info.getValue() as BeadType} size={16} />
          ) : null,
        sortingFn: typeSortingFn,
      }),
      columnHelper.accessor("type", {
        header: "Type",
        size: 70,
        minSize: 30,
        cell: (info) =>
          info.getValue() ? (
            <TypeBadge type={info.getValue() as BeadType} size="small" />
          ) : null,
        sortingFn: typeSortingFn,
        filterFn: (row, columnId, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as string | undefined;
          return val !== undefined && filterValue.includes(val);
        },
      }),
      columnHelper.accessor("title", {
        header: "Title",
        size: 200,
        minSize: 100,
        cell: (info) => {
          const bead = info.row.original as TreeBead<Bead>;
          const label = (
            <>
              <span
                className={`bead-id ${copiedId === bead.id ? "copied" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyId(bead.id);
                  onSelectBead(bead.id);
                }}
                title={copiedId === bead.id ? "Copied!" : "Click to copy"}
              >
                {bead.id}
              </span>
              <span className="bead-title">{info.getValue()}</span>
            </>
          );

          // List mode rows carry none of these, so they render exactly the
          // markup they always did - no wrapper, no reflow.
          const depth = info.row.depth;
          const canExpand = info.row.getCanExpand();
          if (!canExpand && depth === 0 && !bead.treeRollup && !bead.treeContext) {
            return label;
          }

          const isExpanded = info.row.getIsExpanded();
          return (
            <span
              className={`tree-cell${bead.treeContext ? " tree-context" : ""}`}
              style={{ paddingLeft: depth * TREE_INDENT }}
            >
              {depth > 0 && (
                <span
                  className="tree-rail"
                  aria-hidden="true"
                  style={{ left: (depth - 1) * TREE_INDENT + 6 }}
                />
              )}
              {canExpand ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${bead.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    info.row.toggleExpanded();
                  }}
                >
                  <TreeChevron open={isExpanded} />
                </button>
              ) : (
                <span className="tree-toggle-spacer" aria-hidden="true" />
              )}
              <span className="tree-cell-label">{label}</span>
              {bead.treeCycle && (
                <span className="tree-cycle-flag" title="This bead's parent chain loops back to it">
                  parent loop
                </span>
              )}
              {bead.treeRollup && <RollupBar rollup={bead.treeRollup} />}
            </span>
          );
        },
      }),
      columnHelper.accessor("status", {
        header: "Status",
        size: 80,
        minSize: 30,
        cell: (info) => <StatusBadge status={info.getValue()} size="small" />,
        filterFn: (row, columnId, filterValue: BeadStatus[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          return filterValue.includes(row.getValue(columnId));
        },
      }),
      columnHelper.accessor("priority", {
        header: "Priority",
        size: 70,
        minSize: 30,
        cell: (info) =>
          info.getValue() !== undefined ? (
            <PriorityBadge priority={info.getValue()!} size="small" />
          ) : null,
        filterFn: (row, columnId, filterValue: BeadPriority[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const val = row.getValue(columnId) as BeadPriority | undefined;
          return val !== undefined && filterValue.includes(val);
        },
      }),
      columnHelper.accessor("labels", {
        header: "Labels",
        size: 100,
        minSize: 30,
        enableSorting: false,
        cell: (info) => (
          <>
            {sortLabels(info.getValue()).map((label) => (
              <LabelBadge key={label} label={label} />
            ))}
          </>
        ),
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
        header: "Assignee",
        size: 80,
        minSize: 30,
        cell: (info) => info.getValue() || "-",
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
      columnHelper.accessor("estimatedMinutes", {
        id: "estimate",
        header: "Estimate",
        size: 70,
        minSize: 30,
        cell: (info) => (info.getValue() ? `${info.getValue()}m` : "-"),
      }),
      columnHelper.accessor("updatedAt", {
        header: "Updated",
        size: 80,
        minSize: 30,
        cell: (info) => <Timestamp value={info.getValue()} format="auto" />,
        sortingFn: timestampSortingFn,
      }),
      columnHelper.accessor("createdAt", {
        header: "Created",
        size: 80,
        minSize: 30,
        cell: (info) => <Timestamp value={info.getValue()} format="auto" />,
        sortingFn: timestampSortingFn,
      }),
    ],
    [copiedId]
  );

  const table = useReactTable({
    data: beads,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      columnOrder,
      columnSizing,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
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
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    columnResizeMode: "onChange" as ColumnResizeMode,
    enableColumnResizing: true,
  });

  // The flat table stays the one place filtering, faceting and counting happen.
  // Tree mode reads its match set from it rather than re-deciding the predicate,
  // so the two modes can never disagree about what a filter means.
  const filteredRows = table.getFilteredRowModel().rows;
  const tree = useMemo(() => {
    if (!isTree) return null;
    return buildTree(beads, graph, { matched: filteredRows.map((row) => row.original.id) });
  }, [isTree, beads, graph, filteredRows]);

  const treeShared = {
    columns,
    state: { sorting, columnVisibility, columnOrder, columnSizing },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    // No filtering here: the rows arrive already filtered, with context parents
    // deliberately kept. Filtering again would drop exactly those.
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange" as ColumnResizeMode,
    enableColumnResizing: true,
  };

  const treeTable = useReactTable<Bead>({
    ...treeShared,
    data: tree?.roots ?? EMPTY_ROWS,
    // A search opens the tree: a hit buried under a collapsed epic reads as no
    // hit at all. Clearing the search restores what the user had open.
    state: { ...treeShared.state, expanded: globalFilter ? true : expanded },
    onExpandedChange: setExpanded,
    getSubRows: (row) => (row as TreeBead<Bead>).subRows,
    getExpandedRowModel: getExpandedRowModel(),
  });

  // The orphans lane is its own table so it sorts independently and cannot be
  // mixed back into the hierarchy by a sort. Both render into one <table>, so
  // the columns stay aligned.
  const orphanTable = useReactTable<Bead>({
    ...treeShared,
    data: tree?.orphans ?? EMPTY_ROWS,
  });

  const activeTable = isTree ? treeTable : table;

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
  const columnSpan = activeTable.getVisibleLeafColumns().length + 1;

  // One row renderer for the list, the tree, and the orphans lane, so the three
  // cannot drift in selection, hover, or cell markup.
  const renderRow = (row: Row<Bead>): React.ReactElement => {
    const bead = row.original as TreeBead<Bead>;
    return (
      <tr
        key={row.id}
        onClick={() => onSelectBead(bead.id)}
        className={`bead-row ${bead.id === selectedBeadId ? "selected" : ""}${
          isTree && bead.treeContext ? " tree-context-row" : ""
        }`}
        aria-level={isTree ? row.depth + 1 : undefined}
        onMouseEnter={(e) => handleRowMouseEnter(e, bead.id)}
        onMouseLeave={handleRowMouseLeave}
      >
        {row.getVisibleCells().map((cell) => (
          <td
            key={cell.id}
            className={`${cell.column.id}-cell`}
            style={{ width: cell.column.getSize() }}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        ))}
        <td className="row-spacer" />
      </tr>
    );
  };

  // Get faceted counts for filters (counts based on OTHER active filters, not this column)
  const statusFacets = table.getColumn("status")?.getFacetedUniqueValues() ?? new Map();
  const priorityFacets = table.getColumn("priority")?.getFacetedUniqueValues() ?? new Map();
  const typeFacets = table.getColumn("type")?.getFacetedUniqueValues() ?? new Map();
  const assigneeFacets = table.getColumn("assignee")?.getFacetedUniqueValues() ?? new Map();

  // Unfiltered counts per status (for kanban empty state messaging).
  // Tallies every status present, including custom ones, so board columns for
  // non-built-in statuses still get an accurate "n/N" count.
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
        <button
          className={`filter-toggle ${filterBarOpen || hasActiveFilters ? "active" : ""}`}
          onClick={() => setFilterBarOpen(!filterBarOpen)}
          title="Filter"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6 10.5v-1h4v1H6zm-2-3v-1h8v1H4zm-2-3v-1h12v1H2z" />
          </svg>
        </button>
        <div className="view-toggle">
          <button
            className={viewMode === "table" ? "active" : ""}
            onClick={() => setViewMode("table")}
            title="Table view"
          >
            <Table size={14} />
          </button>
          <button
            className={isTree ? "active" : ""}
            onClick={() => setViewMode("tree")}
            disabled={!graph}
            title={graph ? "Tree view" : "Tree view needs the dependency graph"}
          >
            <ListTree size={14} />
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

      {/* Row 2: Filter bar */}
      {(filterBarOpen || hasActiveFilters) && (
        <div className="filter-bar">
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

          {/* Active filter chips */}
          {statusFilter.map((status) => (
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

          {hasActiveFilters && (
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

      {/* Table - flat list, or the graph-derived tree */}
      {!error && viewMode !== "board" && (
        <div className="beads-table-wrapper">
          {loading && (
            <div className="issues-loading-state">
              <Loading />
            </div>
          )}
          <div className={`beads-table-container ${activeTable.getState().columnSizingInfo.isResizingColumn ? "resizing" : ""}`}>
            <table
              className="beads-table"
              style={{ minWidth: activeTable.getCenterTotalSize() }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <thead>
                {activeTable.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        style={{ width: header.getSize() }}
                        className={`${header.column.getCanSort() ? "sortable" : ""} ${draggedColumn === header.id ? "dragging" : ""} ${dragOverColumn === header.id && draggedColumn !== header.id ? "drag-over" : ""}`}
                        onClick={header.column.getToggleSortingHandler()}
                        draggable={!isResizing}
                        onDragStart={(e) => {
                          if (isResizing) {
                            e.preventDefault();
                            return;
                          }
                          setDraggedColumn(header.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (draggedColumn && draggedColumn !== header.id) {
                            setDragOverColumn(header.id);
                          }
                        }}
                        onDragLeave={() => {
                          setDragOverColumn(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggedColumn && draggedColumn !== header.id) {
                            const currentOrder = activeTable.getAllLeafColumns().map((c) => c.id);
                            const dragIdx = currentOrder.indexOf(draggedColumn);
                            const dropIdx = currentOrder.indexOf(header.id);
                            const newOrder = [...currentOrder];
                            newOrder.splice(dragIdx, 1);
                            newOrder.splice(dropIdx, 0, draggedColumn);
                            setColumnOrder(newOrder);
                          }
                          setDraggedColumn(null);
                          setDragOverColumn(null);
                        }}
                        onDragEnd={() => {
                          setDraggedColumn(null);
                          setDragOverColumn(null);
                        }}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && (
                          <span className="sort-indicator">
                            {header.column.getIsSorted() === "asc" ? "▲" : "▼"}
                          </span>
                        )}
                        <span
                          className="resize-handle"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setIsResizing(true);
                            const resizeHandler = header.getResizeHandler();
                            resizeHandler(e);
                            // Clear resizing state on mouseup
                            const handleMouseUp = () => {
                              setIsResizing(false);
                              document.removeEventListener("mouseup", handleMouseUp);
                            };
                            document.addEventListener("mouseup", handleMouseUp);
                          }}
                          onTouchStart={(e) => {
                            e.stopPropagation();
                            setIsResizing(true);
                            const resizeHandler = header.getResizeHandler();
                            resizeHandler(e);
                            const handleTouchEnd = () => {
                              setIsResizing(false);
                              document.removeEventListener("touchend", handleTouchEnd);
                            };
                            document.addEventListener("touchend", handleTouchEnd);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </th>
                    ))}
                    <th className="col-menu-th" ref={columnMenuRef}>
                      <button
                        className="col-menu-btn"
                        onClick={() => setColumnMenuOpen(!columnMenuOpen)}
                        title="Show/hide columns"
                      >
                        ⋮
                      </button>
                      {columnMenuOpen && (
                        <div className="col-menu">
                          {activeTable.getAllLeafColumns().map((column) => (
                            <label key={column.id}>
                              <input
                                type="checkbox"
                                checked={column.getIsVisible()}
                                onChange={column.getToggleVisibilityHandler()}
                              />
                              {typeof column.columnDef.header === "string"
                                ? column.columnDef.header
                                : column.id}
                            </label>
                          ))}
                          <hr className="col-menu-divider" />
                          <button
                            className="col-menu-reset"
                            onClick={() => {
                              resetVisibility();
                              setColumnMenuOpen(false);
                            }}
                          >
                            Reset to defaults
                          </button>
                        </div>
                      )}
                    </th>
                  </tr>
                ))}
              </thead>
              <tbody>
                {activeTable.getRowModel().rows.length === 0 && (!tree || tree.orphans.length === 0) ? (
                  <tr>
                    <td colSpan={columnSpan} className="empty-row">
                      {loading ? "Loading..." : "No issues matching filter"}
                    </td>
                  </tr>
                ) : (
                  activeTable.getRowModel().rows.map(renderRow)
                )}
              </tbody>
              {/* Orphans lane: parentless, childless work. Empty on a healthy
                  project; when it is not, its size is the finding. */}
              {isTree && tree && tree.orphans.length > 0 && (
                <tbody className="tree-lane">
                  <tr className="tree-lane-header">
                    <td colSpan={columnSpan}>
                      <button
                        type="button"
                        className="tree-lane-toggle"
                        aria-expanded={orphansOpen}
                        onClick={toggleOrphans}
                      >
                        <TreeChevron open={orphansOpen} />
                        <span className="tree-lane-title">Orphans</span>
                        <span className="tree-lane-count">{tree.orphans.length}</span>
                        <span className="tree-lane-hint">no parent epic</span>
                      </button>
                    </td>
                  </tr>
                  {orphansOpen && orphanTable.getRowModel().rows.map(renderRow)}
                </tbody>
              )}
            </table>
          </div>
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
