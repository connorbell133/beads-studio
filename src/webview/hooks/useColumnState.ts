import { useState, useEffect, useMemo, useRef } from "react";
import {
  SortingState,
  VisibilityState,
  ColumnOrderState,
  ColumnFiltersState,
  ExpandedState,
} from "@tanstack/react-table";
import { vscode } from "../types";
import { restoreFilterState } from "./filter-state";

/**
 * Persisted column state for TanStack Table.
 */
export interface ColumnState {
  sorting: SortingState;
  columnVisibility: VisibilityState;
  columnOrder: ColumnOrderState;
}

interface PersistedState {
  sorting?: SortingState;
  columnVisibility?: VisibilityState;
  columnOrder?: ColumnOrderState;
  viewMode?: string;
  /**
   * Filters persist for the same reason sorting does: a manual refresh clears
   * the bead list, which drops the panel to <Loading /> and unmounts the view.
   * Anything held in plain useState dies there, so hand-picked filters vanished
   * on every Refresh while sorting - already persisted - survived.
   */
  columnFilters?: ColumnFiltersState;
  globalFilter?: string;
  /** Kept beside columnFilters; the two describe one selection and must agree. */
  activePreset?: string;
  /**
   * Expanded rows, keyed by project. Tree shape is per-project, so one shared
   * blob would restore one project's expansion onto another's rows.
   */
  expandedByProject?: Record<string, ExpandedState>;
}

interface UseColumnStateOptions {
  /** Default sorting if none persisted */
  defaultSorting?: SortingState;
  /** Default column visibility if none persisted */
  defaultVisibility?: VisibilityState;
  /** Default column order if none persisted */
  defaultOrder?: ColumnOrderState;
  /** Default view mode if none persisted */
  defaultViewMode?: string;
  /** Accepted view modes; a persisted mode outside this set falls back. */
  viewModes?: readonly string[];
  /** Namespaces the expanded rows. Empty until the first beads arrive. */
  projectKey?: string;
  /** Default column filters if none persisted */
  defaultColumnFilters?: ColumnFiltersState;
  /** Default preset id if none persisted */
  defaultActivePreset?: string;
}

interface UseColumnStateReturn {
  sorting: SortingState;
  setSorting: React.Dispatch<React.SetStateAction<SortingState>>;
  columnVisibility: VisibilityState;
  setColumnVisibility: React.Dispatch<React.SetStateAction<VisibilityState>>;
  columnOrder: ColumnOrderState;
  setColumnOrder: React.Dispatch<React.SetStateAction<ColumnOrderState>>;
  /** Which surface the panel is showing - table, tree, board. */
  viewMode: string;
  setViewMode: React.Dispatch<React.SetStateAction<string>>;
  /** Expanded tree rows for the current project. */
  expanded: ExpandedState;
  setExpanded: React.Dispatch<React.SetStateAction<ExpandedState>>;
  /** Hand-picked column filters, surviving refresh and reload. */
  columnFilters: ColumnFiltersState;
  setColumnFilters: React.Dispatch<React.SetStateAction<ColumnFiltersState>>;
  /** Free-text search across the list. */
  globalFilter: string;
  setGlobalFilter: React.Dispatch<React.SetStateAction<string>>;
  /** Which status preset the filters came from; "" once hand-edited. */
  activePreset: string;
  setActivePreset: React.Dispatch<React.SetStateAction<string>>;
  /** Reset visibility to defaults */
  resetVisibility: () => void;
}

/**
 * Hook to manage TanStack Table column state with VS Code webview persistence.
 *
 * - Loads saved state from vscode.getState() on mount
 * - Merges with defaults for new columns
 * - Saves to vscode.setState() on changes
 *
 * View mode and expanded rows live here too, so tree mode is not re-navigated
 * every reload: the mode is global to the panel, expansion is per project.
 *
 * @example
 * const {
 *   sorting, setSorting,
 *   columnVisibility, setColumnVisibility,
 *   columnOrder, setColumnOrder,
 *   viewMode, setViewMode,
 *   expanded, setExpanded,
 *   resetVisibility,
 * } = useColumnState({
 *   defaultSorting: [{ id: "updatedAt", desc: true }],
 *   defaultVisibility: { labels: false, assignee: false },
 *   defaultViewMode: "table",
 *   viewModes: ["table", "tree", "board"],
 *   projectKey,
 * });
 */
export function useColumnState(options: UseColumnStateOptions = {}): UseColumnStateReturn {
  const {
    defaultSorting = [],
    defaultVisibility = {},
    defaultOrder = [],
    defaultViewMode = "",
    viewModes,
    projectKey = "",
    defaultColumnFilters = [],
    defaultActivePreset = "",
  } = options;

  // Load persisted state once on mount
  const savedState = useMemo(() => vscode.getState() as PersistedState | undefined, []);

  const [sorting, setSorting] = useState<SortingState>(
    savedState?.sorting ?? defaultSorting
  );

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    savedState?.columnVisibility ?? defaultVisibility
  );

  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(
    savedState?.columnOrder ?? defaultOrder
  );

  const restoredFilters = useMemo(
    () =>
      restoreFilterState(savedState, {
        columnFilters: defaultColumnFilters,
        activePreset: defaultActivePreset,
      }),
    // Mount-only, matching savedState: later default changes must not stomp
    // filters the user has since edited.
    []
  );

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    restoredFilters.columnFilters
  );
  const [activePreset, setActivePreset] = useState<string>(restoredFilters.activePreset);

  const [globalFilter, setGlobalFilter] = useState<string>(
    savedState?.globalFilter ?? ""
  );

  const [viewMode, setViewMode] = useState<string>(() => {
    const saved = savedState?.viewMode;
    // A mode that no longer exists would render nothing at all, so an unknown
    // value falls back rather than being trusted.
    if (saved && (!viewModes || viewModes.includes(saved))) return saved;
    return defaultViewMode;
  });

  // Expansion is per project, so it is held as a map and the visible slice is
  // swapped when the active project changes.
  const expandedByProject = useRef<Record<string, ExpandedState>>(
    savedState?.expandedByProject ?? {}
  );
  const [expanded, setExpanded] = useState<ExpandedState>(
    () => expandedByProject.current[projectKey] ?? {}
  );

  // Swapped during render rather than in an effect: an effect would let one
  // commit pair the new project with the old project's expanded rows, and that
  // pair is what gets written back to storage.
  const [loadedProject, setLoadedProject] = useState(projectKey);
  if (loadedProject !== projectKey) {
    setLoadedProject(projectKey);
    setExpanded(expandedByProject.current[projectKey] ?? {});
  }

  useEffect(() => {
    expandedByProject.current = { ...expandedByProject.current, [projectKey]: expanded };
  }, [projectKey, expanded]);

  // Persist state changes to VS Code. Spreads the loaded state so a key written
  // by something else in this webview is not dropped on the next write.
  useEffect(() => {
    vscode.setState({
      ...savedState,
      sorting,
      columnVisibility,
      columnOrder,
      viewMode,
      columnFilters,
      globalFilter,
      activePreset,
      expandedByProject: expandedByProject.current,
    });
  }, [
    savedState,
    sorting,
    columnVisibility,
    columnOrder,
    viewMode,
    columnFilters,
    globalFilter,
    activePreset,
    expanded,
    projectKey,
  ]);

  const resetVisibility = () => {
    setColumnVisibility(defaultVisibility);
  };

  return {
    sorting,
    setSorting,
    columnVisibility,
    setColumnVisibility,
    columnOrder,
    setColumnOrder,
    viewMode,
    setViewMode,
    expanded,
    setExpanded,
    columnFilters,
    setColumnFilters,
    globalFilter,
    setGlobalFilter,
    activePreset,
    setActivePreset,
    resetVisibility,
  };
}
