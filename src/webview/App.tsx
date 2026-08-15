/**
 * Main App Component
 *
 * Routes to the appropriate view based on viewType.
 * Manages global state and message passing with the extension.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Bead,
  BeadsGraphModel,
  BeadsProject,
  BeadsSummary,
  COORDINATION_TYPES,
  DriftRefOption,
  DriftReport,
  ExtensionMessage,
  WebviewSettings,
  vscode,
} from "./types";
import { DashboardView } from "./views/DashboardView";
import { IssuesView } from "./views/IssuesView";
import { DetailsView } from "./views/DetailsView";
import { GraphView } from "./views/GraphView";
import { Loading } from "./common/Loading";
import { NoProject } from "./common/NoProject";
import { ToastProvider, triggerToast } from "./common/Toast";

interface AppState {
  viewType: string;
  project: BeadsProject | null;
  projects: BeadsProject[];
  beads: Bead[];
  selectedBead: Bead | null;
  selectedBeadId: string | null;
  /** Surface that caused the current selection; drives reveal-vs-stay. */
  selectionOrigin: string | null;
  /** Bumped by beads.findInGraph; any change moves focus into the find field. */
  findRequests: number;
  /** Set by the dashboard's stat strip; any bump re-applies the preset. */
  issuesPresetId: string | null;
  issuesPresetRequests: number;
  /** When ids became ready, recorded by the dashboard provider across loads. */
  pulseEvents: { id: string; at: number }[];
  summary: BeadsSummary | null;
  graph: BeadsGraphModel | null;
  /** The running plan-drift comparison, when the graph has one set. */
  drift: DriftReport | null;
  /** A drift read is in flight; the picker was just used. */
  driftPending: boolean;
  /** Why the last drift read failed. Shown in place of the annotation, never as a toast. */
  driftError: string | null;
  /** Commits the drift picker can offer, newest first. */
  driftRefs: DriftRefOption[];
  loading: boolean;
  error: string | null;
  settings: WebviewSettings;
}

const initialState: AppState = {
  viewType: "",
  project: null,
  projects: [],
  beads: [],
  selectedBead: null,
  selectedBeadId: null,
  selectionOrigin: null,
  findRequests: 0,
  issuesPresetId: null,
  issuesPresetRequests: 0,
  pulseEvents: [],
  summary: null,
  graph: null,
  drift: null,
  driftPending: false,
  driftError: null,
  driftRefs: [],
  loading: true,
  error: null,
  settings: { renderMarkdown: true, userId: "", tooltipHoverDelay: 1000 },
};

export function App(): React.ReactElement {
  const [state, setState] = useState<AppState>(initialState);

  // Handle messages from the extension
  const handleMessage = useCallback((event: MessageEvent<ExtensionMessage>) => {
    const message = event.data;

    switch (message.type) {
      case "setViewType":
        setState((prev) => ({ ...prev, viewType: message.viewType }));
        break;
      case "applyIssuesPreset":
        setState((prev) => ({
          ...prev,
          issuesPresetId: message.presetId,
          issuesPresetRequests: prev.issuesPresetRequests + 1,
        }));
        break;
      case "setPulse":
        setState((prev) => ({ ...prev, pulseEvents: message.events }));
        break;
      case "setProject":
        setState((prev) => ({ ...prev, project: message.project }));
        break;
      case "setProjects":
        setState((prev) => ({ ...prev, projects: message.projects }));
        break;
      case "setBeads":
        setState((prev) => ({ ...prev, beads: message.beads }));
        break;
      case "setBead":
        setState((prev) => ({ ...prev, selectedBead: message.bead }));
        break;
      case "setSelectedBeadId":
        setState((prev) => ({
          ...prev,
          selectedBeadId: message.beadId,
          selectionOrigin: message.origin ?? null,
        }));
        break;
      case "setSummary":
        setState((prev) => ({ ...prev, summary: message.summary }));
        break;
      case "setGraph":
        setState((prev) => ({ ...prev, graph: message.graph }));
        break;
      case "setDriftRefs":
        setState((prev) => ({ ...prev, driftRefs: message.refs }));
        break;
      case "setDrift":
        setState((prev) => ({
          ...prev,
          // A pending message carries no report; keeping the previous one on
          // screen while the next resolves is what stops the graph flashing
          // back to un-annotated between two picks.
          drift: message.pending ? prev.drift : message.drift,
          driftPending: message.pending ?? false,
          driftError: message.error ?? null,
        }));
        break;
      case "focusGraphFind":
        setState((prev) => ({ ...prev, findRequests: prev.findRequests + 1 }));
        break;
      case "setLoading":
        setState((prev) => ({ ...prev, loading: message.loading }));
        break;
      case "setError":
        setState((prev) => ({ ...prev, error: message.error }));
        break;
      case "setSettings":
        setState((prev) => ({ ...prev, settings: message.settings }));
        break;
      case "refresh":
        vscode.postMessage({ type: "refresh" });
        break;
      case "showToast":
        triggerToast(message.text, "top-right");
        break;
    }
  }, []);

  useEffect(() => {
    // Listen for messages from the extension
    window.addEventListener("message", handleMessage);

    // Notify extension that webview is ready
    vscode.postMessage({ type: "ready" });

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  // Coordination beads reach the webview so the graph is complete and future
  // surfaces (a gate lane, a human inbox) can render them. They are filtered
  // once here rather than per view, so adding a view cannot leak them by
  // omission - and so this is the only line to change when a surface wants them.
  const visibleBeads = useMemo(
    () => state.beads.filter((bead) => !COORDINATION_TYPES.includes(bead.type as never)),
    [state.beads]
  );

  // Render the appropriate view
  const renderView = () => {
      // Discovery finished without a project: show how to fix it, not a spinner (#76)
      if (
        !state.loading &&
        !state.project &&
        (state.viewType === "beadsPanel" || state.viewType === "beadsDashboard")
      ) {
        return <NoProject />;
      }

      if (state.viewType === "beadsPanel" && state.loading && visibleBeads.length === 0) {
        return <Loading />;
      }

      switch (state.viewType) {
      case "beadsDashboard":
        return (
          <DashboardView
            summary={state.summary}
            beads={visibleBeads}
            pulseEvents={state.pulseEvents}
            graph={state.graph}
            selectedBeadId={state.selectedBeadId}
            loading={state.loading}
            error={state.error}
            projects={state.projects}
            activeProject={state.project}
            onSelectProject={(project) =>
              vscode.postMessage({
                type: "selectProject",
                projectId: project.id,
                projectRootPath: project.rootPath,
              })
            }
            onSelectBead={(beadId) =>
              vscode.postMessage({ type: "openBeadDetails", beadId })
            }
            onShowStatus={() => vscode.postMessage({ type: "showDoltStatus" })}
            onStartDolt={() => vscode.postMessage({ type: "startDoltServer" })}
            onStopDolt={() => vscode.postMessage({ type: "stopDoltServer" })}
            onOpenDoltLog={() => vscode.postMessage({ type: "openDoltLog" })}
            onOpenProjectFolder={() => vscode.postMessage({ type: "openProjectFolder" })}
            onOpenIssuesPreset={(presetId) =>
              vscode.postMessage({ type: "openIssuesPreset", presetId })
            }
            onOpenGraph={() => vscode.postMessage({ type: "openGraph" })}
            onRetry={() =>
              vscode.postMessage({ type: "refresh" })
            }
          />
        );

      case "beadsPanel":
        return (
          <IssuesView
            beads={visibleBeads}
            graph={state.graph}
            loading={state.loading}
            error={state.error}
            selectedBeadId={state.selectedBeadId}
            presetId={state.issuesPresetId}
            presetRequests={state.issuesPresetRequests}
            tooltipHoverDelay={state.settings.tooltipHoverDelay}
            onSelectBead={(beadId) =>
              vscode.postMessage({ type: "openBeadDetails", beadId })
            }
            onUpdateBead={(beadId, updates) =>
              vscode.postMessage({ type: "updateBead", beadId, updates })
            }
            onRetry={() =>
              vscode.postMessage({ type: "refresh" })
            }
          />
        );

      case "beadsGraph":
        return (
          <GraphView
            beads={visibleBeads}
            graph={state.graph}
            focusFindToken={state.findRequests}
            loading={state.loading}
            error={state.error}
            selectedBeadId={state.selectedBeadId}
            drift={state.drift}
            driftPending={state.driftPending}
            driftError={state.driftError}
            driftRefs={state.driftRefs}
            onSelectBead={(beadId) =>
              vscode.postMessage({ type: "openBeadDetails", beadId })
            }
            onDriftRefChange={(choice) =>
              vscode.postMessage({ type: "setDriftRef", ...choice })
            }
            onRequestDriftRefs={() => vscode.postMessage({ type: "requestDriftRefs" })}
            onRetry={() => vscode.postMessage({ type: "refresh" })}
            onRefresh={() => vscode.postMessage({ type: "refresh" })}
          />
        );

      case "beadsDetails": {
        if (!state.selectedBead && !state.loading) {
          return (
            <div className="empty-state compact">
              <p>Select an issue to view details</p>
            </div>
          );
        }
        if (!state.selectedBead) {
          return <Loading />;
        }
        // Extract unique assignees from beads list
        const knownAssignees = Array.from(
          new Set(visibleBeads.map((b) => b.assignee).filter((a): a is string => !!a))
        ).sort();
        return (
          <DetailsView
            bead={state.selectedBead}
            loading={state.loading}
            renderMarkdown={state.settings.renderMarkdown}
            userId={state.settings.userId}
            knownAssignees={knownAssignees}
            onUpdateBead={(beadId, updates) =>
              vscode.postMessage({ type: "updateBead", beadId, updates })
            }
            onAddDependency={(beadId, targetId, dependencyType, reverse) =>
              vscode.postMessage({ type: "addDependency", beadId, targetId, dependencyType, reverse })
            }
            onRemoveDependency={(beadId, dependsOnId) =>
              vscode.postMessage({ type: "removeDependency", beadId, dependsOnId })
            }
            onAddComment={(beadId, text) =>
              vscode.postMessage({ type: "addComment", beadId, text })
            }
            onViewInGraph={(beadId) =>
              vscode.postMessage({ type: "viewInGraph", beadId })
            }
            onSelectBead={(beadId) =>
              vscode.postMessage({ type: "openBeadDetails", beadId })
            }
            onCopyId={(beadId) =>
              vscode.postMessage({ type: "copyBeadId", beadId })
            }
          />
        );
      }

      default:
        return (
          <div className="empty-state">
            <p>Loading...</p>
          </div>
        );
    }
  };

  return (
    <ToastProvider>
      <div className="app">
        <main className="app-content">{renderView()}</main>
      </div>
    </ToastProvider>
  );
}
