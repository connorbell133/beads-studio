/**
 * Roving tabindex for a linear collection.
 *
 * A list of 200 beads should be one tab stop, not 200. Inside it, arrow keys
 * move - which is how VS Code's own trees and lists behave, so the interaction
 * is already learned. Exactly one item carries tabIndex 0 at a time; the rest
 * are -1 and unreachable by Tab.
 *
 * Pure state: the hook computes the next index from a key, and the caller
 * applies it. That keeps the navigation logic testable without a DOM.
 */

import { useCallback, useEffect, useState } from "react";

/** The keys this hook understands. Anything else leaves focus where it is. */
export type RovingKey =
  | "ArrowDown"
  | "ArrowUp"
  | "Home"
  | "End"
  | (string & Record<never, never>);

export interface RovingFocusState {
  /** Index of the item that owns the tab stop. -1 when the collection is empty. */
  activeIndex: number;
  /** tabIndex to spread onto item `index`. */
  tabIndexFor: (index: number) => 0 | -1;
  /** Handles a keydown; returns true when it moved focus and was consumed. */
  onKeyDown: (event: {
    key: string;
    preventDefault: () => void;
  }) => boolean;
  setActiveIndex: (index: number) => void;
}

/**
 * Resolves a key press to the next active index.
 *
 * Wrapping is deliberate: a long backlog is faster to reach the end of by
 * pressing Up once than by holding Down. Typeahead matches VS Code's tree,
 * where typing jumps to the next item starting with that character.
 */
export function nextIndexForKey(
  key: string,
  current: number,
  count: number,
  labels?: string[]
): number | null {
  if (count === 0) return null;

  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      break;
  }

  // Single printable character: jump to the next label starting with it,
  // searching forward from the current item and wrapping.
  if (labels && key.length === 1 && key.trim().length === 1) {
    const needle = key.toLowerCase();
    for (let offset = 1; offset <= count; offset++) {
      const candidate = (current + offset) % count;
      if ((labels[candidate] ?? "").toLowerCase().startsWith(needle)) {
        return candidate;
      }
    }
  }

  return null;
}

export function useRovingFocus(count: number, labels?: string[]): RovingFocusState {
  const [activeIndex, setActiveIndex] = useState(count > 0 ? 0 : -1);

  // Keep the tab stop on a real item as the collection changes. Losing focus to
  // the document when the focused row is filtered away is a common way for
  // keyboard users to get stranded mid-list.
  useEffect(() => {
    setActiveIndex((current) => {
      if (count === 0) return -1;
      if (current < 0) return 0;
      return Math.min(current, count - 1);
    });
  }, [count]);

  const onKeyDown = useCallback(
    (event: { key: string; preventDefault: () => void }): boolean => {
      const next = nextIndexForKey(event.key, activeIndex < 0 ? 0 : activeIndex, count, labels);
      if (next === null) return false;
      event.preventDefault();
      setActiveIndex(next);
      return true;
    },
    [activeIndex, count, labels]
  );

  const tabIndexFor = useCallback(
    (index: number): 0 | -1 => (index === activeIndex ? 0 : -1),
    [activeIndex]
  );

  return { activeIndex, tabIndexFor, onKeyDown, setActiveIndex };
}
