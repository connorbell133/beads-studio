import * as vscode from "vscode";
import {
  BdEventsFeed,
  EventsFeedProcess,
  EventsFeedTransport,
  detectEventsTailSupport,
  parseEventRecord,
  parseEventsJournalEnabled,
  splitEventLines,
} from "../bd-events-feed";
import { Logger } from "../../utils/logger";

function createLogger(): Logger {
  return new Logger(vscode.window.createOutputChannel() as unknown as vscode.LogOutputChannel);
}

/** A `bd events tail --follow` stand-in whose output the test drives by hand. */
class FakeTail implements EventsFeedProcess {
  public killed = false;
  private stdout: Array<(chunk: string) => void> = [];
  private stderr: Array<(chunk: string) => void> = [];
  private exit: Array<(reason: string) => void> = [];

  onStdout(handler: (chunk: string) => void): void {
    this.stdout.push(handler);
  }
  onStderr(handler: (chunk: string) => void): void {
    this.stderr.push(handler);
  }
  onExit(handler: (reason: string) => void): void {
    this.exit.push(handler);
  }
  kill(): void {
    this.killed = true;
  }

  emit(chunk: string): void {
    for (const handler of this.stdout) handler(chunk);
  }
  emitStderr(chunk: string): void {
    for (const handler of this.stderr) handler(chunk);
  }
  die(reason = "exit code 1"): void {
    for (const handler of this.exit) handler(reason);
  }
}

interface FakeTransport extends EventsFeedTransport {
  tails: FakeTail[];
  runs: string[][];
}

function createTransport(
  overrides: {
    help?: string | Error;
    config?: string | Error;
    spawnError?: Error;
  } = {}
): FakeTransport {
  const tails: FakeTail[] = [];
  const runs: string[][] = [];

  return {
    tails,
    runs,
    async run(args) {
      runs.push(args);
      const key = args.join(" ");
      if (key.startsWith("events tail --help")) {
        const help = overrides.help ?? "Flags:\n --follow\n --since int\n --limit int";
        if (help instanceof Error) throw help;
        return { stdout: help, stderr: "" };
      }
      if (key.startsWith("config get events-journal")) {
        const config = overrides.config ?? '{"key":"events-journal","value":"true"}';
        if (config instanceof Error) throw config;
        return { stdout: config, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    spawn() {
      if (overrides.spawnError) throw overrides.spawnError;
      const tail = new FakeTail();
      tails.push(tail);
      return tail;
    },
  };
}

const RECORD = '{"seq":7,"ts":"2026-08-14T00:00:00Z","op":"close","issue_id":"vsbeads-1","issue":{}}';

describe("detectEventsTailSupport", () => {
  it("accepts a bd whose tail advertises both flags it needs", () => {
    expect(detectEventsTailSupport("--since int\n--follow keep printing")).toBe(true);
  });

  it("rejects a bd that can read the journal but not follow it", () => {
    expect(detectEventsTailSupport("--since int\n--limit int")).toBe(false);
  });

  it("rejects the error text of a bd with no events command at all", () => {
    expect(detectEventsTailSupport('unknown command "events" for "bd"')).toBe(false);
  });
});

describe("parseEventsJournalEnabled", () => {
  it("reads the json form bd emits for an enabled journal", () => {
    expect(parseEventsJournalEnabled('{"key":"events-journal","value":"true"}')).toBe(true);
  });

  it("reads the value BD_EVENTS_JOURNAL resolves to, not just the literal true", () => {
    expect(parseEventsJournalEnabled('{"key":"events-journal","value":"1"}')).toBe(true);
  });

  it("treats a disabled journal as disabled", () => {
    expect(parseEventsJournalEnabled('{"key":"events-journal","value":"false"}')).toBe(false);
  });

  it("falls back to the plain-text form when json is unavailable", () => {
    expect(parseEventsJournalEnabled("true")).toBe(true);
    expect(parseEventsJournalEnabled("events-journal = true")).toBe(true);
    expect(parseEventsJournalEnabled("false")).toBe(false);
  });

  it("treats an unset key as disabled", () => {
    expect(parseEventsJournalEnabled("events-journal (not set)")).toBe(false);
  });

  it("treats empty and unparseable output as disabled rather than guessing on", () => {
    expect(parseEventsJournalEnabled("")).toBe(false);
    expect(parseEventsJournalEnabled("   ")).toBe(false);
    expect(parseEventsJournalEnabled("something went wrong")).toBe(false);
  });
});

describe("splitEventLines", () => {
  it("returns whole lines and carries the partial one", () => {
    const { lines, remainder } = splitEventLines("", '{"seq":1}\n{"seq":2}\n{"seq":3');
    expect(lines).toEqual(['{"seq":1}', '{"seq":2}']);
    expect(remainder).toBe('{"seq":3');
  });

  it("rejoins a record split across two chunks", () => {
    const first = splitEventLines("", '{"seq":1,"op":"cl');
    expect(first.lines).toEqual([]);
    const second = splitEventLines(first.remainder, 'ose"}\n');
    expect(second.lines).toEqual(['{"seq":1,"op":"close"}']);
    expect(second.remainder).toBe("");
  });

  it("drops blank lines", () => {
    expect(splitEventLines("", "\n\n").lines).toEqual([]);
  });
});

describe("parseEventRecord", () => {
  it("reads the fields the extension cares about", () => {
    expect(parseEventRecord(RECORD)).toMatchObject({ seq: 7, op: "close", issue_id: "vsbeads-1" });
  });

  it("returns null for a line that is not a record", () => {
    expect(parseEventRecord("not json")).toBeNull();
    expect(parseEventRecord("null")).toBeNull();
  });
});

describe("BdEventsFeed", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createFeed(
    transport: FakeTransport,
    overrides: Partial<ConstructorParameters<typeof BdEventsFeed>[0]> = {}
  ): { feed: BdEventsFeed; changes: number[]; states: string[] } {
    const changes: number[] = [];
    const states: string[] = [];
    const feed = new BdEventsFeed({
      transport,
      log: createLogger(),
      onChange: () => changes.push(Date.now()),
      onStateChanged: (state) => states.push(state),
      debounceMs: 300,
      maxDebounceWaitMs: 2000,
      restartDelaysMs: [1000, 5000],
      ...overrides,
    });
    return { feed, changes, states };
  }

  it("subscribes when the journal is enabled", async () => {
    const transport = createTransport();
    const { feed, states } = createFeed(transport);

    await feed.start();

    expect(transport.tails).toHaveLength(1);
    expect(feed.isLive).toBe(true);
    expect(states).toEqual(["live"]);
    feed.dispose();
  });

  it("never subscribes when the journal is disabled", async () => {
    // A disabled journal makes `tail --follow` sit silent forever rather than
    // fail, so subscribing to it would look exactly like a project where
    // nothing is happening. Detection has to happen before the spawn.
    const transport = createTransport({ config: '{"key":"events-journal","value":"false"}' });
    const { feed, states } = createFeed(transport);

    await feed.start();

    expect(transport.tails).toHaveLength(0);
    expect(feed.isLive).toBe(false);
    expect(states).toEqual(["unavailable"]);
  });

  it("never subscribes when the installed bd cannot follow the journal", async () => {
    const transport = createTransport({ help: "--since int\n--limit int" });
    const { feed } = createFeed(transport);

    await feed.start();

    expect(transport.tails).toHaveLength(0);
    expect(feed.state).toBe("unavailable");
  });

  it("degrades quietly when bd has no events command at all", async () => {
    const transport = createTransport({ help: new Error('unknown command "events"') });
    const { feed } = createFeed(transport);

    await expect(feed.start()).resolves.toBeUndefined();
    expect(transport.tails).toHaveLength(0);
    expect(feed.state).toBe("unavailable");
  });

  it("degrades quietly when the config read fails", async () => {
    const transport = createTransport({ config: new Error("no such project") });
    const { feed } = createFeed(transport);

    await feed.start();

    expect(transport.tails).toHaveLength(0);
    expect(feed.state).toBe("unavailable");
  });

  it("reports one change per burst of mutations", async () => {
    const transport = createTransport();
    const { feed, changes } = createFeed(transport);
    await feed.start();

    transport.tails[0].emit(`${RECORD}\n${RECORD}\n${RECORD}\n`);
    expect(changes).toHaveLength(0);

    jest.advanceTimersByTime(300);
    expect(changes).toHaveLength(1);

    feed.dispose();
  });

  it("only reports a change once a record is whole", async () => {
    const transport = createTransport();
    const { feed, changes } = createFeed(transport);
    await feed.start();

    transport.tails[0].emit('{"seq":1,"op":"cl');
    jest.advanceTimersByTime(1000);
    expect(changes).toHaveLength(0);

    transport.tails[0].emit('ose","issue_id":"a"}\n');
    jest.advanceTimersByTime(300);
    expect(changes).toHaveLength(1);

    feed.dispose();
  });

  it("ignores stderr chatter and non-record lines", async () => {
    const transport = createTransport();
    const { feed, changes } = createFeed(transport);
    await feed.start();

    transport.tails[0].emitStderr("warning: something\n");
    transport.tails[0].emit("not a record\n\n");
    jest.advanceTimersByTime(1000);

    expect(changes).toHaveLength(0);
    feed.dispose();
  });

  it("flushes on the ceiling rather than starving under a continuous stream", async () => {
    const transport = createTransport();
    const { feed, changes } = createFeed(transport);
    await feed.start();

    // A record every 200ms resets a 300ms debounce forever; the 2s ceiling is
    // what guarantees the view still updates.
    for (let i = 0; i < 20; i++) {
      transport.tails[0].emit(`${RECORD}\n`);
      jest.advanceTimersByTime(200);
    }

    expect(changes.length).toBeGreaterThanOrEqual(1);
    feed.dispose();
  });

  it("falls back to unavailable when the tail dies, then restarts it", async () => {
    const transport = createTransport();
    const { feed, states } = createFeed(transport);
    await feed.start();

    transport.tails[0].die();
    expect(feed.isLive).toBe(false);
    expect(states).toEqual(["live", "unavailable"]);

    jest.advanceTimersByTime(1000);
    expect(transport.tails).toHaveLength(2);
    expect(feed.isLive).toBe(true);
    expect(states).toEqual(["live", "unavailable", "live"]);

    feed.dispose();
  });

  it("gives up after the restart budget and stays on the fallback", async () => {
    const transport = createTransport();
    const { feed } = createFeed(transport);
    await feed.start();

    transport.tails[0].die();
    jest.advanceTimersByTime(1000);
    transport.tails[1].die();
    jest.advanceTimersByTime(5000);
    transport.tails[2].die();
    jest.advanceTimersByTime(120000);

    expect(transport.tails).toHaveLength(3);
    expect(feed.isLive).toBe(false);

    feed.dispose();
  });

  it("gives a long-lived tail its restart budget back", async () => {
    const transport = createTransport();
    let clock = 0;
    const { feed } = createFeed(transport, { now: () => clock, healthyRunMs: 60000 });
    await feed.start();

    // Two deaths separated by an hour of healthy running are two incidents, not
    // an escalating failure.
    for (let i = 0; i < 3; i++) {
      clock += 3600_000;
      transport.tails[i].die();
      jest.advanceTimersByTime(1000);
    }

    expect(transport.tails).toHaveLength(4);
    expect(feed.isLive).toBe(true);
    feed.dispose();
  });

  it("kills the child and stops reporting once disposed", async () => {
    const transport = createTransport();
    const { feed, changes } = createFeed(transport);
    await feed.start();
    const tail = transport.tails[0];

    tail.emit(`${RECORD}\n`);
    feed.dispose();
    jest.advanceTimersByTime(10000);

    expect(tail.killed).toBe(true);
    expect(changes).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not restart a tail that dies after disposal", async () => {
    const transport = createTransport();
    const { feed } = createFeed(transport);
    await feed.start();

    feed.dispose();
    transport.tails[0].die();
    jest.advanceTimersByTime(60000);

    expect(transport.tails).toHaveLength(1);
  });

  it("spawns exactly one tail no matter how many times it is started", async () => {
    const transport = createTransport();
    const { feed } = createFeed(transport);

    await Promise.all([feed.start(), feed.start()]);
    await feed.start();

    expect(transport.tails).toHaveLength(1);
    feed.dispose();
  });

  it("never spawns after being disposed mid-probe", async () => {
    const transport = createTransport();
    const { feed } = createFeed(transport);

    const starting = feed.start();
    feed.dispose();
    await starting;

    expect(transport.tails).toHaveLength(0);
  });

  it("treats a spawn that throws as a dead tail rather than an exception", async () => {
    const transport = createTransport({ spawnError: new Error("ENOENT") });
    const { feed } = createFeed(transport);

    await expect(feed.start()).resolves.toBeUndefined();
    expect(feed.state).toBe("unavailable");
    feed.dispose();
  });

  it("probes the journal setting rather than assuming it", async () => {
    const transport = createTransport();
    const { feed } = createFeed(transport);

    await feed.start();

    expect(transport.runs).toEqual([
      ["events", "tail", "--help"],
      ["config", "get", "events-journal", "--json"],
    ]);
    feed.dispose();
  });
});
