/**
 * BeadsGraphPanel - the dependency graph in an editor tab.
 *
 * "View in graph" has existed as a button since before there was a graph view
 * to open; two call sites ran `beadsGraph.focus` against a view that was never
 * registered. This is the surface those buttons were always pointing at.
 */

import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { WebviewToExtensionMessage } from "../backend/types";
import {
  buildDriftReport,
  DRIFT_PRESETS,
  DriftCommit,
  resolveDriftRef,
} from "../graph/drift";
import { Logger } from "../utils/logger";
import { BeadsPanelHost, LoadReason } from "./BeadsPanelHost";

/**
 * The graph is usually open beside a terminal running `bd`, and nothing else
 * tells it that a dependency was added or a bead closed - the CLI backend has no
 * change token to watch. Five seconds is short enough that the picture tracks
 * the work, long enough that it costs one read per tab per five seconds.
 */
const GRAPH_POLL_INTERVAL_MS = 5000;

export class BeadsGraphPanel extends BeadsPanelHost {
  protected readonly viewType = "beadsGraph";
  protected readonly title = "Beads Graph";
  protected readonly pollIntervalMs = GRAPH_POLL_INTERVAL_MS;

  private focusBeadId: string | null = null;
  private loadSequence = 0;

  /**
   * The comparison point the drift lens is reading against, once resolved to a
   * real commit. Held on the extension side rather than in the webview because
   * it has to survive the panel's own five-second poll: every reload re-runs
   * the diff so the drift annotation ages with the graph it decorates instead
   * of describing a snapshot from whenever the user last touched the picker.
   */
  private driftRef: { hash: string; label: string; at?: string } | null = null;
  private driftSequence = 0;

  constructor(
    extensionUri: vscode.Uri,
    projectManager: BeadsProjectManager,
    logger: Logger
  ) {
    super(extensionUri, projectManager, logger.child("Graph"));
  }

  /** Opens the graph, optionally centred on a bead. */
  public show(beadId?: string): void {
    this.focusBeadId = beadId ?? null;
    const alreadyOpen = this.isOpen();
    this.reveal();
    // A fresh panel loads via its ready message; an open one needs telling that
    // the focus target moved.
    if (alreadyOpen) {
      this.postMessage({ type: "setSelectedBeadId", beadId: this.focusBeadId });
      this.loadData("manualRefresh");
    }
  }

  /**
   * Asks the graph surface to open its find affordance.
   *
   * The command palette is where VS Code users already look for an accelerator,
   * so "find in graph" is a command rather than only a button in the tab.
   */
  public requestFind(): void {
    this.postMessage({ type: "focusGraphFind" });
  }

  protected async loadData(reason: LoadReason = "background"): Promise<void> {
    const thisRequest = ++this.loadSequence;
    const showLoading = reason !== "background";

    if (showLoading) {
      this.setLoading(true);
    }
    this.setError(null);

    try {
      const loaded = await this.loadGraph();
      if (thisRequest !== this.loadSequence) {
        return;
      }
      if (!loaded) {
        this.postMessage({ type: "setBeads", beads: [] });
        this.setLoading(false);
        return;
      }

      this.postMessage({ type: "setBeads", beads: loaded.beads });
      this.postMessage({ type: "setGraph", graph: loaded.model });
      this.postMessage({ type: "setSelectedBeadId", beadId: this.focusBeadId });
      this.setLoading(false);
      // After the graph, never before: the annotation is meaningless against a
      // node set the webview has not received yet.
      void this.loadDrift(false);
    } catch (err) {
      if (thisRequest !== this.loadSequence) {
        return;
      }
      this.setError(String(err));
      this.handleBackendError("Failed to load graph", err);
    } finally {
      if (thisRequest === this.loadSequence) {
        this.setLoading(false);
      }
    }
  }

  protected async handleCustomMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "requestDriftRefs":
        await this.sendDriftRefs();
        break;

      case "setDriftRef":
        await this.chooseDriftRef(message.presetId, message.commit);
        break;

      default:
        await super.handleCustomMessage(message);
    }
  }

  /** The commit listing behind the picker. Failure empties it rather than erroring the panel. */
  private async sendDriftRefs(): Promise<void> {
    const client = this.projectManager.getClient();
    if (!client) {
      this.postMessage({ type: "setDriftRefs", refs: [] });
      return;
    }

    try {
      const commits = await client.recentCommits();
      this.postMessage({
        type: "setDriftRefs",
        refs: commits.map((commit) => ({ hash: commit.hash, at: commit.at })),
      });
    } catch (error) {
      this.log.debug(
        `Unable to list commits for drift: ${error instanceof Error ? error.message : String(error)}`
      );
      this.postMessage({ type: "setDriftRefs", refs: [] });
    }
  }

  /**
   * Turns whatever the user picked into a real commit, then runs the diff.
   *
   * A preset is a duration, and `bd diff` rejects durations and dates alike, so
   * the resolution happens here against the commit listing. The label the
   * webview shows is the one it asked for; the commit's own timestamp travels
   * with it so the picker can say which moment it actually landed on.
   */
  private async chooseDriftRef(presetId?: string, commit?: string): Promise<void> {
    const client = this.projectManager.getClient();

    if (!presetId && !commit) {
      this.driftRef = null;
      this.driftSequence++;
      this.postMessage({ type: "setDrift", drift: null, error: null });
      return;
    }

    if (commit) {
      this.driftRef = { hash: commit, label: shortHash(commit) };
      await this.loadDrift(true);
      return;
    }

    const preset = DRIFT_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset || !client) {
      this.postMessage({
        type: "setDrift",
        drift: null,
        error: "That comparison point is not available.",
      });
      return;
    }

    let commits: DriftCommit[] = [];
    try {
      commits = await client.recentCommits();
    } catch (error) {
      this.postMessage({
        type: "setDrift",
        drift: null,
        error: `Could not read history: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const cutoff = Date.now() - preset.hours * 60 * 60 * 1000;
    const resolved = resolveDriftRef(commits, cutoff);
    if (!resolved) {
      this.postMessage({
        type: "setDrift",
        drift: null,
        error: "This project has no commit history to compare against yet.",
      });
      return;
    }

    this.driftRef = {
      hash: resolved.hash,
      // A clamped resolution is a different claim from the one the user made,
      // so it says so rather than labelling an older commit "since yesterday".
      label: resolved.clamped ? `${preset.label} (as far back as history goes)` : preset.label,
      at: resolved.at,
    };
    await this.loadDrift(true);
  }

  /**
   * Runs `bd diff` for the pinned ref and posts the report.
   *
   * `announce` separates a picker press, which should show a spinner, from the
   * refresh that rides along with every graph poll, which should not: a
   * pending flag flashing every five seconds is worse than no feedback.
   */
  private async loadDrift(announce: boolean): Promise<void> {
    const ref = this.driftRef;
    const client = this.projectManager.getClient();
    if (!ref || !client) return;

    const thisRequest = ++this.driftSequence;
    if (announce) {
      this.postMessage({ type: "setDrift", drift: null, pending: true, error: null });
    }

    try {
      const entries = await client.diffRefs(ref.hash);
      if (thisRequest !== this.driftSequence) return;
      this.postMessage({
        type: "setDrift",
        drift: buildDriftReport(entries, {
          fromRef: ref.hash,
          fromLabel: ref.label,
          fromAt: ref.at,
        }),
        error: null,
      });
    } catch (error) {
      if (thisRequest !== this.driftSequence) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug(`Drift read failed for ${ref.hash}: ${message}`);
      this.postMessage({ type: "setDrift", drift: null, error: message });
    }
  }
}

/** Dolt hashes are 32 characters of noise; eight is enough to tell two apart. */
function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
