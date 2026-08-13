import { ColumnFiltersState } from "@tanstack/react-table";

/** The filter selection as it is stored and restored - always as a pair. */
export interface FilterState {
  columnFilters: ColumnFiltersState;
  activePreset: string;
}

/**
 * Picks the filter state to start from: what was stored, else the defaults.
 *
 * Filters and preset restore as a pair. A stored `columnFilters` is the record
 * of what the user actually had, so its preset label comes with it - including
 * the empty label that means "hand-picked". Reading the preset independently
 * would let a stored "Not Closed" caption sit above filters the user edited
 * away from it.
 *
 * Lives outside useColumnState so it can be tested: the hook imports `vscode`,
 * which touches `window` at module load, and jest runs this project in a node
 * environment.
 */
export function restoreFilterState(
  saved: Partial<FilterState> | undefined,
  defaults: FilterState
): FilterState {
  if (!saved?.columnFilters) return defaults;
  return {
    columnFilters: saved.columnFilters,
    activePreset: saved.activePreset ?? "",
  };
}
