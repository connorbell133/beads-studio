/**
 * The hygiene rule set.
 *
 * Every rule is deterministic: same input, same findings, same order. That is
 * not a nicety. The Problems panel is republished on every derive, and a rule
 * that emits its findings in traversal order makes rows jump around under the
 * cursor as unrelated beads come and go.
 *
 * Two tiers, because they cost different amounts:
 *
 *   `local` rules read the already-derived `BeadsGraphModel`. Free. They run on
 *   every derive, which is the cadence the cycle check has always had.
 *
 *   `shell` rules spawn `bd` once each. They run only when asked, because a
 *   process spawn per rule per repaint is not a cost a view refresh can carry.
 *
 * On `bd doctor`: deliberately not a rule. Verified against bd 1.2.1 - a plain
 * `bd doctor --json` on an embedded-Dolt project (the default this extension's
 * CLI backend is selected for) returns `{"unsupported": true, "error": "'bd
 * doctor' is not yet supported in embedded mode"}`. The one hygiene check it
 * does support there, `--check=conventions`, is a strictly coarser rollup of
 * lint, stale, and orphans - it reports "11 of 17 open issues missing
 * recommended sections" where the three rules below report which eleven. There
 * is nothing to gain and a duplicate row per finding to lose.
 *
 * On `bd preflight`: also not a rule, and not for cost reasons. It is a
 * contributor checklist for bd's own Go repository - gofmt, nix vendorHash,
 * issues.jsonl pollution - not a hygiene command for a user's beads project.
 */

import type { BeadsGraphModel } from "../graph/types";
import {
  HygieneContext,
  HygieneFinding,
  HygieneRule,
  MAX_FINDINGS_PER_RULE,
  MAX_NAMED_MEMBERS,
  nameList,
  plural,
} from "./types";

export const CYCLE_RULE_CODE = "dependency-cycle";
export const LOOSE_WORK_RULE_CODE = "loose-work";
export const MISSING_SECTIONS_RULE_CODE = "missing-sections";
export const STALE_RULE_CODE = "stale-bead";
export const DUPLICATE_RULE_CODE = "duplicate-content";
export const SIMILAR_RULE_CODE = "similar-beads";
export const COMMIT_REFERENCED_RULE_CODE = "commit-referenced-open";

// ---------------------------------------------------------------------------
// Local rules - derived from the in-memory graph, no process, no I/O.
// ---------------------------------------------------------------------------

/**
 * Sorts within and across cycles so the same tangle publishes in the same order
 * on every refresh - Tarjan emits components in traversal order, which shifts
 * as unrelated beads come and go.
 */
export function normalizeCycles(cycles: string[][] | undefined): string[][] {
  if (!cycles) return [];
  return cycles
    .filter((members) => members && members.length > 0)
    .map((members) => [...members].sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Orientation, then consequence, then the action that resolves it. */
export function cycleMessage(members: string[]): string {
  if (members.length === 1) {
    return (
      `Dependency cycle: ${members[0]} blocks itself. ` +
      `It cannot become ready until that blocks edge is removed.`
    );
  }

  return (
    `Dependency cycle: ${members.length} beads block each other - ` +
    `${nameList(members, MAX_NAMED_MEMBERS)}. ` +
    `None of them can become ready until one of those blocks edges is removed.`
  );
}

export const cycleRule: HygieneRule = {
  code: CYCLE_RULE_CODE,
  title: "Dependency cycles",
  tier: "local",
  run({ graph }) {
    return normalizeCycles(graph?.cycles).map((members) => ({
      code: CYCLE_RULE_CODE,
      severity: "error" as const,
      message: cycleMessage(members),
      beadIds: members,
    }));
  },
};

/**
 * Open work with neither a parent nor children.
 *
 * `tree.ts` has computed this for the Issues list since the tree landed, and
 * renders it as a passive "No epic" lane. A lane is a place to put things; it
 * is not a signal. The same set, published as a finding, is the signal.
 *
 * Guarded on the project actually using hierarchy. On a project where nobody
 * parents anything, every bead is loose and "sits outside every epic" is not a
 * defect report, it is a description of the workflow.
 */
export function looseWork(graph: BeadsGraphModel | null | undefined): string[] {
  if (!graph) return [];

  const usesHierarchy = Object.values(graph.nodes).some(
    (node) => node.children.length > 0
  );
  if (!usesHierarchy) return [];

  // ready ∪ blocked is exactly the open, non-coordination work: `ready` is
  // "open, unblocked, real work" and `blocked` is the same minus the unblocked
  // part. Reading it this way keeps the rule on the model instead of
  // re-deriving what counts as work.
  const openWork = new Set([...graph.ready, ...graph.blocked]);

  return graph.parentless
    .filter((id) => openWork.has(id))
    .filter((id) => (graph.nodes[id]?.children.length ?? 0) === 0)
    .sort();
}

export const looseWorkRule: HygieneRule = {
  code: LOOSE_WORK_RULE_CODE,
  title: "Work outside every epic",
  tier: "local",
  run({ graph }) {
    const ids = looseWork(graph);
    if (ids.length === 0) return [];

    return [
      {
        code: LOOSE_WORK_RULE_CODE,
        severity: "info" as const,
        message:
          `Outside every epic: ${plural(ids.length, "open bead")} has no parent and no children - ` +
          `${nameList(ids)}. ` +
          `Give each one a home with \`bd update <id> --parent <epic>\`, or leave them standalone on purpose.`,
        beadIds: ids,
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Shell rules - one `bd` spawn each.
// ---------------------------------------------------------------------------

/**
 * Trims a per-bead rule to a readable number of rows, folding the rest into one.
 *
 * Shared by every rule that reports per bead, so the cap is one decision rather
 * than one per rule.
 */
export function capFindings(
  findings: HygieneFinding[],
  code: string,
  overflow: (hidden: number) => string
): HygieneFinding[] {
  if (findings.length <= MAX_FINDINGS_PER_RULE) return findings;

  const kept = findings.slice(0, MAX_FINDINGS_PER_RULE);
  const hidden = findings.slice(MAX_FINDINGS_PER_RULE);
  kept.push({
    code,
    severity: kept[0].severity,
    message: overflow(hidden.length),
    beadIds: hidden.flatMap((finding) => finding.beadIds),
  });
  return kept;
}

function asArray(value: unknown): unknown[] {
  // `bd orphans --json` prints literal `null` for "none" - it marshals a nil
  // slice - so null is an empty result, not a failure.
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A quoted title, or nothing when bd did not send one. */
function titleSuffix(title: string): string {
  return title ? ` "${title}"` : "";
}

// --- bd lint ---------------------------------------------------------------

export interface LintResult {
  id: string;
  title: string;
  missing: string[];
}

/** `bd lint --json` -> `{ total, issues, results: [{ id, title, type, missing }] }`. */
export function parseLint(payload: unknown): LintResult[] {
  return asArray(asRecord(payload).results)
    .map((entry) => {
      const record = asRecord(entry);
      return {
        id: str(record.id),
        title: str(record.title),
        missing: asArray(record.missing).map(str).filter(Boolean),
      };
    })
    .filter((result) => result.id && result.missing.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const missingSectionsRule: HygieneRule = {
  code: MISSING_SECTIONS_RULE_CODE,
  title: "Missing template sections",
  tier: "shell",
  async run({ runBdJson }) {
    const results = parseLint(await runBdJson(["lint", "--json"]));

    return capFindings(
      results.map((result) => ({
        code: MISSING_SECTIONS_RULE_CODE,
        severity: "info" as const,
        message:
          `${result.id}${titleSuffix(result.title)} is missing ${result.missing.join(", ")}. ` +
          `An agent picking this up has to guess what done looks like.`,
        beadIds: [result.id],
      })),
      MISSING_SECTIONS_RULE_CODE,
      (hidden) => `${plural(hidden, "further bead")} missing template sections. Run \`bd lint\` for the full list.`
    );
  },
};

// --- bd stale --------------------------------------------------------------

export interface StaleResult {
  id: string;
  title: string;
  status: string;
  /** Whole days since `updated_at`, or null when bd sent no usable timestamp. */
  days: number | null;
}

/** `bd stale --json` -> a bare array of full issue records. */
export function parseStale(payload: unknown, now: number): StaleResult[] {
  return asArray(payload)
    .map((entry) => {
      const record = asRecord(entry);
      const updatedAt = Date.parse(str(record.updated_at));
      return {
        id: str(record.id),
        title: str(record.title),
        status: str(record.status),
        days: Number.isNaN(updatedAt)
          ? null
          : Math.max(0, Math.floor((now - updatedAt) / 86_400_000)),
      };
    })
    .filter((result) => result.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const staleRule: HygieneRule = {
  code: STALE_RULE_CODE,
  title: "Stale beads",
  tier: "shell",
  async run({ runBdJson, staleDays, now }) {
    const results = parseStale(
      await runBdJson(["stale", "--days", String(staleDays), "--json"]),
      now
    );

    return capFindings(
      results.map((result) => {
        const age =
          result.days === null
            ? `has not been updated in over ${plural(staleDays, "day")}`
            : `has not been updated in ${plural(result.days, "day")}`;
        return {
          code: STALE_RULE_CODE,
          severity: "info" as const,
          message:
            `${result.id}${titleSuffix(result.title)} ${age}` +
            `${result.status ? ` and is still ${result.status}` : ""}. ` +
            `Close it, defer it, or say what it is waiting on.`,
          beadIds: [result.id],
        };
      }),
      STALE_RULE_CODE,
      (hidden) =>
        `${plural(hidden, "further bead")} untouched for ${plural(staleDays, "day")} or more. ` +
        `Run \`bd stale\` for the full list.`
    );
  },
};

// --- bd duplicates ---------------------------------------------------------

export interface DuplicateGroup {
  title: string;
  target: string;
  sources: string[];
}

/**
 * `bd duplicates --json` -> `{ duplicate_groups, groups: [...] }`.
 *
 * bd picks the survivor itself (most-referenced issue wins, ties broken by
 * lexicographically smallest id) and reports it as `suggested_target`. That
 * choice is not re-litigated here: bd can see reference counts, and a client
 * that picked differently would fight the CLI's own `--auto-merge`.
 */
export function parseDuplicates(payload: unknown): DuplicateGroup[] {
  return asArray(asRecord(payload).groups)
    .map((entry) => {
      const record = asRecord(entry);
      return {
        title: str(record.title),
        target: str(record.suggested_target),
        sources: asArray(record.suggested_sources).map(str).filter(Boolean).sort(),
      };
    })
    .filter((group) => group.target && group.sources.length > 0)
    .sort((a, b) => a.target.localeCompare(b.target));
}

export const duplicateRule: HygieneRule = {
  code: DUPLICATE_RULE_CODE,
  title: "Identical beads",
  tier: "shell",
  async run({ runBdJson }) {
    const groups = parseDuplicates(await runBdJson(["duplicates", "--json"]));

    return groups.map((group) => ({
      code: DUPLICATE_RULE_CODE,
      severity: "warning" as const,
      message:
        `Duplicate of ${group.target}${titleSuffix(group.title)}: ${nameList(group.sources)}. ` +
        `Identical content, so every agent that picks one up repeats work already tracked elsewhere.`,
      beadIds: [group.target, ...group.sources],
      fix: {
        key: `${DUPLICATE_RULE_CODE}:${group.target}`,
        title:
          group.sources.length === 1
            ? `Close ${group.sources[0]} as a duplicate of ${group.target}`
            : `Close ${plural(group.sources.length, "duplicate")} of ${group.target}`,
        action: { type: "closeDuplicate" as const, sources: group.sources, target: group.target },
      },
    }));
  },
};

// --- bd find-duplicates ----------------------------------------------------

export interface SimilarPair {
  a: string;
  b: string;
  titleA: string;
  titleB: string;
  similarity: number;
}

/** `bd find-duplicates --json` -> `{ count, pairs: [...], threshold }`. */
export function parseSimilar(payload: unknown): SimilarPair[] {
  return asArray(asRecord(payload).pairs)
    .map((entry) => {
      const record = asRecord(entry);
      return {
        a: str(record.issue_a_id),
        b: str(record.issue_b_id),
        titleA: str(record.issue_a_title),
        titleB: str(record.issue_b_title),
        similarity: typeof record.similarity === "number" ? record.similarity : 0,
      };
    })
    .filter((pair) => pair.a && pair.b)
    .sort((a, b) => (a.a === b.a ? a.b.localeCompare(b.b) : a.a.localeCompare(b.a)));
}

/**
 * Near-duplicates, by token similarity.
 *
 * This is the rule the whole engine is worth building for. Two agents that
 * independently find the same bug file it twice with different wording, and no
 * exact-content check will ever match them - only similarity will. A duplicate
 * bead is not untidiness, it is an agent sent down a path someone else already
 * walked.
 *
 * `--method mechanical` is the default and needs no API key. The AI method is
 * not wired: it bills per run against the user's key, which is not a thing a
 * Problems-panel refresh should ever do without being asked in those terms.
 */
export const similarRule: HygieneRule = {
  code: SIMILAR_RULE_CODE,
  title: "Near-duplicate beads",
  tier: "shell",
  async run({ runBdJson, similarityThreshold }) {
    const pairs = parseSimilar(
      await runBdJson([
        "find-duplicates",
        "--method",
        "mechanical",
        "--threshold",
        String(similarityThreshold),
        "--json",
      ])
    );

    return capFindings(
      pairs.map((pair) => ({
        code: SIMILAR_RULE_CODE,
        severity: "info" as const,
        message:
          `${pair.a}${titleSuffix(pair.titleA)} reads like ${pair.b}${titleSuffix(pair.titleB)} ` +
          `(${Math.round(pair.similarity * 100)}% similar). ` +
          `If they are the same work, mark one with \`bd duplicate\` before two agents take both.`,
        beadIds: [pair.a, pair.b],
      })),
      SIMILAR_RULE_CODE,
      (hidden) =>
        `${plural(hidden, "further pair")} above the similarity threshold. ` +
        `Run \`bd find-duplicates\` for the full list.`
    );
  },
};

// --- bd orphans ------------------------------------------------------------

export interface CommitReferenced {
  id: string;
  title: string;
  status: string;
  commit: string;
}

/**
 * `bd orphans --json` -> an array of `{ issue_id, title, status, latest_commit,
 * latest_commit_message }`, or literal `null` when there are none.
 *
 * bd's "orphan" is not the graph's: it means an issue whose id appears
 * parenthesized in a commit message while the issue is still open. Work that
 * landed and was never closed - which is why it has a `--fix`.
 */
export function parseCommitReferenced(payload: unknown): CommitReferenced[] {
  return asArray(payload)
    .map((entry) => {
      const record = asRecord(entry);
      return {
        id: str(record.issue_id),
        title: str(record.title),
        status: str(record.status),
        commit: str(record.latest_commit),
      };
    })
    .filter((result) => result.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One finding for the whole set, not one per bead, because the fix is one
 * command over the whole set. A per-bead row offering a button that also closes
 * nineteen other beads would be lying about its blast radius.
 */
export const commitReferencedRule: HygieneRule = {
  code: COMMIT_REFERENCED_RULE_CODE,
  title: "Closed in a commit but still open",
  tier: "shell",
  async run({ runBdJson }) {
    const results = parseCommitReferenced(await runBdJson(["orphans", "--json"]));
    if (results.length === 0) return [];

    const ids = results.map((result) => result.id);
    return [
      {
        code: COMMIT_REFERENCED_RULE_CODE,
        severity: "warning" as const,
        message:
          `Referenced by a commit but still open: ${nameList(ids)}. ` +
          `The work looks done in git and undone in beads, so it keeps showing up as available.`,
        beadIds: ids,
        fix: {
          key: COMMIT_REFERENCED_RULE_CODE,
          title: `Close ${plural(ids.length, "issue")} already referenced by commits`,
          action: { type: "closeCommitReferenced" as const, ids },
        },
      },
    ];
  },
};

/**
 * The rule set, in publish order.
 *
 * Order matters only for readability of the Problems panel: errors first, then
 * the checks most likely to be acted on.
 */
export const HYGIENE_RULES: readonly HygieneRule[] = [
  cycleRule,
  commitReferencedRule,
  duplicateRule,
  looseWorkRule,
  missingSectionsRule,
  similarRule,
  staleRule,
];

export const LOCAL_RULES = HYGIENE_RULES.filter((rule) => rule.tier === "local");
export const SHELL_RULES = HYGIENE_RULES.filter((rule) => rule.tier === "shell");

/**
 * Runs a set of rules, isolating failures.
 *
 * A rule that throws - bd missing, a project mid-migration, a payload shape
 * this build has not seen - loses its own findings and nothing else. The
 * alternative, one rejected promise blanking the whole panel, would make the
 * feature less trustworthy than the single hardcoded check it replaces.
 */
export async function runRules(
  rules: readonly HygieneRule[],
  context: HygieneContext,
  onError?: (rule: HygieneRule, error: unknown) => void
): Promise<HygieneFinding[]> {
  const findings: HygieneFinding[] = [];

  for (const rule of rules) {
    try {
      findings.push(...(await rule.run(context)));
    } catch (error) {
      onError?.(rule, error);
    }
  }

  return findings;
}
