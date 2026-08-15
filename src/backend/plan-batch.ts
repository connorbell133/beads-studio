/**
 * Turning a draft into `bd batch` scripts, and reading what bd says back.
 *
 * `bd batch` runs every line of a script inside one dolt transaction: on any
 * error the whole batch rolls back and nothing is written. That is the entire
 * reason a multi-node create goes through it instead of a loop of `bd create` -
 * a loop that fails halfway leaves a half-built epic and no record of which
 * half.
 *
 * Two scripts, not one, and the reason is structural rather than a choice:
 * `dep add` takes ids, and ids do not exist until the creates have run. So the
 * commit is a create batch (atomic) followed by an edge batch (atomic), with the
 * ids read out of the first batch's own JSON by line number. A failure in the
 * second batch therefore leaves created-but-unlinked issues, which is why the
 * result names them rather than reporting a bare error.
 *
 * Pure over an injected runner, so every line of script this produces is
 * testable without spawning bd.
 */

import {
  PlanDraft,
  PlanDraftNode,
  hasBlockingErrors,
  planDraftNodes,
  validatePlanDraft,
} from "./plan-draft";

/** One `results[]` entry of `bd batch --json`. */
interface BatchResultEntry {
  line?: number;
  op?: string;
  target?: string;
}

interface BatchResult {
  status?: string;
  results?: BatchResultEntry[];
}

/** Which half of the commit a failure happened in. */
export type PlanCommitStage = "validate" | "create" | "link";

export interface PlanCommitSuccess {
  ok: true;
  epicId: string;
  /** Draft key to the bd id it became, epic included. */
  ids: Record<string, string>;
  taskCount: number;
  edgeCount: number;
}

export interface PlanCommitFailure {
  ok: false;
  stage: PlanCommitStage;
  message: string;
  /**
   * Ids that exist despite the failure.
   *
   * Empty when the create batch rolled back - nothing was written and there is
   * nothing to clean up. Populated when the edges failed, because those issues
   * are real and the user needs to know before retrying and doubling them.
   */
  createdIds: string[];
}

export type PlanCommitResult = PlanCommitSuccess | PlanCommitFailure;

/** Runs one batch script and returns bd's parsed `--json` output. */
export type BatchRunner = (script: string) => Promise<unknown>;

/**
 * Quotes a token for `bd batch`.
 *
 * The grammar splits on whitespace and understands double-quoted strings with
 * `\"` and `\\` escapes. Everything is quoted unconditionally rather than only
 * when it looks like it needs it: a title that happens to be one bare word is
 * the case where a later edit silently starts producing a different number of
 * tokens.
 */
export function quoteBatchToken(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The create half: one `create` line per node, epic first.
 *
 * Epic first because the edge batch links every task to it, and reading the
 * script top-down should match the order the graph is built in.
 */
export function buildCreateScript(draft: PlanDraft): { script: string; keysByLine: string[] } {
  const nodes = planDraftNodes(draft);
  const lines = nodes.map(
    (node) => `create ${node.type} ${node.priority} ${quoteBatchToken(node.title.trim())}`
  );
  return { script: `${lines.join("\n")}\n`, keysByLine: nodes.map((node) => node.key) };
}

/**
 * Maps draft keys onto the ids bd assigned, by line number.
 *
 * bd reports `line` 1-based and in input order. Trusting the reported line
 * rather than the array position means a future bd that reorders or annotates
 * results still lands each id on the right node - and a missing line is a hard
 * error rather than a silently mis-attached id.
 */
export function readCreatedIds(result: unknown, keysByLine: string[]): Record<string, string> {
  const entries = (result as BatchResult | null)?.results;
  if (!Array.isArray(entries)) {
    throw new Error("bd batch did not report which issues it created.");
  }

  const byLine = new Map<number, string>();
  for (const entry of entries) {
    if (typeof entry?.line === "number" && typeof entry?.target === "string") {
      byLine.set(entry.line, entry.target);
    }
  }

  const ids: Record<string, string> = {};
  keysByLine.forEach((key, index) => {
    const id = byLine.get(index + 1);
    if (!id) {
      throw new Error(`bd batch did not report an id for line ${index + 1}.`);
    }
    ids[key] = id;
  });

  return ids;
}

/**
 * The edge half: epic membership, then the blocking edges.
 *
 * Membership is `parent-child` and ordering is `blocks`, never the other way
 * round - `parent-child` does not gate readiness, so modelling sequencing with
 * it produces an epic where everything is ready at once, and modelling
 * membership with `blocks` produces an epic that blocks its own contents.
 */
export function buildEdgeScript(draft: PlanDraft, ids: Record<string, string>): string {
  const epicId = ids[draft.epic.key];
  const lines: string[] = [];

  for (const task of draft.tasks) {
    lines.push(`dep add ${ids[task.key]} ${epicId} parent-child`);
  }
  for (const edge of draft.blocks) {
    const from = ids[edge.from];
    const to = ids[edge.to];
    if (!from || !to) continue;
    lines.push(`dep add ${from} ${to} blocks`);
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Turns a batch failure into something worth reading.
 *
 * bd reports `line N (the failing line): reason`. The line number is the useful
 * part and the raw line is not - it holds generated ids and bd's own grammar -
 * so it is replaced with the title of the issue that line was for. The rollback
 * is stated explicitly because "the entire batch was rolled back, not just the
 * offending line" is bd's documented behaviour and the single most surprising
 * thing about it.
 */
export function describeBatchFailure(
  error: unknown,
  stage: PlanCommitStage,
  labelsByLine: string[]
): string {
  const raw = error instanceof Error ? error.message : String(error);

  // `bd batch` is not in every build the extension will run against, and a
  // missing subcommand is not a rollback - saying "nothing was created" would
  // be true by accident and misleading about why.
  if (/unknown command|unknown flag|unknown shorthand/i.test(raw)) {
    return `This bd build has no \`bd batch\`, which is what makes creating a plan one transaction. Upgrade bd and try again.\n${raw.trim()}`;
  }

  const match = raw.match(/line (\d+)[^:]*:\s*(.*)$/s);
  const rolledBack =
    stage === "create"
      ? "Nothing was created - bd rolled the whole batch back."
      : "No dependencies were added - bd rolled the whole batch back.";

  if (!match) {
    return `${raw.trim()}\n${rolledBack}`;
  }

  const label = labelsByLine[Number(match[1]) - 1];
  const reason = match[2].trim() || raw.trim();
  return label
    ? `${label}: ${reason}\n${rolledBack}`
    : `${reason}\n${rolledBack}`;
}

/**
 * Commits a draft: validate, create, link.
 *
 * Validation runs here as well as in the composer. The composer's copy is what
 * makes the preview useful; this one is what makes the write safe, because a
 * draft can also arrive from a stale webview.
 */
export async function commitPlanDraft(
  draft: PlanDraft,
  runBatch: BatchRunner
): Promise<PlanCommitResult> {
  const issues = validatePlanDraft(draft);
  if (hasBlockingErrors(issues)) {
    const errors = issues.filter((issue) => issue.severity === "error");
    return {
      ok: false,
      stage: "validate",
      message: errors.map((issue) => issue.message).join("\n"),
      createdIds: [],
    };
  }

  const { script, keysByLine } = buildCreateScript(draft);
  const titlesByLine = planDraftNodes(draft).map((node: PlanDraftNode) => node.title.trim());

  let ids: Record<string, string>;
  try {
    ids = readCreatedIds(await runBatch(script), keysByLine);
  } catch (error) {
    return {
      ok: false,
      stage: "create",
      message: describeBatchFailure(error, "create", titlesByLine),
      createdIds: [],
    };
  }

  const edgeScript = buildEdgeScript(draft, ids);
  const createdIds = keysByLine.map((key) => ids[key]);

  if (edgeScript) {
    // Labels for the edge script, in the same order the lines were emitted.
    const edgeLabels = [
      ...draft.tasks.map((task) => `"${task.title.trim()}" under "${draft.epic.title.trim()}"`),
      ...draft.blocks
        .filter((edge) => ids[edge.from] && ids[edge.to])
        .map((edge) => {
          const from = titleFor(draft, edge.from);
          const to = titleFor(draft, edge.to);
          return `"${from}" waiting on "${to}"`;
        }),
    ];

    try {
      await runBatch(edgeScript);
    } catch (error) {
      return {
        ok: false,
        stage: "link",
        message: describeBatchFailure(error, "link", edgeLabels),
        createdIds,
      };
    }
  }

  return {
    ok: true,
    epicId: ids[draft.epic.key],
    ids,
    taskCount: draft.tasks.length,
    edgeCount: draft.blocks.length,
  };
}

function titleFor(draft: PlanDraft, key: string): string {
  return planDraftNodes(draft).find((node) => node.key === key)?.title.trim() ?? key;
}
