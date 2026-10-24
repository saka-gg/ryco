/**
 * Commit latency, event-loop stalls and main-thread checkpoint time with WAL checkpoints on the
 * writer (SQLite's autocheckpoint, `--worker off`) or on the checkpoint worker (`--worker on`,
 * SqliteCheckpointWorker.ts). Run with Node from the repository root (the server runtime):
 *
 *   node apps/server/scripts/measure-sqlite-checkpoints.ts --worker on|off --base <state.sqlite>
 *     [--commits 3000] [--pace tight|<ms>|burst] [--threads 3] [--reader] [--big-txn <events>]
 *     [--json <out.json>]
 *   node apps/server/scripts/measure-sqlite-checkpoints.ts --compare 7 --base <state.sqlite>
 *     [--base-ref <commit>] [same options]
 *
 * Each run copies `--base` (a stopped, checkpointed database, e.g. from generate-fixture-home.ts)
 * byte for byte into a fresh temporary directory, opens it with the production persistence layer,
 * and commits events through the real event store and projection pipeline: streaming
 * `thread.message-sent` batches of 4,096 characters round-robin across `--threads` threads (a new
 * message every 50 batches), plus a tool `thread.activity-appended` every 10 events. Paces:
 * `tight` (no wait), `<ms>` between commits (10 models three streams flushing every 32 ms), or
 * `burst` (40 commits 1 ms apart, then a 250 ms pause). SQLite's autocheckpoint stays at its
 * production value.
 *
 * Per commit it records the wall time and the WAL's frame counts right after it. SQLite runs its
 * autocheckpoint inside every commit that leaves at least `wal_autocheckpoint` frames in the WAL,
 * so such a commit is an "inline" checkpoint: on the main thread. `inline.estMs` is their time
 * above the run's median commit. `--reader` holds a read-worker transaction for 2 s every 5 s
 * (the WAL then grows; `catchUpMs` is the time from a reader's end to the WAL's restart).
 * `--big-txn N` commits N streaming events as one transaction halfway through.
 *
 * `--compare N` runs N alternating pairs of fresh processes (off/on, then on/off) and prints the
 * medians. With `--base-ref`, the "off" side loads the server sources of that commit (through
 * streaming-sqlite-revision.ts), so it measures the code before the worker existed.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { Duration, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../src/orchestration/Services/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";
import { SqliteReadClient } from "../src/persistence/SqliteReadClient.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";
import { RepositoryIdentityResolver } from "../src/project/Services/RepositoryIdentityResolver.ts";

const { values: args } = parseArgs({
  options: {
    worker: { type: "string" },
    base: { type: "string" },
    commits: { type: "string", default: "3000" },
    pace: { type: "string", default: "10" },
    threads: { type: "string", default: "3" },
    reader: { type: "boolean", default: false },
    "big-txn": { type: "string", default: "0" },
    json: { type: "string" },
    compare: { type: "string" },
    "base-ref": { type: "string" },
  },
});

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const median = (values: ReadonlyArray<number>) =>
  percentile(
    [...values].toSorted((a, b) => a - b),
    0.5,
  );
const round = (value: number, digits = 3) => Number(value.toFixed(digits));

if (args.base === undefined) throw new Error("--base <state.sqlite> is required");
const base = resolve(args.base);

// ---------------------------------------------------------------------------------------------
// --compare: alternating fresh processes, medians.
// ---------------------------------------------------------------------------------------------
if (args.compare !== undefined) {
  const pairs = Number(args.compare);
  if (!Number.isSafeInteger(pairs) || pairs < 1) throw new Error("--compare needs a pair count");
  const passthrough = [
    "--base",
    base,
    "--commits",
    args.commits,
    "--pace",
    args.pace,
    "--threads",
    args.threads,
    "--big-txn",
    args["big-txn"],
    ...(args.reader ? ["--reader"] : []),
  ];
  const runs: Array<Record<string, any>> = [];
  const runOne = (worker: "on" | "off") => {
    const fromBase = worker === "off" && args["base-ref"] !== undefined;
    const stdout = execFileSync(
      process.execPath,
      [
        ...(fromBase
          ? ["--import", join(repoRoot, "apps/server/scripts/streaming-sqlite-revision.ts")]
          : []),
        scriptPath,
        "--worker",
        worker,
        ...passthrough,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...(fromBase ? { RYCO_SQLITE_FIXTURE_REF: args["base-ref"] } : {}),
        },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, any>;
    result.source = fromBase ? `base ${args["base-ref"]}` : "working tree";
    runs.push(result);
    console.error(
      `${worker}: inline ${result.inline.n} commits ${result.inline.sumMs} ms, p50 ${result.commitMs.p50} ms, p99 ${result.commitMs.p99} ms, >16 ms ${result.over16}`,
    );
  };
  for (let pair = 0; pair < pairs; pair += 1) {
    for (const worker of pair % 2 === 0 ? (["off", "on"] as const) : (["on", "off"] as const)) {
      runOne(worker);
    }
  }
  const metric = (worker: boolean, read: (run: Record<string, any>) => number) =>
    round(median(runs.filter((run) => run.worker === worker).map(read)));
  const rows: Array<[string, (run: Record<string, any>) => number]> = [
    ["inline checkpoint commits / 1k", (run) => run.per1000.inlineCommits],
    ["inline commit ms / 1k", (run) => run.per1000.inlineSumMs],
    ["inline ms above median / 1k", (run) => run.per1000.inlineEstMs],
    ["commits > 5 ms / 1k", (run) => run.per1000.over5],
    ["commits > 16 ms / 1k", (run) => run.per1000.over16],
    ["commit mean ms (main-thread time per commit)", (run) => run.commitMs.mean],
    ["commit p50 ms", (run) => run.commitMs.p50],
    ["commit p99 ms", (run) => run.commitMs.p99],
    ["commit p999 ms", (run) => run.commitMs.p999],
    ["commit max ms", (run) => run.commitMs.max],
    ["loop delay p99 ms", (run) => run.loop.delayP99Ms],
    ["loop delay max ms", (run) => run.loop.delayMaxMs],
    ["loop max gap ms", (run) => run.loop.maxGapMs],
    ["WAL bytes at end", (run) => run.wal.endBytes],
    ["WAL bytes max", (run) => run.wal.maxBytes],
    ["RSS MiB at end", (run) => run.rssMiB],
    ["reader catch-up ms (median)", (run) => median(run.reader?.catchUpMs ?? [])],
    ["big transaction ms", (run) => run.bigTxn?.ms ?? 0],
  ];
  const summary = Object.fromEntries(
    rows.map(([name, read]) => [name, { off: metric(false, read), on: metric(true, read) }]),
  );
  console.table(summary);
  const document = {
    methodology:
      "Sequential alternating fresh processes (off/on, then on/off); medians over runs per mode",
    options: { ...args, base },
    summary,
    runs,
  };
  if (args.json !== undefined) writeFileSync(args.json, `${JSON.stringify(document, null, 2)}\n`);
  else console.log(JSON.stringify(document));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// One run.
// ---------------------------------------------------------------------------------------------
if (args.worker !== "on" && args.worker !== "off") throw new Error("--worker on|off is required");
const workerOn = args.worker === "on";
const commits = Number(args.commits);
const threads = Number(args.threads);
const bigTxnEvents = Number(args["big-txn"]);
const pace = args.pace;
if (!Number.isSafeInteger(commits) || commits < 1) throw new Error("--commits must be positive");
if (!Number.isSafeInteger(threads) || threads < 1) throw new Error("--threads must be positive");
if (pace !== "tight" && pace !== "burst" && !(Number(pace) >= 0)) {
  throw new Error("--pace must be tight, burst or a number of milliseconds");
}
try {
  if (statSync(`${base}-wal`).size > 0) {
    throw new Error(`${base}-wal is not empty: stop the process that owns it first`);
  }
} catch (cause) {
  if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
}

/** A full byte copy (no APFS clone: a clone makes the first page writes slower). */
const copyFile = (from: string, to: string) => {
  const input = openSync(from, "r");
  const output = openSync(to, "w");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) break;
      writeSync(output, buffer, 0, read);
    }
  } finally {
    closeSync(input);
    closeSync(output);
  }
};

const directory = mkdtempSync(join(tmpdir(), "ryco-checkpoint-measure-"));
const filename = join(directory, "state.sqlite");
copyFile(base, filename);
const walPath = `${filename}-wal`;
const walBytes = () => {
  try {
    return statSync(walPath).size;
  } catch {
    return 0;
  }
};

const layer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provideMerge(OrchestrationEventStoreLive),
  // "on" forces the worker also where it is off by default (macOS), to measure it there.
  Layer.provideMerge(
    makeSqlitePersistenceLive(filename, {
      checkpointWorker: workerOn ? { anyPlatform: true } : false,
    }),
  ),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "ryco-checkpoint-measure-config-" }),
  ),
  Layer.provide(
    Layer.succeed(ProjectAvatarStore, {
      write: () => Effect.die("unused"),
      read: () => Effect.succeed(null),
      remove: () => Effect.void,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const wait = (ms: number) =>
  Effect.promise(() => new Promise<void>((done) => setTimeout(done, ms)));
const yieldToLoop = Effect.promise(() => new Promise<void>((done) => setImmediate(done)));

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reader = yield* SqliteReadClient;
  const store = yield* OrchestrationEventStore;
  const pipeline = yield* OrchestrationProjectionPipeline;
  const walCheckpointStats = (sql as { readonly walCheckpointStats?: () => unknown })
    .walCheckpointStats;
  const [version] = yield* sql<{ readonly version: string }>`SELECT sqlite_version() AS version`;
  const sqliteVersion = version?.version ?? "";
  const [major = 0, minor = 0] = sqliteVersion.split(".").map(Number);
  // Before 3.51, wal_checkpoint(NOOP) runs as PASSIVE and would checkpoint on every probe.
  if (major < 3 || (major === 3 && minor < 51)) {
    throw new Error(`SQLite ${sqliteVersion} has no wal_checkpoint(NOOP)`);
  }
  const [setting] = yield* sql<{ readonly wal_autocheckpoint: number }>`PRAGMA wal_autocheckpoint`;
  const autocheckpoint = setting?.wal_autocheckpoint ?? 1000;
  const frames = Effect.map(
    sql.unsafe<{ readonly log: number; readonly checkpointed: number }>(
      "PRAGMA wal_checkpoint(NOOP)",
    ),
    (rows) => rows[0]!,
  );

  const now = new Date().toISOString();
  const run = Math.random().toString(36).slice(2, 8);
  const projectId = ProjectId.make(`checkpoint-measure-${run}`);
  const threadIds = Array.from({ length: threads }, (_, index) =>
    ThreadId.make(`checkpoint-measure-${run}-${index}`),
  );
  let eventSerial = 0;
  const append = (event: Pick<OrchestrationEvent, "type" | "payload">) =>
    Effect.gen(function* () {
      const key = `checkpoint-measure-${run}-${++eventSerial}`;
      const persisted = yield* store.append({
        ...event,
        eventId: EventId.make(key),
        aggregateKind: event.type === "project.created" ? "project" : "thread",
        aggregateId:
          event.type === "project.created"
            ? projectId
            : (event.payload as { readonly threadId: ThreadId }).threadId,
        occurredAt: new Date().toISOString(),
        commandId: CommandId.make(key),
        causationEventId: null,
        correlationId: CommandId.make(key),
        metadata: {},
      } as Parameters<typeof store.append>[0]);
      return yield* pipeline.projectEventInTransaction(persisted);
    });
  const apply = (event: Pick<OrchestrationEvent, "type" | "payload">) =>
    sql.withTransaction(append(event)).pipe(Effect.flatMap((postCommit) => postCommit));

  yield* apply({
    type: "project.created",
    payload: {
      projectId,
      title: "Checkpoint measure",
      workspaceRoot: directory,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const threadId of threadIds) {
    yield* apply({
      type: "thread.created",
      payload: {
        threadId,
        projectId,
        title: "Checkpoint measure",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  const delta = "0123456789abcdefghij0123456789abcdefghij".repeat(103).slice(0, 4096);
  const detail = "ran the command and read the output; ".repeat(40);
  const batches = Array.from({ length: threads }, () => 0);
  const messageIndex = Array.from({ length: threads }, () => 0);
  const eventFor = (index: number): Pick<OrchestrationEvent, "type" | "payload"> => {
    const thread = index % threads;
    const threadId = threadIds[thread]!;
    const at = new Date().toISOString();
    if (index % 10 === 9) {
      return {
        type: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            id: EventId.make(`checkpoint-measure-${run}-activity-${index}`),
            tone: "tool",
            kind: "tool.completed",
            summary: "Ran command",
            payload: { itemType: "command_execution", title: "Ran command", detail },
            turnId: null,
            createdAt: at,
          },
        },
      } as Pick<OrchestrationEvent, "type" | "payload">;
    }
    const complete = batches[thread]! > 0 && batches[thread]! % 50 === 0;
    const messageId = MessageId.make(`${threadId}-message-${messageIndex[thread]}`);
    if (complete) messageIndex[thread]! += 1;
    batches[thread]! += 1;
    return {
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId,
        role: "assistant",
        text: complete ? "" : delta,
        turnId: null,
        streaming: !complete,
        createdAt: at,
        updatedAt: at,
      },
    } as Pick<OrchestrationEvent, "type" | "payload">;
  };

  // Settle setup writes so every run starts from the same WAL state.
  yield* wait(500);

  const readerCycles: Array<{ readonly endedAt: number; caughtUpAt?: number; walBytes: number }> =
    [];
  let readerFiber: Fiber.Fiber<never, SqlError> | undefined;
  if (args.reader) {
    const hold = Effect.gen(function* () {
      for (;;) {
        yield* wait(3_000);
        yield* reader.withTransaction(
          Effect.gen(function* () {
            yield* reader`SELECT sequence FROM orchestration_events ORDER BY sequence DESC LIMIT 1`;
            yield* wait(2_000);
          }),
        );
        readerCycles.push({ endedAt: performance.now(), walBytes: walBytes() });
      }
    });
    readerFiber = yield* Effect.forkDetach(hold);
  }

  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  let lastTick = performance.now();
  let maxGapMs = 0;
  const ticker = setInterval(() => {
    const tick = performance.now();
    maxGapMs = Math.max(maxGapMs, tick - lastTick);
    lastTick = tick;
  }, 1);

  const latencies: number[] = [];
  const inline: number[] = [];
  let maxWalBytes = walBytes();
  let previousLog = (yield* frames).log;
  let bigTxn: { events: number; ms: number; framesBefore: number; framesAfter: number } | undefined;
  const startedAt = performance.now();
  for (let index = 0; index < commits; index += 1) {
    if (bigTxnEvents > 0 && index === Math.floor(commits / 2)) {
      const before = (yield* frames).log;
      const bigStartedAt = performance.now();
      const postCommits = yield* sql.withTransaction(
        Effect.gen(function* () {
          const effects: Array<Effect.Effect<void>> = [];
          for (let event = 0; event < bigTxnEvents; event += 1) {
            effects.push(yield* append(eventFor(index * 1_000_000 + event * 10)));
          }
          return effects;
        }),
      );
      yield* Effect.forEach(postCommits, (postCommit) => postCommit, { discard: true });
      const ms = performance.now() - bigStartedAt;
      const after = yield* frames;
      bigTxn = {
        events: bigTxnEvents,
        ms: round(ms, 1),
        framesBefore: before,
        framesAfter: after.log,
      };
      previousLog = after.log;
    }
    const commitStartedAt = performance.now();
    yield* apply(eventFor(index));
    const elapsed = performance.now() - commitStartedAt;
    latencies.push(elapsed);
    const state = yield* frames;
    // The commit left at least `wal_autocheckpoint` frames: SQLite checkpointed inside it.
    if (state.log >= autocheckpoint) inline.push(elapsed);
    if (state.log < previousLog) {
      for (const cycle of readerCycles) cycle.caughtUpAt ??= performance.now();
    }
    previousLog = state.log;
    if (index % 25 === 0) maxWalBytes = Math.max(maxWalBytes, walBytes());
    if (pace === "tight") yield* yieldToLoop;
    else if (pace === "burst") yield* wait(index % 40 === 39 ? 250 : 1);
    else yield* wait(Number(pace));
  }
  const totalMs = performance.now() - startedAt;
  clearInterval(ticker);
  histogram.disable();
  if (readerFiber !== undefined) yield* Fiber.interrupt(readerFiber);
  const endWalBytes = walBytes();
  maxWalBytes = Math.max(maxWalBytes, endWalBytes);

  const sorted = latencies.toSorted((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const over5 = sorted.filter((value) => value > 5).length;
  const over16 = sorted.filter((value) => value > 16).length;
  const inlineSum = inline.reduce((sum, value) => sum + value, 0);
  const inlineEst = inline.reduce((sum, value) => sum + Math.max(0, value - p50), 0);
  const perThousand = (value: number) => round((value / commits) * 1000, 2);
  return {
    runtime: process.version,
    electron: process.versions.electron ?? null,
    platform: `${process.platform}-${process.arch}`,
    sqlite: sqliteVersion,
    worker: workerOn,
    walAutocheckpoint: autocheckpoint,
    pace,
    threads,
    commits,
    baseBytes: statSync(base).size,
    loadavg: loadavg().map((value) => round(value, 2)),
    totalMs: round(totalMs, 0),
    commitMs: {
      mean: round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      p50: round(p50),
      p99: round(percentile(sorted, 0.99)),
      p999: round(percentile(sorted, 0.999)),
      max: round(sorted.at(-1) ?? 0, 2),
    },
    over5,
    over16,
    loop: {
      delayP99Ms: round(histogram.percentile(99) / 1e6, 2),
      delayMaxMs: round(histogram.max / 1e6, 2),
      maxGapMs: round(maxGapMs, 1),
    },
    inline: {
      n: inline.length,
      sumMs: round(inlineSum, 1),
      estMs: round(inlineEst, 1),
      maxMs: round(Math.max(0, ...inline), 2),
    },
    per1000: {
      inlineCommits: perThousand(inline.length),
      inlineSumMs: perThousand(inlineSum),
      inlineEstMs: perThousand(inlineEst),
      over5: perThousand(over5),
      over16: perThousand(over16),
    },
    walCheckpointStats: walCheckpointStats?.() ?? null,
    wal: { endBytes: endWalBytes, maxBytes: maxWalBytes },
    reader: args.reader
      ? {
          cycles: readerCycles.length,
          walBytesAtEnd: readerCycles.map((cycle) => cycle.walBytes),
          catchUpMs: readerCycles
            .filter((cycle) => cycle.caughtUpAt !== undefined)
            .map((cycle) => round(cycle.caughtUpAt! - cycle.endedAt, 1)),
        }
      : null,
    bigTxn: bigTxn ?? null,
    rssMiB: round(process.memoryUsage().rss / 1024 / 1024, 1),
  };
});

try {
  const result = await Effect.runPromise(
    program.pipe(Effect.provide(layer), Effect.timeout(Duration.minutes(30))),
  );
  const line = JSON.stringify(result);
  if (args.json !== undefined) writeFileSync(args.json, `${line}\n`);
  console.log(line);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
