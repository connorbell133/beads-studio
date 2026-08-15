/**
 * LinearList
 *
 * The Issues list, styled after Linear and mapped to beads-native objects.
 * Rows are [priority | id | status | type | title | dependency chips | meta],
 * grouped under their root parent (the epic) with a sticky, collapsible
 * header. Filtering and facets happen upstream in TanStack state; this
 * renders the buildTree result and nothing else.
 */

import React, { useMemo } from "react";
import { ExpandedState } from "@tanstack/react-table";
import {
  Bead,
  BeadPriority,
  BeadStatus,
  BeadsGraphModel,
  BeadType,
  PRIORITY_LABELS,
  STATUS_LABELS,
  sortLabels,
} from "../types";
import { buildTree, TreeBead, TreeRollup } from "../../graph/tree";
import { partitionBlockers, waitingOnHuman } from "../../graph/human-inbox";
import { GRAPHIC_TOKENS } from "../theme/tokens";
import { Dropdown, DropdownItem } from "../common/Dropdown";
import { Avatar } from "../common/Avatar";
import { LabelBadge } from "../common/LabelBadge";
import { PriorityIcon } from "../common/PriorityIcon";
import { StatusRing } from "../common/StatusRing";
import { Timestamp } from "../common/Timestamp";
import { TypeIcon } from "../common/TypeIcon";

/** Indent per nesting level inside a group, in px. */
const INDENT = 14;

/** Right-side meta enters as the panel affords it, title-first always. */
const SHOW_DATE_AT = 360;
const SHOW_AVATAR_AT = 440;
const SHOW_LABELS_AT = 560;

/** Reserved key for the "No epic" group inside the persisted expanded record. */
const NO_EPIC_KEY = "__orphans__";

const PRIORITIES: readonly BeadPriority[] = [0, 1, 2, 3, 4];

interface LinearListProps {
  beads: Bead[];
  graph: BeadsGraphModel | null;
  /**
   * Ids waiting on a person, computed over the unfiltered bead set upstream.
   *
   * Falls back to what this view can see on its own, which catches human-
   * labelled work beads but not gates - gates never reach here.
   */
  humanWaitingIds?: readonly string[];
  /** Ids that pass the active filters; ancestors outside it render as context. */
  matched: string[];
  /** Live width of the list, for meta hiding. Null until first measure. */
  width: number | null;
  selectedBeadId: string | null;
  copiedId: string | null;
  expanded: ExpandedState;
  setExpanded: React.Dispatch<React.SetStateAction<ExpandedState>>;
  /** A search forces groups open — a hit under a collapsed epic reads as no hit. */
  forceOpen: boolean;
  emptyText: string;
  onSelectBead: (id: string) => void;
  onUpdateBead: (id: string, updates: Partial<Bead>) => void;
  onCopyId: (id: string) => void;
  onRowMouseEnter: (e: React.MouseEvent<HTMLElement>, id: string) => void;
  onRowMouseLeave: () => void;
}

/** All known statuses, plus the bead's own custom value so it stays selectable. */
function statusChoices(current: string): string[] {
  const known = Object.keys(STATUS_LABELS);
  return known.includes(current) ? known : [...known, current];
}

/**
 * Status ring that is itself the picker, Linear-style. The click must not
 * bubble — the row beneath selects the bead. The Dropdown portals its menu,
 * so the list's scroll container cannot clip it.
 */
function StatusSelect({
  status,
  onChange,
}: {
  status: BeadStatus;
  onChange: (status: BeadStatus) => void;
}): React.ReactElement {
  return (
    <span className="lin-select" onClick={(e) => e.stopPropagation()}>
      <Dropdown
        trigger={<StatusRing status={status} />}
        showChevron={false}
        triggerClassName="lin-select-trigger"
        menuClassName="lin-select-menu"
      >
        {statusChoices(status).map((s) => (
          <DropdownItem key={s} active={s === status} onClick={() => onChange(s as BeadStatus)}>
            <StatusRing status={s} />
            {STATUS_LABELS[s] ?? s}
          </DropdownItem>
        ))}
      </Dropdown>
    </span>
  );
}

/** Priority glyph that is itself the picker. */
function PrioritySelect({
  priority,
  onChange,
}: {
  priority?: BeadPriority;
  onChange: (priority: BeadPriority) => void;
}): React.ReactElement {
  return (
    <span className="lin-select" onClick={(e) => e.stopPropagation()}>
      <Dropdown
        trigger={<PriorityIcon priority={priority} />}
        showChevron={false}
        triggerClassName="lin-select-trigger"
        menuClassName="lin-select-menu"
      >
        {PRIORITIES.map((p) => (
          <DropdownItem key={p} active={p === priority} onClick={() => onChange(p)}>
            <PriorityIcon priority={p} />
            {`P${p} ${PRIORITY_LABELS[p]}`}
          </DropdownItem>
        ))}
      </Dropdown>
    </span>
  );
}

/**
 * Child completion as a small ring; the fraction lives in the tooltip and
 * aria-label so the row spends its width on the title.
 */
function RollupRing({ rollup }: { rollup: TreeRollup }): React.ReactElement {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      className="tree-rollup"
      title={`${rollup.label} children closed`}
      role="img"
      aria-label={`${rollup.label} children closed`}
    >
      <svg className="tree-rollup-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle className="tree-rollup-ring-track" cx="7" cy="7" r={radius} />
        <circle
          className="tree-rollup-ring-fill"
          cx="7"
          cy="7"
          r={radius}
          style={{ "--tree-rollup-hue": GRAPHIC_TOKENS.success } as React.CSSProperties}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - rollup.percent / 100)}
          transform="rotate(-90 7 7)"
        />
      </svg>
    </span>
  );
}

/**
 * Dependency count as a Linear-style pill: icon + count, ids in the tooltip.
 *
 * Three kinds, not two. "Blocked by a person" was split out of "blocked by"
 * because the two have opposite implications and had one appearance: a question
 * waiting on a human clears the moment someone answers it, and work waits for
 * however long the work takes. Reading them as the same red pill is what makes
 * a stalled question look like a scheduling problem instead of an inbox item.
 */
function DepChip({
  kind,
  ids,
}: {
  kind: "blockedBy" | "blockedByPerson" | "blocks";
  ids: string[];
}): React.ReactElement {
  const listed = ids.slice(0, 8).join(", ") + (ids.length > 8 ? ", …" : "");
  const title =
    kind === "blockedByPerson"
      ? `Waiting on a person: ${listed}`
      : kind === "blockedBy"
        ? `Blocked by: ${listed}`
        : `Blocking: ${listed}`;
  return (
    <span className={`lin-chip lin-chip-${kind}`} title={title}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {kind === "blockedByPerson" ? (
          // A head and shoulders: someone, not something, is in the way.
          <>
            <circle cx="5" cy="3.1" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M1.6 9 C1.6 6.6 3.1 5.6 5 5.6 C6.9 5.6 8.4 6.6 8.4 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </>
        ) : kind === "blockedBy" ? (
          // A "banned" glyph: ring with the slash — this bead cannot move.
          <>
            <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <line x1="2.2" y1="7.8" x2="7.8" y2="2.2" stroke="currentColor" strokeWidth="1.4" />
          </>
        ) : (
          // An arrow out: other beads wait on this one.
          <path
            d="M1.5 5 H7 M4.8 2.2 L7.8 5 L4.8 7.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      {ids.length}
    </span>
  );
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
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

/** A row with its nesting depth inside the group. */
interface FlatRow {
  bead: TreeBead<Bead>;
  depth: number;
}

function flatten(rows: TreeBead<Bead>[] | undefined, depth: number, out: FlatRow[]): FlatRow[] {
  for (const bead of rows ?? []) {
    out.push({ bead, depth });
    flatten(bead.subRows, depth + 1, out);
  }
  return out;
}

export function LinearList({
  beads,
  graph,
  humanWaitingIds,
  matched,
  width,
  selectedBeadId,
  copiedId,
  expanded,
  setExpanded,
  forceOpen,
  emptyText,
  onSelectBead,
  onUpdateBead,
  onCopyId,
  onRowMouseEnter,
  onRowMouseLeave,
}: LinearListProps): React.ReactElement {
  // An epic heads its own group even with nothing under it yet. Only once the
  // graph is known: without it there is no hierarchy for anything to be the top
  // of, and every bead is already its own root.
  const isEpic = (bead: { type?: string }): boolean => Boolean(graph) && bead.type === "epic";
  const epicIds = useMemo(
    () => beads.filter(isEpic).map((bead) => bead.id),
    [beads, graph]
  );
  const tree = useMemo(
    () => buildTree(beads, graph, { matched, containers: epicIds }),
    [beads, graph, matched, epicIds]
  );

  // Which blockers a person has to clear. Supplied by App when it can see the
  // whole set including gates; derived from what is here otherwise.
  const waiting = useMemo(
    () => (humanWaitingIds ? new Set(humanWaitingIds) : waitingOnHuman(beads)),
    [humanWaitingIds, beads]
  );

  // Who waits on whom, inverted from each node's open blockers. Powers the
  // "blocking N" chip; "blocked by N" reads straight off the node.
  const blocking = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!graph) return map;
    for (const [id, node] of Object.entries(graph.nodes)) {
      for (const blocker of node.blockedBy) {
        const list = map.get(blocker);
        if (list) list.push(id);
        else map.set(blocker, [id]);
      }
    }
    return map;
  }, [graph]);

  // Epics head a group whether or not anything is under them; so does any root
  // with visible children. What is left - non-epic roots with nothing showing,
  // which is the no-graph fallback and roots whose children were all filtered
  // away - joins the orphans under "No epic".
  const groups = useMemo(
    () =>
      tree.roots
        .filter((root) => root.subRows?.length || isEpic(root))
        .sort(
          (a, b) => (a.priority ?? 5) - (b.priority ?? 5) || a.id.localeCompare(b.id)
        ),
    [tree, graph]
  );
  const loose = useMemo(
    () => [
      ...tree.roots.filter((root) => !root.subRows?.length && !isEpic(root)),
      ...tree.orphans,
    ],
    [tree, graph]
  );

  const expandedRows = expanded === true ? {} : expanded;
  // Groups default open, Linear-style: only an explicit collapse closes one.
  const isOpen = (id: string) => forceOpen || expandedRows[id] !== false;
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const rows = prev === true ? {} : prev;
      return { ...rows, [id]: rows[id] === false };
    });

  const showLabels = width === null || width >= SHOW_LABELS_AT;
  const showAvatar = width === null || width >= SHOW_AVATAR_AT;
  const showDate = width === null || width >= SHOW_DATE_AT;

  const renderRow = ({ bead, depth }: FlatRow): React.ReactElement => {
    const node = graph?.nodes[bead.id];
    // Two chips, not one: a blocker that is a question clears itself the moment
    // someone answers, and a blocker that is work waits for the work.
    const { people, work } = partitionBlockers(node?.blockedBy ?? [], waiting);
    const blocks = blocking.get(bead.id) ?? [];
    const labels = showLabels ? sortLabels(bead.labels) : [];
    return (
      <div
        key={bead.id}
        className={`lin-row${bead.id === selectedBeadId ? " selected" : ""}${bead.treeContext ? " lin-context" : ""}`}
        style={depth > 0 ? { paddingLeft: depth * INDENT } : undefined}
        onClick={() => onSelectBead(bead.id)}
        onMouseEnter={(e) => onRowMouseEnter(e, bead.id)}
        onMouseLeave={onRowMouseLeave}
      >
        <PrioritySelect
          priority={bead.priority}
          onChange={(priority) => onUpdateBead(bead.id, { priority })}
        />
        <button
          type="button"
          className={`lin-id${copiedId === bead.id ? " copied" : ""}`}
          title={copiedId === bead.id ? "Copied!" : "Click to copy"}
          onClick={(e) => {
            e.stopPropagation();
            onCopyId(bead.id);
            onSelectBead(bead.id);
          }}
        >
          {bead.id}
        </button>
        <StatusSelect
          status={bead.status}
          onChange={(status) => onUpdateBead(bead.id, { status })}
        />
        {bead.type && <TypeIcon type={bead.type as BeadType} size={14} />}
        <span className="lin-title">{bead.title}</span>
        {people.length > 0 && <DepChip kind="blockedByPerson" ids={people} />}
        {work.length > 0 && <DepChip kind="blockedBy" ids={work} />}
        {blocks.length > 0 && <DepChip kind="blocks" ids={blocks} />}
        {bead.treeRollup && <RollupRing rollup={bead.treeRollup} />}
        <span className="lin-spacer" />
        {labels.slice(0, 2).map((label) => (
          <LabelBadge key={label} label={label} />
        ))}
        {labels.length > 2 && <span className="lin-more">+{labels.length - 2}</span>}
        {showDate && bead.updatedAt && (
          <span className="lin-date">
            <Timestamp value={bead.updatedAt} format="relative" />
          </span>
        )}
        {showAvatar && bead.assignee && <Avatar assignee={bead.assignee} />}
      </div>
    );
  };

  if (groups.length === 0 && loose.length === 0) {
    return <div className="lin-empty">{emptyText}</div>;
  }

  return (
    <div className="lin-list">
      {groups.map((root) => {
        const rows = flatten(root.subRows, 1, []);
        const open = isOpen(root.id);
        return (
          <section key={root.id} className="lin-group">
            <header className="lin-group-header">
              <button
                type="button"
                className="lin-group-chevron"
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${root.title}`}
                onClick={() => toggle(root.id)}
              >
                <Chevron open={open} />
              </button>
              {root.type && <TypeIcon type={root.type as BeadType} size={14} />}
              <button
                type="button"
                className={`lin-group-title${root.id === selectedBeadId ? " selected" : ""}`}
                onClick={() => onSelectBead(root.id)}
                onMouseEnter={(e) => onRowMouseEnter(e, root.id)}
                onMouseLeave={onRowMouseLeave}
              >
                {root.title}
              </button>
              {root.treeRollup && <RollupRing rollup={root.treeRollup} />}
              <span className="lin-group-count">{rows.length}</span>
              <span className="lin-spacer" />
              <StatusSelect
                status={root.status}
                onChange={(status) => onUpdateBead(root.id, { status })}
              />
            </header>
            {open && rows.map(renderRow)}
          </section>
        );
      })}
      {loose.length > 0 && (
        <section className="lin-group">
          {groups.length > 0 && (
            <header className="lin-group-header">
              <button
                type="button"
                className="lin-group-chevron"
                aria-expanded={isOpen(NO_EPIC_KEY)}
                aria-label={`${isOpen(NO_EPIC_KEY) ? "Collapse" : "Expand"} No epic`}
                onClick={() => toggle(NO_EPIC_KEY)}
              >
                <Chevron open={isOpen(NO_EPIC_KEY)} />
              </button>
              <span className="lin-group-title lin-group-title-plain">No epic</span>
              <span className="lin-group-count">{loose.length}</span>
            </header>
          )}
          {(groups.length === 0 || isOpen(NO_EPIC_KEY)) &&
            loose.map((bead) => renderRow({ bead, depth: 0 }))}
        </section>
      )}
    </div>
  );
}
