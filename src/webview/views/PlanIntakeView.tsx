/**
 * PlanIntakeView - compose an epic, see the DAG, then commit it.
 *
 * The composer on the left is deliberately ordinary. The preview on the right
 * is the point: it runs the draft through `deriveGraph`, the same function the
 * committed graph and the Problems-panel cycle diagnostics run on, and draws it
 * with the same canvas. A reversed edge, a loop, a task nothing can start -
 * every defect the extension can report after the fact is visible here before
 * anything is written.
 *
 * Nothing reaches bd until Create. The whole plan then goes through `bd batch`,
 * so it lands whole or not at all.
 */

import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  PlanDraft,
  PlanIssue,
  derivePlanGraph,
  hasBlockingErrors,
  planDraftNodes,
  validatePlanDraft,
} from "../../backend/plan-draft";
import type { PlanCommitState } from "../../backend/types";
import { GraphLens } from "../../graph/lens";
import { Bead, BeadPriority, BeadStatus } from "../types";
import { Dropdown, DropdownItem } from "../common/Dropdown";
import { ErrorMessage } from "../common/ErrorMessage";
import { FilterChip } from "../common/FilterChip";
import { PlanNodeRow } from "../common/PlanNodeRow";
import { GraphCanvas } from "./GraphCanvas";

const EPIC_KEY = "epic";

/** A plan opens with two tasks: one row is not a DAG, and zero rows is a wall. */
function emptyDraft(): PlanDraft {
  return {
    epic: { key: EPIC_KEY, title: "", type: "epic", priority: 1 },
    tasks: [
      { key: "t1", title: "", type: "task", priority: 2 },
      { key: "t2", title: "", type: "task", priority: 2 },
    ],
    blocks: [],
  };
}

/**
 * The draft as beads, so the preview can use the real canvas.
 *
 * Keys stand in for ids and every node is `open`, which is exactly what these
 * issues will be a moment after Create.
 */
function draftBeads(draft: PlanDraft): Bead[] {
  return planDraftNodes(draft).map((node, index) => ({
    id: node.key,
    title: node.title.trim() || (index === 0 ? "Untitled epic" : "Untitled task"),
    type: node.type,
    priority: node.priority as BeadPriority,
    status: "open" as BeadStatus,
  }));
}

interface PlanIntakeViewProps {
  commitState: PlanCommitState;
  onCommit: (draft: PlanDraft) => void;
  onOpenBead: (beadId: string) => void;
}

export function PlanIntakeView({
  commitState,
  onCommit,
  onOpenBead,
}: PlanIntakeViewProps): React.ReactElement {
  const [draft, setDraft] = useState<PlanDraft>(emptyDraft);
  const [lens, setLens] = useState<GraphLens>("full");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const nextKey = useRef(3);

  const issues = useMemo(() => validatePlanDraft(draft), [draft]);
  const graph = useMemo(() => derivePlanGraph(draft), [draft]);
  const beads = useMemo(() => draftBeads(draft), [draft]);

  const blocked = hasBlockingErrors(issues);
  const committing = commitState.phase === "committing";
  const committed = commitState.phase === "committed";

  const readyCount = graph.ready.filter((id) => id !== EPIC_KEY).length;

  const issuesByKey = useMemo(() => {
    const map = new Map<string, PlanIssue[]>();
    for (const issue of issues) {
      if (!issue.key) continue;
      const list = map.get(issue.key) ?? [];
      list.push(issue);
      map.set(issue.key, list);
    }
    return map;
  }, [issues]);

  const updateTask = useCallback((key: string, patch: Partial<PlanDraft["tasks"][number]>) => {
    setDraft((prev) => ({
      ...prev,
      tasks: prev.tasks.map((task) => (task.key === key ? { ...task, ...patch } : task)),
    }));
  }, []);

  const addTask = useCallback(() => {
    const key = `t${nextKey.current++}`;
    setDraft((prev) => ({
      ...prev,
      tasks: [...prev.tasks, { key, title: "", type: "task", priority: 2 }],
    }));
    setFocusKey(key);
  }, []);

  // Removing a task takes its edges with it. Leaving them would make the draft
  // fail validation for a row the user can no longer see.
  const removeTask = useCallback((key: string) => {
    setDraft((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((task) => task.key !== key),
      blocks: prev.blocks.filter((edge) => edge.from !== key && edge.to !== key),
    }));
  }, []);

  const addBlocker = useCallback((from: string, to: string) => {
    setDraft((prev) =>
      prev.blocks.some((edge) => edge.from === from && edge.to === to)
        ? prev
        : { ...prev, blocks: [...prev.blocks, { from, to }] }
    );
  }, []);

  const removeBlocker = useCallback((from: string, to: string) => {
    setDraft((prev) => ({
      ...prev,
      blocks: prev.blocks.filter((edge) => !(edge.from === from && edge.to === to)),
    }));
  }, []);

  const titleOf = useCallback(
    (key: string) =>
      draft.tasks.find((task) => task.key === key)?.title.trim() || "Untitled task",
    [draft.tasks]
  );

  if (committed) {
    return (
      <div className="plan-intake plan-intake-done">
        <div className="empty-state">
          <h1 className="plan-title">Created {commitState.epicId}</h1>
          <p>
            {commitState.taskCount} {commitState.taskCount === 1 ? "task" : "tasks"} and{" "}
            {commitState.edgeCount} blocking{" "}
            {commitState.edgeCount === 1 ? "link" : "links"}, in one transaction.
          </p>
          <div className="plan-actions">
            <button
              type="button"
              className="plan-button primary"
              onClick={() => onOpenBead(commitState.epicId)}
            >
              Open {commitState.epicId}
            </button>
            <button
              type="button"
              className="plan-button"
              onClick={() => {
                setDraft(emptyDraft());
                nextKey.current = 3;
              }}
            >
              Plan another epic
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="plan-intake">
      <header className="plan-header">
        <h1 className="plan-title">New epic</h1>
        <p className="plan-subtitle">
          Describe the work and how it is sequenced. The graph on the right is derived from
          this draft the same way the extension derives the real one &mdash; nothing is
          written to bd until you press Create, and then all of it is written at once.
        </p>
      </header>

      <div className="plan-body">
        <section className="plan-composer" aria-label="Plan composer">
          <h2 className="plan-section-title">Epic</h2>
          <PlanNodeRow
            title={draft.epic.title}
            type={draft.epic.type}
            priority={draft.epic.priority}
            placeholder="What is this epic called?"
            titleLabel="Epic title"
            invalid={issuesByKey.get(EPIC_KEY)?.some((i) => i.severity === "error")}
            onTitleChange={(title) =>
              setDraft((prev) => ({ ...prev, epic: { ...prev.epic, title } }))
            }
            onTypeChange={(type) =>
              setDraft((prev) => ({ ...prev, epic: { ...prev.epic, type } }))
            }
            onPriorityChange={(priority) =>
              setDraft((prev) => ({ ...prev, epic: { ...prev.epic, priority } }))
            }
          />

          <h2 className="plan-section-title">Tasks</h2>
          <ul className="plan-task-list">
            {draft.tasks.map((task) => {
              const blockers = draft.blocks.filter((edge) => edge.from === task.key);
              // A task can wait on any other task. Ones it already waits on are
              // off the list, and so is itself.
              const candidates = draft.tasks.filter(
                (other) =>
                  other.key !== task.key &&
                  !blockers.some((edge) => edge.to === other.key)
              );

              return (
                <li key={task.key} className="plan-task">
                  <PlanNodeRow
                    title={task.title}
                    type={task.type}
                    priority={task.priority}
                    placeholder="What needs doing?"
                    titleLabel="Task title"
                    autoFocus={focusKey === task.key}
                    invalid={issuesByKey.get(task.key)?.some((i) => i.severity === "error")}
                    onTitleChange={(title) => updateTask(task.key, { title })}
                    onTypeChange={(type) => updateTask(task.key, { type })}
                    onPriorityChange={(priority) => updateTask(task.key, { priority })}
                  >
                    <button
                      type="button"
                      className="plan-icon-button"
                      title="Remove this task"
                      aria-label={`Remove ${task.title.trim() || "this task"}`}
                      onClick={() => removeTask(task.key)}
                    >
                      &times;
                    </button>
                  </PlanNodeRow>

                  <div className="plan-blockers">
                    <span className="plan-blockers-label">waits on</span>
                    {blockers.map((edge) => (
                      <FilterChip
                        key={edge.to}
                        label={titleOf(edge.to)}
                        onRemove={() => removeBlocker(task.key, edge.to)}
                      />
                    ))}
                    {blockers.length === 0 && (
                      <span className="plan-blockers-empty">nothing &mdash; starts immediately</span>
                    )}
                    {candidates.length > 0 && (
                      <Dropdown
                        trigger={<span>Add blocker</span>}
                        triggerClassName="plan-blocker-add"
                        showChevron={false}
                        title={`Choose what ${task.title.trim() || "this task"} waits on`}
                      >
                        {candidates.map((other) => (
                          <DropdownItem
                            key={other.key}
                            onClick={() => addBlocker(task.key, other.key)}
                          >
                            {other.title.trim() || "Untitled task"}
                          </DropdownItem>
                        ))}
                      </Dropdown>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <button type="button" className="plan-button" onClick={addTask}>
            Add task
          </button>
        </section>

        <section className="plan-preview" aria-label="Plan preview">
          <h2 className="plan-section-title">Preview</h2>
          <p className="plan-preview-summary">
            {draft.tasks.length} {draft.tasks.length === 1 ? "task" : "tasks"} ·{" "}
            {draft.blocks.length} blocking {draft.blocks.length === 1 ? "link" : "links"} ·{" "}
            <strong>{readyCount}</strong> ready on day one
            {graph.hasCycle && (
              <>
                {" · "}
                <span className="graph-cycle-warning">
                  {graph.cycles.length} {graph.cycles.length === 1 ? "cycle" : "cycles"}
                </span>
              </>
            )}
          </p>

          <GraphCanvas
            beads={beads}
            graph={graph}
            lens={lens}
            onLensChange={setLens}
            className="plan-preview-canvas"
          />

          {issues.length > 0 && (
            <ul className="plan-issues">
              {issues.map((issue, index) => (
                <li key={`${issue.severity}-${index}`} className={`plan-issue ${issue.severity}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="plan-footer">
        {commitState.phase === "failed" && (
          <div className="plan-failure">
            <ErrorMessage message={commitState.message} />
            {commitState.createdIds.length > 0 && (
              <p className="plan-failure-orphans">
                These issues were created before the failure and still exist:{" "}
                {commitState.createdIds.join(", ")}. Creating this plan again would duplicate
                them.
              </p>
            )}
          </div>
        )}
        <button
          type="button"
          className="plan-button primary"
          disabled={blocked || committing}
          title={
            blocked
              ? "Fix the errors above first"
              : "Create every issue and link in one bd batch transaction"
          }
          onClick={() => onCommit(draft)}
        >
          {committing ? "Creating…" : "Create epic"}
        </button>
      </footer>
    </div>
  );
}
