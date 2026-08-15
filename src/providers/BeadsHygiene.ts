/**
 * BeadsHygiene - the shell tier of the rule set, and the fixes it offers.
 *
 * Cost model, stated plainly because it is the whole reason this class exists
 * separately from `BeadsDiagnostics`:
 *
 *   Every shell rule spawns one `bd` process. `bd find-duplicates` compares
 *   every open bead against every other, so it is O(n^2) inside that process.
 *   `BeadsWebviewHost.observeGraph` fires several times per refresh, and a
 *   refresh happens on a timer. Putting five spawns on that path would mean
 *   thousands of `bd` invocations an hour against an embedded Dolt database
 *   that takes a file lock per invocation.
 *
 *   So the shell tier runs only when asked - `beads.runHygiene` - and the rules
 *   run one after another rather than in parallel, for that same lock. One run
 *   is five sequential spawns, and nothing else in the extension triggers one.
 *
 * The findings from a run are a snapshot. They are not refreshed as beads
 * change, because refreshing them means paying for the run again; they are
 * dropped on a project switch, and replaced by the next run.
 */

import { execFile } from "child_process";
import * as util from "util";
import * as vscode from "vscode";
import { BeadsProjectManager } from "../backend/BeadsProjectManager";
import { BeadsProject } from "../backend/types";
import { SHELL_RULES, runRules } from "../hygiene/rules";
import { HygieneFinding, HygieneFix, HygieneFixAction } from "../hygiene/types";
import { Logger } from "../utils/logger";
import { BeadsDiagnostics, DIAGNOSTIC_SOURCE, diagnosticKey } from "./BeadsDiagnostics";

const execFileAsync = util.promisify(execFile);

/**
 * Longer than the 30s the read path allows. `bd find-duplicates` is quadratic
 * in the open bead count, and a hygiene run the user asked for is worth waiting
 * on in a way a background list read is not.
 */
const HYGIENE_TIMEOUT_MS = 120_000;

export class BeadsHygiene implements vscode.Disposable {
  private readonly projectManager: BeadsProjectManager;
  private readonly diagnostics: BeadsDiagnostics;
  private readonly log: Logger;

  /** The run in flight, so a second invocation joins it instead of doubling it. */
  private inFlight: Promise<void> | null = null;

  constructor(
    projectManager: BeadsProjectManager,
    diagnostics: BeadsDiagnostics,
    logger: Logger
  ) {
    this.projectManager = projectManager;
    this.diagnostics = diagnostics;
    this.log = logger.child("Hygiene");
  }

  /**
   * Runs every shell rule and republishes the snapshot.
   *
   * A rule that fails loses its own findings and nothing else - see
   * `runRules`. That matters most for the rule set as a whole: a bd build
   * without one of these subcommands should cost the user that check, not
   * every check.
   */
  public async run(): Promise<void> {
    if (this.inFlight) {
      this.log.debug("Hygiene run already in flight; joining it");
      return this.inFlight;
    }

    const project = this.projectManager.getActiveProject();
    if (!project) {
      vscode.window.showWarningMessage("No active Beads project");
      return;
    }

    this.inFlight = this.runFor(project).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runFor(project: BeadsProject): Promise<void> {
    const failed: string[] = [];

    const findings = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Beads: checking hygiene for ${project.name}`,
      },
      () =>
        runRules(
          SHELL_RULES,
          {
            graph: null,
            runBdJson: (args) => this.runBdJson(project, args),
            staleDays: readNumber("hygiene.staleDays", 30),
            similarityThreshold: readNumber("hygiene.similarityThreshold", 0.5),
            now: Date.now(),
          },
          (rule, error) => {
            failed.push(rule.code);
            this.log.warn(
              `Hygiene rule ${rule.code} failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        )
    );

    // The project can change while five bd calls run. Publishing then would
    // attribute one project's findings to another.
    const current = this.projectManager.getActiveProject();
    if (!current || current.id !== project.id) {
      this.log.debug("Project changed during hygiene run; discarding findings");
      return;
    }

    this.diagnostics.setShellFindings(findings, project);
    this.report(findings, failed);
  }

  private report(findings: HygieneFinding[], failed: string[]): void {
    const suffix = failed.length > 0 ? ` (${failed.join(", ")} could not run)` : "";

    if (findings.length === 0) {
      vscode.window.setStatusBarMessage(`$(check) Beads: hygiene clean${suffix}`, 4000);
      return;
    }

    vscode.window.setStatusBarMessage(
      `$(warning) Beads: ${findings.length} hygiene finding${findings.length === 1 ? "" : "s"}${suffix}`,
      4000
    );
    vscode.commands.executeCommand("workbench.actions.view.problems");
  }

  /**
   * Applies a fix by key, after confirming it.
   *
   * Both entry points land here - the lightbulb and the picker - so the
   * confirmation cannot be skipped by taking the other route. Every one of
   * these closes beads, and the lightbulb gives no hint of how many.
   */
  public async applyFix(key?: string): Promise<void> {
    const fix = key ? this.diagnostics.getFix(key) : await this.pickFix();
    if (!fix) return;

    const project = this.projectManager.getActiveProject();
    if (!project) {
      vscode.window.showWarningMessage("No active Beads project");
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      fix.title,
      { modal: true, detail: describeFix(fix.action) },
      "Apply"
    );
    if (confirmed !== "Apply") return;

    try {
      await this.execFix(project, fix.action);
    } catch (error) {
      await this.log.errorNotify(
        `Hygiene fix failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    // The fix changed beads, so the snapshot that produced it is stale. Re-run
    // rather than leave a Problems row pointing at work that is now closed.
    await this.projectManager.refresh();
    await this.run();
  }

  private async pickFix(): Promise<HygieneFix | undefined> {
    const fixes = this.diagnostics.listFixes();
    if (fixes.length === 0) {
      vscode.window.showInformationMessage(
        "No Beads hygiene fixes available. Run `Beads: Check Hygiene` first."
      );
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      fixes.map((fix) => ({ label: fix.title, detail: describeFix(fix.action), fix })),
      { title: "Beads hygiene fixes", placeHolder: "Choose a fix to apply" }
    );
    return picked?.fix;
  }

  private async execFix(project: BeadsProject, action: HygieneFixAction): Promise<void> {
    if (action.type === "closeCommitReferenced") {
      // `bd orphans --fix` prompts, and defaults to yes when stdin is not a
      // terminal - verified against bd 1.2.1. The modal above is therefore the
      // confirmation, not the CLI's.
      await this.execBd(project, ["orphans", "--fix"]);
      return;
    }

    // Exactly what `bd duplicates` suggests per group: close the copy, then
    // record why it went. Done per group rather than via `--auto-merge`, which
    // is all-or-nothing across every group bd found.
    const client = this.projectManager.getClient();
    if (!client) throw new Error("No Beads backend for the active project");

    for (const source of action.sources) {
      await client.close({ id: source, reason: `Duplicate of ${action.target}` });
      await client.addDependency({
        from_id: source,
        to_id: action.target,
        dep_type: "related",
      });
    }
  }

  private async runBdJson(project: BeadsProject, args: string[]): Promise<unknown> {
    const stdout = await this.execBd(project, args);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  }

  private async execBd(project: BeadsProject, args: string[]): Promise<string> {
    const bdPath = this.projectManager.getBdPath();
    this.log.debug(`Running: ${bdPath} ${args.join(" ")} (cwd=${project.rootPath})`);

    const pending = execFileAsync(bdPath, args, {
      cwd: project.rootPath,
      env: { ...process.env, BEADS_DIR: project.beadsDir },
      maxBuffer: 10 * 1024 * 1024,
      timeout: HYGIENE_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });

    // Close stdin, or `bd orphans --fix` hangs until the timeout waiting on a
    // confirmation nobody can type. execFile leaves the child an open stdin
    // pipe; at EOF bd takes the prompt's default, which is yes. Verified
    // against bd 1.2.1: without this the call fails after the full timeout,
    // with it the same call returns in about a second.
    pending.child.stdin?.end();

    const { stdout } = await pending;
    return stdout;
  }

  public dispose(): void {
    this.inFlight = null;
  }
}

/**
 * Turns diagnostics that carry a fix into lightbulb entries.
 *
 * Registered against files rather than a language, because the diagnostics are
 * anchored on the project's `.beads` path. The picker
 * (`beads.applyHygieneFix` with no argument) is the entry point that does not
 * depend on the anchor being something an editor can open.
 */
export class BeadsHygieneActions implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  private readonly diagnostics: BeadsDiagnostics;

  constructor(diagnostics: BeadsDiagnostics) {
    this.diagnostics = diagnostics;
  }

  public provideCodeActions(
    _document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;

      const key = diagnosticKey(diagnostic);
      const fix = this.diagnostics.getFix(key);
      if (!fix) continue;

      const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = {
        command: "beads.applyHygieneFix",
        title: fix.title,
        arguments: [key],
      };
      actions.push(action);
    }

    return actions;
  }
}

/** The blast radius, spelled out, because every fix here closes beads. */
export function describeFix(action: HygieneFixAction): string {
  if (action.type === "closeCommitReferenced") {
    return `Closes ${action.ids.length === 1 ? "" : `${action.ids.length} issues: `}${action.ids.join(", ")}.`;
  }
  return (
    `Closes ${action.sources.join(", ")} and links ${
      action.sources.length === 1 ? "it" : "them"
    } to ${action.target} as related.`
  );
}

function readNumber(key: string, fallback: number): number {
  const value = vscode.workspace.getConfiguration("beads").get<number>(key, fallback);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
