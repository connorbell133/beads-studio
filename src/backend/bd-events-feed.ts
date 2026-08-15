/**
 * bd-events-feed - a live change feed built on `bd events tail --follow`.
 *
 * Until bd 1.2.1 the extension had no way to be told that a bead moved: the CLI
 * exposed no change token, so every surface that needed to track work happening
 * outside the editor re-read the whole project on a timer. `bd events` is a
 * durable journal of committed mutations, and `tail --follow` streams new rows
 * as they commit, which turns that timer into a subscription.
 *
 * Three things about the journal shape this module more than anything else:
 *
 * 1. It is opt-in (`bd config set events-journal true`). With it off,
 *    `bd events tail --follow` still starts, still exits 0, and then prints
 *    nothing forever - verified against bd 1.2.1. A disabled journal is
 *    therefore indistinguishable from a quiet project at the stream level, so
 *    availability MUST be decided before subscribing, from configuration, and
 *    never inferred from the stream staying silent.
 * 2. `bd sql` writes bypass the journal entirely, and rows arriving via
 *    `bd dolt pull`/merge are never journaled on this replica because they were
 *    not mutated here. Both are invisible to any consumer of the feed, which is
 *    why the timer is slowed rather than removed when the feed is live.
 * 3. `seq` is per-replica and gapless. This feed only ever asks "did something
 *    change", never "what changed", so it does not track a checkpoint at all -
 *    which sidesteps the whole class of bugs around carrying a seq across
 *    replicas.
 */

import { spawn as nodeSpawn } from "child_process";
import { execFile } from "child_process";
import * as util from "util";
import type { Logger } from "../utils/logger";

const execFileAsync = util.promisify(execFile);

/** Probes are reads; a slow one must not hold up project activation. */
const PROBE_TIMEOUT_MS = 5000;

/** Collapses a burst of mutations - an agent closing ten beads - into one read. */
const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Ceiling on that coalescing, so a continuous stream of mutations cannot keep
 * resetting the debounce and starve the refresh it exists to trigger.
 */
const DEFAULT_MAX_DEBOUNCE_WAIT_MS = 2000;

/**
 * Backoff for a tail that dies. Short first, because the common cause is a
 * transient bd or Dolt hiccup; bounded, because the poll fallback already keeps
 * the picture correct and an unbounded respawn loop against a broken bd is
 * worse than quietly falling back.
 */
const DEFAULT_RESTART_DELAYS_MS = [1000, 5000, 15000, 60000];

/**
 * A tail that ran this long before dying was healthy, not broken, so its death
 * should not count against the backoff budget. Without this, a session left open
 * for a week would exhaust four restarts on four unrelated hiccups and never
 * subscribe again.
 */
const DEFAULT_HEALTHY_RUN_MS = 60000;

/**
 * A line longer than this is not a journal record. Dropping the buffer beats
 * growing it without limit if bd ever emits an unterminated stream.
 */
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;

/**
 * Whether the feed is currently a live subscription.
 *
 * "unavailable" is a normal, expected resting state - most projects have the
 * journal switched off - and never an error the user needs to see.
 */
export type EventsFeedState = "idle" | "live" | "unavailable";

/** The long-lived `bd events tail --follow` process, as this module needs it. */
export interface EventsFeedProcess {
  onStdout(handler: (chunk: string) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  /** Fires once, for a clean exit, a signal, or a failure to spawn at all. */
  onExit(handler: (reason: string) => void): void;
  kill(): void;
}

/**
 * The process boundary, injected so the feed can be tested without bd.
 *
 * Mirrors `BeadsCommandRunner.execBd`'s seam: everything above this interface is
 * ordinary logic, everything below it is a child process.
 */
export interface EventsFeedTransport {
  /** One-shot read. Rejects like execFile does. */
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
  spawn(args: string[]): EventsFeedProcess;
}

export interface EventsFeedAvailability {
  available: boolean;
  /** Human-readable, for the log only. Never surfaced as an error. */
  reason: string;
}

/**
 * Whether the installed bd has a tail that can be followed.
 *
 * Help-text parsing rather than version comparison, matching
 * `detectListCapabilities`: bd rejects an unknown flag by failing the whole
 * command, and the release that introduced `--follow` is not a floor worth
 * guessing at.
 */
export function detectEventsTailSupport(helpText: string): boolean {
  return helpText.includes("--follow") && helpText.includes("--since");
}

/**
 * Whether the events journal is switched on for this project.
 *
 * Reads `bd config get events-journal --json`, which resolves the whole
 * precedence chain for us - including `BD_EVENTS_JOURNAL` in the environment,
 * which reports as the value it was set to rather than as the config file's
 * value. Falls back to the plain-text form so a build without `--json` on
 * `config get` still answers, and treats anything unrecognised as "off": the
 * cost of a false negative is a timer, the cost of a false positive is a view
 * that silently stops updating.
 */
export function parseEventsJournalEnabled(stdout: string): boolean {
  const trimmed = stdout.trim();
  if (!trimmed) return false;

  try {
    const parsed = JSON.parse(trimmed) as { value?: unknown };
    if (parsed && typeof parsed === "object" && "value" in parsed) {
      return isTruthyConfigValue(parsed.value);
    }
  } catch {
    // Not JSON - fall through to the plain-text form.
  }

  // `bd config get events-journal` prints the bare value, and an unset key
  // prints "events-journal (not set)".
  const lastLine = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? "";
  if (lastLine.includes("(not set)")) return false;
  const afterEquals = lastLine.includes("=") ? lastLine.slice(lastLine.lastIndexOf("=") + 1) : lastLine;
  return isTruthyConfigValue(afterEquals);
}

function isTruthyConfigValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
}

/**
 * Splits a stdout chunk into whole lines, returning whatever is left over.
 *
 * A record can straddle two chunk boundaries, so the remainder has to be carried
 * rather than parsed or dropped.
 */
export function splitEventLines(
  buffered: string,
  chunk: string
): { lines: string[]; remainder: string } {
  const combined = buffered + chunk;
  const parts = combined.split(/\r?\n/);
  const remainder = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), remainder };
}

/** The fields of a journal record this extension reads. Everything else is ignored. */
export interface EventsFeedRecord {
  seq?: number;
  op?: string;
  issue_id?: string;
}

/** Parses one JSON-lines record, or null if the line is not one. */
export function parseEventRecord(line: string): EventsFeedRecord | null {
  try {
    const parsed = JSON.parse(line) as EventsFeedRecord;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface BdEventsFeedOptions {
  transport: EventsFeedTransport;
  log: Logger;
  /** Called when one or more mutations have landed, already coalesced. */
  onChange: () => void;
  /** Called whenever the feed becomes live or stops being live. */
  onStateChanged?: (state: EventsFeedState) => void;
  debounceMs?: number;
  maxDebounceWaitMs?: number;
  restartDelaysMs?: number[];
  healthyRunMs?: number;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * One subscription to one project's journal.
 *
 * Deliberately owned per project rather than per view: a tail is a child
 * process, and four open surfaces must not mean four `bd` processes. Consumers
 * get the notification, not the process.
 */
export class BdEventsFeed {
  private readonly transport: EventsFeedTransport;
  private readonly log: Logger;
  private readonly onChange: () => void;
  private readonly onStateChanged?: (state: EventsFeedState) => void;
  private readonly debounceMs: number;
  private readonly maxDebounceWaitMs: number;
  private readonly restartDelaysMs: number[];
  private readonly healthyRunMs: number;
  private readonly now: () => number;

  private currentState: EventsFeedState = "idle";
  private disposed = false;
  private started = false;
  private child: EventsFeedProcess | null = null;
  private lineBuffer = "";
  private pendingSince: number | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private childStartedAt = 0;

  constructor(options: BdEventsFeedOptions) {
    this.transport = options.transport;
    this.log = options.log.child("EventsFeed");
    this.onChange = options.onChange;
    this.onStateChanged = options.onStateChanged;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxDebounceWaitMs = options.maxDebounceWaitMs ?? DEFAULT_MAX_DEBOUNCE_WAIT_MS;
    this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.healthyRunMs = options.healthyRunMs ?? DEFAULT_HEALTHY_RUN_MS;
    this.now = options.now ?? Date.now;
  }

  get state(): EventsFeedState {
    return this.currentState;
  }

  get isLive(): boolean {
    return this.currentState === "live";
  }

  /**
   * Probes, then subscribes if the journal is on.
   *
   * Never rejects: a feed that cannot start is a feed the caller keeps polling
   * behind, not an error worth failing project activation over.
   */
  async start(): Promise<void> {
    if (this.disposed || this.started) return;
    this.started = true;

    const availability = await this.probe();
    if (this.disposed) return;

    if (!availability.available) {
      this.log.debug(`Live change feed unavailable, staying on the poll: ${availability.reason}`);
      this.setState("unavailable");
      return;
    }

    this.log.info("Subscribed to bd events journal; graph refreshes are now change-driven");
    this.subscribe();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.killChild();
    this.currentState = "idle";
  }

  private async probe(): Promise<EventsFeedAvailability> {
    let helpText: string;
    try {
      const { stdout, stderr } = await this.transport.run(["events", "tail", "--help"]);
      helpText = `${stdout}\n${stderr}`;
    } catch (error) {
      return { available: false, reason: `bd has no readable 'events tail' command (${describe(error)})` };
    }

    if (!detectEventsTailSupport(helpText)) {
      return { available: false, reason: "installed bd's 'events tail' does not support --follow" };
    }

    let configOutput: string;
    try {
      const { stdout, stderr } = await this.transport.run(["config", "get", "events-journal", "--json"]);
      configOutput = stdout.trim() || stderr.trim();
    } catch (error) {
      return { available: false, reason: `could not read the events-journal setting (${describe(error)})` };
    }

    if (!parseEventsJournalEnabled(configOutput)) {
      return {
        available: false,
        reason: "events journal is disabled for this project (enable with `bd config set events-journal true`)",
      };
    }

    return { available: true, reason: "events journal is enabled" };
  }

  /**
   * Starts the tail from seq 0.
   *
   * The retained backlog is replayed on connect, which is deliberate: this feed
   * carries no checkpoint, so there is no head to resume from, and the debounce
   * collapses the whole replay into at most one background re-read - which the
   * surface was about to do on open anyway. Guessing a high `--since` to skip
   * the backlog would be actively wrong, because new records are numbered from
   * the replica's own head and would fall below the guess forever.
   */
  private subscribe(): void {
    if (this.disposed || this.child) return;

    this.lineBuffer = "";

    let child: EventsFeedProcess;
    try {
      child = this.transport.spawn(["events", "tail", "--since", "0", "--follow"]);
    } catch (error) {
      this.log.debug(`Could not spawn the events tail: ${describe(error)}`);
      this.setState("unavailable");
      this.scheduleRestart();
      return;
    }

    this.child = child;
    this.childStartedAt = this.now();
    this.setState("live");

    child.onStdout((chunk) => this.consume(chunk));
    child.onStderr((chunk) => {
      const text = chunk.trim();
      if (text) this.log.trace(`bd events stderr: ${text}`);
    });
    child.onExit((reason) => {
      if (this.disposed || this.child !== child) return;
      this.child = null;
      // A tail that lived a long time then died is a fresh incident, not a
      // continuation of an earlier failure, so it gets the full budget back.
      if (this.now() - this.childStartedAt >= this.healthyRunMs) {
        this.restartAttempts = 0;
      }
      this.log.debug(`Events tail ended (${reason}); falling back to the poll while it restarts`);
      this.setState("unavailable");
      this.scheduleRestart();
    });
  }

  private consume(chunk: string): void {
    if (this.disposed) return;

    const { lines, remainder } = splitEventLines(this.lineBuffer, chunk);
    this.lineBuffer = remainder.length > MAX_LINE_BUFFER_BYTES ? "" : remainder;
    if (remainder.length > MAX_LINE_BUFFER_BYTES) {
      this.log.warn("Dropped an oversized events line; the next whole record will resynchronise the feed");
    }

    let mutations = 0;
    let lastSeq: number | undefined;
    for (const line of lines) {
      const record = parseEventRecord(line);
      if (!record) continue;
      mutations++;
      if (typeof record.seq === "number") lastSeq = record.seq;
    }

    if (mutations === 0) return;
    this.log.trace(`Events tail delivered ${mutations} record(s)${lastSeq === undefined ? "" : ` up to seq ${lastSeq}`}`);
    this.scheduleChange();
  }

  /** Trailing debounce with a hard ceiling on how long a change can be held. */
  private scheduleChange(): void {
    const now = this.now();
    if (this.pendingSince === null) this.pendingSince = now;

    const heldFor = now - this.pendingSince;
    const remainingWait = Math.max(0, this.maxDebounceWaitMs - heldFor);
    const delay = Math.min(this.debounceMs, remainingWait);

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pendingSince = null;
      if (this.disposed) return;
      try {
        this.onChange();
      } catch (error) {
        // A consumer must never take down the feed.
        this.log.debug(`Change listener failed: ${describe(error)}`);
      }
    }, delay);
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer) return;

    const delay = this.restartDelaysMs[this.restartAttempts];
    if (delay === undefined) {
      this.log.warn(
        "bd events tail keeps ending; staying on the polling fallback for this project. Reload the window to retry."
      );
      return;
    }
    this.restartAttempts++;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed) return;
      this.subscribe();
    }, delay);
  }

  private setState(state: EventsFeedState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    try {
      this.onStateChanged?.(state);
    } catch (error) {
      this.log.debug(`Feed state listener failed: ${describe(error)}`);
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.pendingSince = null;
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill();
    } catch (error) {
      this.log.debug(`Failed to stop the events tail: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The real process boundary: `bd` in the project, with BEADS_DIR pinned. */
export function createEventsFeedTransport(params: {
  bdPath: string;
  cwd: string;
  beadsDir: string;
}): EventsFeedTransport {
  const env = { ...process.env, BEADS_DIR: params.beadsDir };

  return {
    async run(args) {
      const { stdout, stderr } = await execFileAsync(params.bdPath, args, {
        cwd: params.cwd,
        env,
        maxBuffer: 1024 * 1024,
        timeout: PROBE_TIMEOUT_MS,
        killSignal: "SIGTERM",
      });
      return { stdout, stderr };
    },

    spawn(args) {
      const child = nodeSpawn(params.bdPath, args, {
        cwd: params.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      let exitReported = false;
      const reportExit = (handler: (reason: string) => void, reason: string) => {
        if (exitReported) return;
        exitReported = true;
        handler(reason);
      };

      return {
        onStdout(handler) {
          child.stdout?.on("data", (chunk: string) => handler(String(chunk)));
        },
        onStderr(handler) {
          child.stderr?.on("data", (chunk: string) => handler(String(chunk)));
        },
        onExit(handler) {
          // `error` covers the spawn never happening at all (bd missing from
          // PATH), which emits no `close`.
          child.on("error", (error: Error) => reportExit(handler, error.message));
          child.on("close", (code, signal) =>
            reportExit(handler, signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`)
          );
        },
        kill() {
          child.kill("SIGTERM");
        },
      };
    },
  };
}
