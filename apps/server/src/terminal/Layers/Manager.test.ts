import * as SqlClient from "effect/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import path from "node:path";
import { writeFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  PROJECT_RELOCATION_PENDING_MESSAGE,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@ryco/contracts";
import {
  Duration,
  Effect,
  Deferred,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Ref,
  Schedule,
  Scope,
  Queue,
} from "effect";
import { Base64Url } from "effect/encoding";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { makeWorkspaceAccessPolicy } from "../../workspace/Layers/WorkspaceAccessPolicy.ts";
import type { TerminalManagerShape } from "../Services/Manager.ts";
import {
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY.ts";
import { createWorkspaceCommitFence } from "../../orchestration/workspaceCommitFence.ts";
import { storageLifecycleLock } from "../../storage/lifecycle.ts";
import { createEmptyReadModel } from "../../orchestration/projector.ts";
import { makeProcfsProcessTableSnapshotter, makeTerminalManagerWithOptions } from "./Manager.ts";
import {
  makeTerminalSubscriberOffer,
  releaseTerminalSubscriberEvent,
} from "../../ws/terminalRpc.ts";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  /** Present only on PTYs that can name their foreground process. */
  foregroundProcessName?: () => string | undefined;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  /** By pid: spawned PTYs with an entry can name their foreground process. */
  readonly foregroundReaders = new Map<number, () => string | undefined>();
  private readonly mode: "sync" | "async";
  private nextPid = 9000;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    const foregroundReader = this.foregroundReaders.get(process.pid);
    if (foregroundReader) process.foregroundProcessName = foregroundReader;
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

/** Holds each spawn until the test opens its gate, after signalling that it was reached. */
class GatedPtyAdapter extends FakePtyAdapter {
  entered = Deferred.makeUnsafe<void>();
  gate = Deferred.makeUnsafe<void>();

  override spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    return Deferred.succeed(this.entered, undefined).pipe(
      Effect.andThen(Deferred.await(this.gate)),
      Effect.andThen(Effect.suspend(() => super.spawn(input))),
    );
  }

  rearm(): void {
    this.entered = Deferred.makeUnsafe<void>();
    this.gate = Deferred.makeUnsafe<void>();
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, Error | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new Error("Condition not met"),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () => Effect.fail(new Error("Timed out waiting for condition")),
        onSome: () => Effect.void,
      }),
    ),
  );

/** The `hasRunningSubprocess` values of a thread's activity events, in order. */
const activityStates = (events: ReadonlyArray<TerminalEvent>, threadId = "thread-1") =>
  events.flatMap((event) =>
    event.type === "activity" && event.threadId === threadId ? [event.hasRunningSubprocess] : [],
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Base64Url.encode(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Base64Url.encode(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Base64Url.encode(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

interface CreateManagerOptions {
  shellResolver?: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  processTableSnapshotter?: (
    shellPids: ReadonlyArray<number>,
  ) => Effect.Effect<
    { readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>> },
    Error
  >;
  subprocessPollIntervalMs?: number;
  subprocessIdlePollIntervalMs?: number;
  historyPersistDebounceMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  maxPendingProcessEvents?: number;
  maxPendingProcessOutputBytes?: number;
  maxHistoryBytes?: number;
  ptyAdapter?: FakePtyAdapter;
  restrictToBaseDir?: boolean;
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManagerShape;
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-terminal-" });
      const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
      const workspaceAccessPolicy =
        options.restrictToBaseDir === true ? yield* makeWorkspaceAccessPolicy(baseDir) : undefined;

      const manager = yield* makeTerminalManagerWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(workspaceAccessPolicy !== undefined ? { workspaceAccessPolicy } : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.processTableSnapshotter !== undefined
          ? { processTableSnapshotter: options.processTableSnapshotter }
          : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        ...(options.subprocessIdlePollIntervalMs !== undefined
          ? { subprocessIdlePollIntervalMs: options.subprocessIdlePollIntervalMs }
          : {}),
        // Persistence cadence is covered by its own tests; fixtures keep writes prompt.
        historyPersistDebounceMs: options.historyPersistDebounceMs ?? 40,
        // Fake PTYs have no OS process to reap. Keep ordinary fixture teardown
        // immediate; shutdown timing is covered separately with TestClock.
        processKillGraceMs: options.processKillGraceMs ?? 0,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.maxPendingProcessEvents !== undefined
          ? { maxPendingProcessEvents: options.maxPendingProcessEvents }
          : {}),
        ...(options.maxPendingProcessOutputBytes !== undefined
          ? { maxPendingProcessOutputBytes: options.maxPendingProcessOutputBytes }
          : {}),
        ...(options.maxHistoryBytes !== undefined
          ? { maxHistoryBytes: options.maxHistoryBytes }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const scope = yield* Effect.scope;
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager", (it) => {
  it.effect("refuses terminal admission in a nested checkout after cleanup claims it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const f = yield* createManager();
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = path.join(f.baseDir, "checkout", "src");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      const checkout = yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.realpath(path.dirname(nested))),
      );
      yield* sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('terminal-guard', ${checkout}, 'worktree', '{}', ${new Date().toISOString()}, 'removing')`;
      const result = yield* f.manager
        .open({ threadId: "fixture-thread", cwd: nested, cols: 80, rows: 24 })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(f.ptyAdapter.spawnInputs.length, 0);
      const parentResult = yield* f.manager
        .open({ threadId: "parent-thread", cwd: f.baseDir, cols: 80, rows: 24 })
        .pipe(Effect.result);
      assert.strictEqual(parentResult._tag, "Failure");
      assert.strictEqual(f.ptyAdapter.spawnInputs.length, 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("refuses a terminal in a chat that is moving into a project, retryably", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const f = yield* createManager();
      const fileSystem = yield* FileSystem.FileSystem;
      const chat = path.join(f.baseDir, "chats", "2026-10-08-plan-0a1b2c3d");
      yield* fileSystem.makeDirectory(chat, { recursive: true });
      const canonical = yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.realpath(chat)),
      );
      yield* sql`INSERT INTO project_relocations (
          relocation_id, project_id, source_path, destination_path, strategy, state,
          destination_created, error, created_at, updated_at
        ) VALUES (
          'relocation-terminal', 'project-chat', ${canonical}, ${path.join(f.baseDir, "plan")},
          'rename', 'pending', 0, NULL, ${new Date().toISOString()}, ${new Date().toISOString()}
        )`;
      const error = yield* f.manager
        .open({ threadId: "chat-thread", cwd: chat, cols: 80, rows: 24 })
        .pipe(Effect.flip);
      // A reason every client decodes; the message says to retry.
      expect(error).toMatchObject({ _tag: "TerminalCwdError", reason: "statFailed" });
      expect(error.message).toContain(PROJECT_RELOCATION_PENDING_MESSAGE);
      assert.strictEqual(f.ptyAdapter.spawnInputs.length, 0);

      // The move settled: the fence lifts.
      yield* sql`UPDATE project_relocations SET state = 'done'`;
      yield* f.manager.open({ threadId: "chat-thread", cwd: chat, cols: 80, rows: 24 });
      assert.strictEqual(f.ptyAdapter.spawnInputs.length, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("refuses a relaunch into a fenced path before touching the running shell", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const f = yield* createManager();
      const fileSystem = yield* FileSystem.FileSystem;
      const current = path.join(f.baseDir, "current");
      const fenced = path.join(f.baseDir, "fenced");
      yield* fileSystem.makeDirectory(current, { recursive: true });
      yield* fileSystem.makeDirectory(fenced, { recursive: true });
      const canonical = yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.realpath(fenced)),
      );
      yield* f.manager.open(openInput({ cwd: current }));
      yield* sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('relaunch-guard', ${canonical}, 'worktree', '{}', ${new Date().toISOString()}, 'removing')`;

      const opened = yield* f.manager.open(openInput({ cwd: fenced })).pipe(Effect.flip);
      expect(opened).toMatchObject({ _tag: "TerminalCwdError", reason: "cleanupPending" });
      const restarted = yield* f.manager.restart(restartInput({ cwd: fenced })).pipe(Effect.flip);
      expect(restarted).toMatchObject({ _tag: "TerminalCwdError", reason: "cleanupPending" });

      expect(f.ptyAdapter.processes).toHaveLength(1);
      expect(f.ptyAdapter.processes[0]!.killed).toBe(false);
      expect(yield* f.manager.listDiagnostics).toEqual([
        expect.objectContaining({ status: "running", cwd: current }),
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("holds the storage lifecycle lock for admission only, not across the PTY spawn", () =>
    Effect.gen(function* () {
      const ptyAdapter = new GatedPtyAdapter();
      const { manager } = yield* createManager(5, { ptyAdapter });
      const lockIsFree = storageLifecycleLock
        .withPermit(Effect.void)
        .pipe(Effect.timeoutOption("1 second"), Effect.map(Option.isSome));

      for (const start of [
        manager.open(openInput()),
        manager.restart(restartInput()),
        manager.open(openInput({ env: { RELAUNCH: "1" } })),
      ]) {
        ptyAdapter.rearm();
        const starting = yield* start.pipe(Effect.forkScoped);
        yield* Deferred.await(ptyAdapter.entered);
        // Orchestration takes this lock for every command; a spawn must not stall it.
        expect(yield* lockIsFree).toBe(true);
        // Admission published the session as starting, so a lifecycle owner that
        // fences the path now sees a busy terminal there.
        expect((yield* manager.listDiagnostics).map((terminal) => terminal.status)).toEqual([
          "starting",
        ]);
        yield* Deferred.succeed(ptyAdapter.gate, undefined);
        expect((yield* Fiber.join(starting)).status).toBe("running");
      }
      expect(ptyAdapter.processes).toHaveLength(3);
    }),
  );
  it.effect(
    "orders restart behind in-flight output and rejects old PTY callbacks through exit",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        const initial = yield* manager.open(openInput());
        const old = ptyAdapter.processes[0]!;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const remove = yield* manager.subscribe((event) =>
          event.type === "output"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(remove));
        old.emitData("before");
        yield* Deferred.await(entered);
        old.emitData("pending before restart");
        const restarting = yield* manager.restart(restartInput()).pipe(Effect.forkScoped);
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(release, undefined);
        const restarted = yield* Fiber.join(restarting);
        expect(restarted.cursor?.generation).toBe(initial.cursor?.generation);
        expect(restarted.cursor!.sequence).toBeGreaterThan(initial.cursor!.sequence);
        old.emitData("stale");
        old.emitExit({ exitCode: 99, signal: 0 });
        const current = ptyAdapter.processes[1]!;
        current.emitData("after🙂");
        current.emitExit({ exitCode: 0, signal: 0 });
        yield* waitFor(
          Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        );
        const events = (yield* getEvents).filter((event) => event.type !== "activity");
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "output",
          "restarted",
          "output",
          "exited",
        ]);
        expect(
          events
            .filter((event) => event.type === "output")
            .map((event) => event.data)
            .join(""),
        ).toBe("beforeafter🙂");
        const final = (yield* manager.listSessions)[0]!;
        expect(final.history).toBe("after🙂");
        expect(final.cursor).toEqual(events.at(-1)?.cursor);
        const other = yield* createManager();
        const fresh = yield* other.manager.open(openInput());
        expect(fresh.cursor?.generation).not.toBe(initial.cursor?.generation);
      }),
  );
  it.effect("does not let clear overtake output already being delivered", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const observed: string[] = [];
      const removeBlocker = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      const removeObserver = yield* manager.subscribe((event) =>
        Effect.sync(() => {
          observed.push(event.type);
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          removeBlocker();
          removeObserver();
        }),
      );
      ptyAdapter.processes[0]!.emitData("before clear");
      yield* Deferred.await(entered);
      for (let i = 0; i < 200; i++) ptyAdapter.processes[0]!.emitData("pending before clear");
      const clearing = yield* manager.clear({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.sleep("150 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clearing);
      yield* waitFor(Effect.sync(() => observed.includes("output")));
      expect(observed).toEqual(["output", "cleared"]);
    }),
  );
  if (process.env.RYCO_TERMINAL_BENCHMARK_OUTPUT) {
    it.effect(
      "measures normal, throttled and stalled subscribers with a healthy peer",
      () =>
        Effect.gen(function* () {
          const samples: Array<Record<string, string | number | boolean>> = [];
          for (const profile of ["normal", "throttled", "stalled"] as const) {
            for (let iteration = 0; iteration < 7; iteration++) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const { manager, ptyAdapter } = yield* createManager(100_000);
                  yield* manager.open(openInput());
                  const pty = ptyAdapter.processes[0]!;
                  const queue = yield* Queue.dropping<
                    TerminalEvent,
                    | import("@ryco/contracts").TerminalSubscriptionResyncError
                    | import("effect").Cause.Done<void>
                  >(256);
                  const ledger = { bytes: 0 };
                  const offer = makeTerminalSubscriberOffer(queue, 256, ledger);
                  let highWaterBytes = 0;
                  let healthyBytes = 0;
                  let received = 0;
                  let slowBytes = 0;
                  let exited = false;
                  const latencies: number[] = [];
                  const sentAt: number[] = [];
                  const chunks = Array.from(
                    { length: 320 },
                    (_, index) => `${String(index).padStart(4, "0")}:` + "x".repeat(8186) + "\n",
                  );
                  const healthy: string[] = [];
                  const unsubscribe = yield* manager.subscribe((event) =>
                    Effect.gen(function* () {
                      yield* offer(event);
                      highWaterBytes = Math.max(highWaterBytes, ledger.bytes);
                      if (event.type === "output") {
                        if (
                          profile === "normal" ||
                          (profile === "throttled" && received % 16 === 15)
                        ) {
                          const count = profile === "normal" ? 1 : 4;
                          for (let n = 0; n < count; n++) {
                            const next = yield* Queue.take(queue);
                            yield* releaseTerminalSubscriberEvent(ledger, next);
                            if (next.type === "output") slowBytes += next.data.length;
                          }
                        }
                      }
                    }).pipe(Effect.ignore),
                  );
                  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
                  const unsubscribeHealthy = yield* manager.subscribe((event) =>
                    Effect.sync(() => {
                      if (event.type === "output") {
                        latencies.push(performance.now() - sentAt[received]!);
                        received++;
                        healthyBytes += event.data.length;
                        healthy.push(event.data);
                      }
                      if (event.type === "exited") exited = true;
                    }),
                  );
                  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeHealthy));
                  const started = performance.now();
                  for (const chunk of chunks) {
                    sentAt.push(performance.now());
                    pty.emitData(chunk);
                    yield* Effect.sleep("1 millis");
                  }
                  pty.emitExit({ exitCode: 0, signal: 0 });
                  yield* waitFor(
                    Effect.sync(() => exited),
                    "2 seconds",
                  );
                  expect(healthy.join("")).toBe(chunks.join(""));
                  expect(highWaterBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
                  latencies.sort((a, b) => a - b);
                  samples.push({
                    profile,
                    iteration: iteration + 1,
                    healthyBytes,
                    slowBytes,
                    highWaterBytes,
                    healthyP95Ms: latencies[Math.floor(latencies.length * 0.95)]!,
                    elapsedMs: performance.now() - started,
                    rssBytes: process.memoryUsage().rss,
                    exactHealthyOutput: true,
                    exitDelivered: exited,
                  });
                }),
              );
            }
          }
          writeFileSync(
            process.env.RYCO_TERMINAL_BENCHMARK_OUTPUT!,
            JSON.stringify(
              {
                workload:
                  "320 x 8192-byte PTY callbacks, 1 ms producer cadence; throttled drains 4 per 16 outputs; stalled never drains",
                boundary:
                  "real TerminalManager and subscriber offer; fake PTY, no network or renderer",
                samples,
              },
              null,
              2,
            ),
          );
        }),
      { timeout: 60_000 },
    );
  }
  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, "default");
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdError",
        cwd: blockedCwd,
        reason: "statFailed",
      });
    }),
  );

  it.effect("rejects terminal open and restart outside the configured workspace", () =>
    Effect.gen(function* () {
      const { manager, baseDir, ptyAdapter } = yield* createManager(5, {
        restrictToBaseDir: true,
      });
      const allowedCwd = path.join(baseDir, "project");
      yield* makeDirectory(allowedCwd);

      const openError = yield* manager.open(openInput({ cwd: process.cwd() })).pipe(Effect.flip);
      expect(openError).toMatchObject({
        _tag: "TerminalCwdError",
        cwd: process.cwd(),
        reason: "outsideWorkspace",
      });
      expect(ptyAdapter.spawnInputs).toHaveLength(0);

      yield* manager.open(openInput({ cwd: allowedCwd }));
      const restartError = yield* manager
        .restart({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: process.cwd(),
          cols: 100,
          rows: 24,
        })
        .pipe(Effect.flip);
      expect(restartError).toMatchObject({
        _tag: "TerminalCwdError",
        cwd: process.cwd(),
        reason: "outsideWorkspace",
      });
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect(
    "guards exact bracketed insertion against stale sessions, output, workspace and existing input",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const initial = yield* manager.open(openInput());
        const guard = {
          inputEpoch: initial.inputEpoch!,
          outputCursor: initial.cursor!,
          cwd: initial.cwd,
          worktreePath: initial.worktreePath,
        };
        const data = "\x1b[200~printf 'héllo 🌏'\n\tprintf '第二行'\n\x1b[201~";
        for (const invalid of [
          { ...guard, inputEpoch: "old-process" },
          { ...guard, cwd: "/synthetic/stale-worktree" },
          {
            ...guard,
            outputCursor: { ...guard.outputCursor, sequence: guard.outputCursor.sequence - 1 },
          },
        ]) {
          const error = yield* manager
            .write(
              {
                threadId: initial.threadId,
                terminalId: initial.terminalId,
                data,
                guard: invalid,
              },
              () => true,
            )
            .pipe(Effect.flip);
          assert.equal(error._tag, "TerminalInputRejectedError");
        }
        for (const invalid of [
          data + "\r",
          "printf 'unsafe'\n",
          "\x1b[200~a\x1b[201~\r\x1b[201~",
        ]) {
          const error = yield* manager
            .write(
              {
                threadId: initial.threadId,
                terminalId: initial.terminalId,
                data: invalid,
                guard,
              },
              () => true,
            )
            .pipe(Effect.flip);
          assert.equal(error._tag, "TerminalInputRejectedError");
        }
        expect(ptyAdapter.processes[0]!.writes).toEqual([]);
        yield* manager.write(
          {
            threadId: initial.threadId,
            terminalId: initial.terminalId,
            data,
            guard,
          },
          () => true,
        );
        expect(ptyAdapter.processes[0]!.writes).toEqual([data]);
        const duplicate = yield* manager
          .write(
            { threadId: initial.threadId, terminalId: initial.terminalId, data, guard },
            () => true,
          )
          .pipe(Effect.flip);
        assert.equal(duplicate._tag, "TerminalInputRejectedError");
        yield* manager.restart(restartInput());
        const stale = yield* manager
          .write(
            { threadId: initial.threadId, terminalId: initial.terminalId, data, guard },
            () => true,
          )
          .pipe(Effect.flip);
        assert.equal(stale._tag, "TerminalInputRejectedError");
        expect(ptyAdapter.processes[1]!.writes).toEqual([]);
        const current = yield* manager.open(openInput());
        yield* manager.write({
          threadId: current.threadId,
          terminalId: current.terminalId,
          data: "unfinished",
        });
        const busy = yield* manager
          .write(
            {
              threadId: current.threadId,
              terminalId: current.terminalId,
              data,
              guard: { ...guard, inputEpoch: current.inputEpoch!, outputCursor: current.cursor! },
            },
            () => true,
          )
          .pipe(Effect.flip);
        assert.equal(busy._tag, "TerminalInputRejectedError");
        expect(ptyAdapter.processes[1]!.writes).toEqual(["unfinished"]);
      }),
  );

  it.effect(
    "rejects canonical workspace changes during filesystem admission at the final input commit",
    () =>
      Effect.gen(function* () {
        for (const boundary of ["filesystem", "thread-lock"]) {
          const fs = yield* FileSystem.FileSystem;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let block = false;
          const controlledFs = {
            ...fs,
            stat: (file: string) =>
              block && file === process.cwd()
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(fs.stat(file)),
                  )
                : fs.stat(file),
          };
          const { manager, ptyAdapter } = yield* createManager().pipe(
            Effect.provideService(FileSystem.FileSystem, controlledFs),
          );
          const initial = yield* manager.open(openInput());
          let model = {
            ...createEmptyReadModel(new Date().toISOString()),
            threads: [
              {
                id: initial.threadId,
                projectId: "synthetic-project",
                worktreePath: null,
                deletedAt: null,
              },
            ],
            projects: [{ id: "synthetic-project", workspaceRoot: initial.cwd, deletedAt: null }],
          } as unknown as ReturnType<typeof createEmptyReadModel>;
          const fence = createWorkspaceCommitFence(() => model);
          const guard = {
            inputEpoch: initial.inputEpoch!,
            outputCursor: initial.cursor!,
            cwd: initial.cwd,
            worktreePath: null,
          };
          const canCommit = fence.capture({ threadId: initial.threadId, ...guard })!;
          block = true;
          const opening =
            boundary === "thread-lock"
              ? yield* manager.open(openInput()).pipe(Effect.forkScoped)
              : undefined;
          if (opening) yield* Deferred.await(entered);
          const writing = yield* manager
            .write(
              { threadId: initial.threadId, data: "\x1b[200~printf 'a'\x1b[201~", guard },
              canCommit,
            )
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Effect.yieldNow;
          fence.begin([{ type: "project.meta-updated" }]);
          model = {
            ...model,
            projects: [{ ...model.projects[0]!, workspaceRoot: "/synthetic/new-workspace" }],
          };
          fence.publish();
          yield* Deferred.succeed(release, undefined);
          if (opening) yield* Fiber.join(opening);
          const result = yield* Fiber.join(writing);
          expect(Exit.isFailure(result)).toBe(true);
          expect(ptyAdapter.processes[0]!.writes).toEqual([]);
          // The failed guarded write leaves ordinary manual terminal semantics intact.
          yield* manager.write({ threadId: initial.threadId, data: "manual" });
          expect(ptyAdapter.processes[0]!.writes).toEqual(["manual"]);
        }
      }),
  );
  it.effect(
    "rejects paste when the shell output changed after its bracketed-paste state was reviewed",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const initial = yield* manager.open(openInput());
        ptyAdapter.processes[0]!.emitData("\x1b[?2004l");
        const error = yield* manager
          .write(
            {
              threadId: initial.threadId,
              terminalId: initial.terminalId,
              data: "\x1b[200~printf 'a'\x1b[201~",
              guard: {
                inputEpoch: initial.inputEpoch!,
                outputCursor: initial.cursor!,
                cwd: initial.cwd,
                worktreePath: null,
              },
            },
            () => true,
          )
          .pipe(Effect.flip);
        assert.equal(error._tag, "TerminalInputRejectedError");
        expect(ptyAdapter.processes[0]!.writes).toEqual([]);
      }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(Effect.map(readFileString(historyLogPath(logsDir)), (text) => text === ""));

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === "default",
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(Effect.map(readFileString(historyLogPath(logsDir)), (text) => text === ""));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(yield* readFileString(historyLogPath(logsDir))).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect(
    "emits subprocess activity and refuses guarded insertion into a running subprocess",
    () =>
      Effect.gen(function* () {
        let hasRunningSubprocess = false;
        const { manager, getEvents, ptyAdapter } = yield* createManager(5, {
          processTableSnapshotter: () =>
            Effect.succeed({
              childrenByParent: hasRunningSubprocess
                ? new Map([[9000, [100]]])
                : new Map<number, number[]>(),
            }),
          subprocessPollIntervalMs: 20,
        });

        yield* manager.open(openInput());
        expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

        hasRunningSubprocess = true;
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some(
              (event) => event.type === "activity" && event.hasRunningSubprocess === true,
            ),
          ),
          "1200 millis",
        );

        const active = yield* manager.open(openInput());
        const rejected = yield* manager
          .write(
            {
              threadId: active.threadId,
              terminalId: active.terminalId,
              data: "\x1b[200~printf 'a'\x1b[201~",
              guard: {
                inputEpoch: active.inputEpoch!,
                outputCursor: active.cursor!,
                cwd: active.cwd,
                worktreePath: active.worktreePath,
              },
            },
            () => true,
          )
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "TerminalInputRejectedError");
        expect(ptyAdapter.processes[0]!.writes).toEqual([]);
        hasRunningSubprocess = false;
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some(
              (event) => event.type === "activity" && event.hasRunningSubprocess === false,
            ),
          ),
          "1200 millis",
        );
      }),
  );

  it.effect("types requireIdle input only into a shell a fresh process-table read finds idle", () =>
    Effect.gen(function* () {
      const reads: Array<ReadonlyArray<number>> = [];
      let children: ReadonlyArray<number> = [];
      let failRead = false;
      const { manager, ptyAdapter } = yield* createManager(5, {
        processTableSnapshotter: (shellPids) => {
          reads.push(shellPids);
          return failRead
            ? Effect.fail(new Error("simulated process snapshot failure"))
            : Effect.succeed({ childrenByParent: new Map([[9000, children]]) });
        },
        // Polling must not stand in for the write's own read.
        subprocessPollIntervalMs: 60_000,
        subprocessIdlePollIntervalMs: 60_000,
      });
      const idleWrite = (data: string) =>
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data,
          requireIdle: true,
        });
      const busyReason = (data: string) =>
        idleWrite(data).pipe(
          Effect.flip,
          Effect.map((error) => (error._tag === "TerminalBusyError" ? error.reason : error._tag)),
        );
      const settleInput = TestClock.adjust("500 millis");

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const readsBefore = reads.length;
      // Nothing typed can run in a shell without input: like a fresh terminal, no read.
      yield* idleWrite("first\r");
      assert.equal(reads.length, readsBefore);

      yield* settleInput;
      yield* idleWrite("second\r");
      assert.deepEqual(reads.slice(readsBefore), [[9000]]);

      yield* settleInput;
      children = [4242];
      assert.equal(yield* busyReason("vim-input\r"), "running");
      children = [];

      yield* settleInput;
      failRead = true;
      assert.equal(yield* busyReason("unverifiable\r"), "unverified");
      failRead = false;

      // Enter typed just before: the shell may not have forked its command yet.
      yield* manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "x" });
      const readsBeforeRace = reads.length;
      assert.equal(yield* busyReason("raced\r"), "inputRaced");
      assert.equal(reads.length, readsBeforeRace);
      yield* TestClock.adjust("499 millis");
      assert.equal(yield* busyReason("still-raced\r"), "inputRaced");
      yield* TestClock.adjust("1 millis");
      yield* idleWrite("third\r");

      expect(process.writes).toEqual(["first\r", "second\r", "x", "third\r"]);
      assert.deepEqual(reads.slice(readsBefore), [[9000], [9000], [9000], [9000]]);

      // An ended shell is never verified idle, and the input is refused, not dropped.
      process.emitExit({ exitCode: 0, signal: 0 });
      assert.equal(yield* busyReason("after-exit\r"), "unverified");
      expect(process.writes).toEqual(["first\r", "second\r", "x", "third\r"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not count focus reports or query replies as input for requireIdle", () =>
    Effect.gen(function* () {
      const reads: Array<ReadonlyArray<number>> = [];
      const { manager, ptyAdapter } = yield* createManager(5, {
        processTableSnapshotter: (shellPids) => {
          reads.push(shellPids);
          return Effect.succeed({ childrenByParent: new Map<number, number[]>() });
        },
        subprocessPollIntervalMs: 60_000,
        subprocessIdlePollIntervalMs: 60_000,
      });
      const write = (data: string, requireIdle?: true) =>
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data,
          ...(requireIdle ? { requireIdle } : {}),
        });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const readsBefore = reads.length;
      // A fresh fish answers its DA1 query and reports focus: still a shell without input.
      yield* write("\u001b[?1;2c");
      yield* write("\u001b[I");
      yield* write("first\r", true);
      assert.equal(reads.length, readsBefore);

      // Running a script blurs and refocuses the terminal right before its write.
      yield* TestClock.adjust("500 millis");
      yield* write("\u001b[O");
      yield* write("\u001b[I\u001b[?2026;2$y");
      yield* write("second\r", true);
      assert.deepEqual(reads.slice(readsBefore), [[9000]]);

      expect(process.writes).toEqual([
        "\u001b[?1;2c",
        "\u001b[I",
        "first\r",
        "\u001b[O",
        "\u001b[I\u001b[?2026;2$y",
        "second\r",
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("holds other input to the thread until a requireIdle write is done", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateReads = false;
      const { manager, ptyAdapter } = yield* createManager(5, {
        processTableSnapshotter: () =>
          gateReads
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ childrenByParent: new Map<number, number[]>() }),
              )
            : Effect.succeed({ childrenByParent: new Map<number, number[]>() }),
        subprocessPollIntervalMs: 60_000,
        subprocessIdlePollIntervalMs: 60_000,
      });
      yield* manager.open(openInput());
      yield* manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "ls\r" });
      yield* TestClock.adjust("500 millis");
      const process = ptyAdapter.processes[0]!;

      gateReads = true;
      const command = yield* manager
        .write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "bun dev\r",
          requireIdle: true,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const keystroke = yield* manager
        .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "y" })
        .pipe(Effect.forkScoped);
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
      // The keystroke waits on the thread lock: it cannot land between the read and the write.
      expect(process.writes).toEqual(["ls\r"]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(command);
      yield* Fiber.join(keystroke);
      expect(process.writes).toEqual(["ls\r", "bun dev\r", "y"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reads a foreground command as busy for requireIdle input", () =>
    Effect.gen(function* () {
      let foreground = "zsh";
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.foregroundReaders.set(9000, () => foreground);
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "/bin/zsh",
        processTableSnapshotter: () =>
          Effect.succeed({ childrenByParent: new Map<number, number[]>() }),
        subprocessPollIntervalMs: 1_000,
      });
      const tick = Effect.gen(function* () {
        yield* TestClock.adjust("1000 millis");
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
      });
      yield* manager.open(openInput());
      // Polls learn the name the shell goes by while the table finds it idle.
      yield* tick;
      yield* manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "x" });
      yield* tick;

      // `exec vim`: no child for the table to find, but another name in the foreground.
      foreground = "vim";
      const error = yield* manager
        .write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "bun dev\r",
          requireIdle: true,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag === "TerminalBusyError" ? error.reason : error._tag, "running");
      expect(ptyAdapter.processes[0]!.writes).toEqual(["x"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      const { manager } = yield* createManager(5, {
        processTableSnapshotter: () => {
          snapshots += 1;
          return Effect.succeed({ childrenByParent: new Map() });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(snapshots, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => snapshots > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("derives activity for multiple terminals from one process-table snapshot", () =>
    Effect.gen(function* () {
      let snapshotCalls = 0;
      let recordSnapshots = false;
      const { manager, getEvents } = yield* createManager(5, {
        processTableSnapshotter: () => {
          if (recordSnapshots) snapshotCalls += 1;
          return Effect.succeed({
            childrenByParent: recordSnapshots
              ? new Map([
                  [9000, [100]],
                  [9001, [200]],
                ])
              : new Map<number, number[]>(),
          });
        },
        subprocessPollIntervalMs: 1_000,
      });

      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));

      // The initial wake-up may race the second open. Start counting after it
      // has completed, when both running terminals are present for one tick.
      yield* TestClock.adjust("50 millis");
      recordSnapshots = true;
      yield* TestClock.adjust("1000 millis");
      const activeThreads = new Set(
        (yield* getEvents)
          .filter((event) => event.type === "activity" && event.hasRunningSubprocess === true)
          .map((event) => event.threadId),
      );
      expect(activeThreads).toEqual(new Set(["thread-1", "thread-2"]));
      assert.equal(snapshotCalls, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps last known activity when process-table enumeration fails", () =>
    Effect.gen(function* () {
      let failSnapshot = false;
      let failedSnapshots = 0;
      const { manager, getEvents } = yield* createManager(5, {
        processTableSnapshotter: () => {
          if (failSnapshot) {
            failedSnapshots += 1;
            return Effect.fail(new Error("simulated process snapshot failure"));
          }
          return Effect.succeed({
            childrenByParent: new Map([[9000, [100]]]),
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
        ),
        "1200 millis",
      );

      failSnapshot = true;
      yield* waitFor(
        Effect.sync(() => failedSnapshots >= 2),
        "1200 millis",
      );

      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.length).toBeGreaterThan(0);
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("caps an over-limit history file in memory without rewriting it on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager(3);
      const stored = "line1\nline2\nline3\nline4\nline5\n";
      yield* makeDirectory(logsDir);
      yield* writeFileString(historyLogPath(logsDir), stored);

      const opened = yield* manager.open(openInput());
      assert.equal(opened.history, "line3\nline4\nline5\n");
      expect(yield* readFileString(historyLogPath(logsDir))).toBe(stored);
    }),
  );

  it.effect("persists output once per window with the latest history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, {
        historyPersistDebounceMs: 400,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      yield* waitFor(
        Effect.map(manager.listSessions, (sessions) =>
          sessions.some((session) => session.history === "first\n"),
        ),
      );
      process.emitData("second\n");
      yield* Effect.sleep("100 millis");
      // Still inside the window: nothing has been rewritten yet.
      expect(yield* pathExists(historyLogPath(logsDir))).toBe(false);
      yield* waitFor(
        Effect.map(readFileString(historyLogPath(logsDir)), (text) => text === "first\nsecond\n"),
        "2 seconds",
      );
    }),
  );

  it.effect("writes pending output through when the terminal exits", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        historyPersistDebounceMs: 60_000,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("last words\n");
      process.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      yield* waitFor(
        Effect.map(readFileString(historyLogPath(logsDir)), (text) => text === "last words\n"),
      );
    }),
  );

  it.effect("writes pending output through when the manager shuts down", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-terminal-" });
      const logsDir = path.join(baseDir, "logs");
      const ptyAdapter = new FakePtyAdapter();
      const managerScope = yield* Scope.make();
      const manager = yield* makeTerminalManagerWithOptions({
        logsDir,
        historyLineLimit: 5,
        ptyAdapter,
        historyPersistDebounceMs: 60_000,
        processKillGraceMs: 0,
      }).pipe(Scope.provide(managerScope));
      yield* manager.open(openInput());
      ptyAdapter.processes[0]?.emitData("unsaved\n");
      yield* waitFor(
        Effect.map(manager.listSessions, (sessions) =>
          sessions.some((session) => session.history === "unsaved\n"),
        ),
      );
      expect(yield* pathExists(historyLogPath(logsDir))).toBe(false);

      yield* Scope.close(managerScope, Exit.void);
      expect(yield* readFileString(historyLogPath(logsDir))).toBe("unsaved\n");
    }),
  );

  it.effect("polls the process table at the idle cadence once terminals go quiet", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      const { manager } = yield* createManager(5, {
        processTableSnapshotter: () =>
          Effect.sync(() => {
            snapshots += 1;
            return { childrenByParent: new Map<number, number[]>() };
          }),
        subprocessPollIntervalMs: 1_000,
        subprocessIdlePollIntervalMs: 5_000,
      });
      yield* manager.open(openInput());
      const tick = Effect.gen(function* () {
        yield* TestClock.adjust("1000 millis");
        yield* Effect.yieldNow;
      });
      // Let the start-up I/O window lapse.
      for (let index = 0; index < 6; index += 1) yield* tick;

      const idleStart = snapshots;
      for (let index = 0; index < 10; index += 1) yield* tick;
      expect(snapshots - idleStart).toBe(2);

      const activeStart = snapshots;
      for (let index = 0; index < 5; index += 1) {
        yield* manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "x" });
        yield* tick;
      }
      expect(snapshots - activeStart).toBe(5);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks once when output goes quiet instead of on every tick of output", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      const { manager, ptyAdapter } = yield* createManager(5, {
        processTableSnapshotter: () =>
          Effect.sync(() => {
            snapshots += 1;
            return { childrenByParent: new Map<number, number[]>() };
          }),
        subprocessPollIntervalMs: 1_000,
        subprocessIdlePollIntervalMs: 5_000,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const settle = Effect.gen(function* () {
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
      });
      const tick = (output?: string) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("900 millis");
          // Output right before the tick, as a chatty process produces it.
          if (output !== undefined) process.emitData(output);
          yield* settle;
          yield* TestClock.adjust("100 millis");
          yield* settle;
        });
      // Let the start-up window lapse.
      for (let index = 0; index < 6; index += 1) yield* tick();

      const busyStart = snapshots;
      for (let index = 0; index < 10; index += 1) yield* tick(`line ${index}\n`);
      // Only the idle sweep runs while output keeps flowing.
      expect(snapshots - busyStart).toBe(2);

      // The first tick after the output stopped checks once.
      const quietStart = snapshots;
      yield* tick();
      expect(snapshots - quietStart).toBe(1);
      yield* tick();
      yield* tick();
      expect(snapshots - quietStart).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reads a foreground command as running without a process table", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      let foreground: string | undefined = "bash";
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.foregroundReaders.set(9000, () => foreground);
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        // The shell goes by another name than the one it was started as.
        shellResolver: () => "/bin/sh",
        processTableSnapshotter: () => {
          snapshots += 1;
          return Effect.succeed({ childrenByParent: new Map<number, number[]>() });
        },
        subprocessPollIntervalMs: 20,
      });
      const activityIs = (expected: ReadonlyArray<boolean>) =>
        waitFor(
          Effect.map(getEvents, (events) => activityStates(events).join() === expected.join()),
          "1200 millis",
        );

      yield* manager.open(openInput());
      // The first polls ask the table, which finds the shell idle under the name it goes by.
      yield* waitFor(Effect.sync(() => snapshots >= 2));
      assert.deepEqual(activityStates(yield* getEvents), []);

      foreground = "sleep";
      yield* activityIs([true]);
      const askedWhileRunning = snapshots;
      yield* Effect.sleep("100 millis");
      assert.equal(snapshots, askedWhileRunning);

      foreground = "bash";
      yield* activityIs([true, false]);
    }),
  );

  it.effect("asks the process table while the shell itself stays in the foreground", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      let hasChild = false;
      const ptyAdapter = new FakePtyAdapter();
      // A background job, a nested shell and a script run by the shell's own interpreter all
      // leave the shell's name in the foreground.
      ptyAdapter.foregroundReaders.set(9000, () => "zsh");
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "/bin/zsh",
        processTableSnapshotter: () => {
          snapshots += 1;
          return Effect.succeed({
            childrenByParent: hasChild ? new Map([[9000, [100]]]) : new Map<number, number[]>(),
          });
        },
        subprocessPollIntervalMs: 20,
      });
      const activityIs = (expected: ReadonlyArray<boolean>) =>
        waitFor(
          Effect.map(getEvents, (events) => activityStates(events).join() === expected.join()),
          "1200 millis",
        );

      yield* manager.open(openInput());
      yield* waitFor(Effect.sync(() => snapshots >= 2));
      assert.deepEqual(activityStates(yield* getEvents), []);

      hasChild = true;
      yield* activityIs([true]);
      hasChild = false;
      yield* activityIs([true, false]);
    }),
  );

  it.effect("asks the process table about a terminal whose foreground cannot be read", () =>
    Effect.gen(function* () {
      let hasChild = false;
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.foregroundReaders.set(9000, () => {
        throw new Error("pty is gone");
      });
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        processTableSnapshotter: () =>
          Effect.succeed({
            childrenByParent: hasChild ? new Map([[9000, [100]]]) : new Map<number, number[]>(),
          }),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      yield* Effect.sleep("100 millis");
      hasChild = true;
      yield* waitFor(
        Effect.map(getEvents, (events) => activityStates(events).join() === "true"),
        "1200 millis",
      );
    }),
  );

  it.effect(
    "asks the process table only about terminals that cannot name a foreground command",
    () =>
      Effect.gen(function* () {
        let snapshotPids: Array<ReadonlyArray<number>> = [];
        let foreground = "zsh";
        const ptyAdapter = new FakePtyAdapter();
        // 9000 names its foreground, 9001 has the accessor but cannot tell, 9002 has none.
        ptyAdapter.foregroundReaders.set(9000, () => foreground);
        ptyAdapter.foregroundReaders.set(9001, () => undefined);
        const { manager, getEvents } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/bin/zsh",
          processTableSnapshotter: (shellPids) => {
            snapshotPids.push(shellPids);
            return Effect.succeed({
              childrenByParent: new Map([
                [9001, [100]],
                [9002, [200]],
              ]),
            });
          },
          subprocessPollIntervalMs: 20,
        });

        yield* manager.open(openInput({ threadId: "thread-1" }));
        yield* manager.open(openInput({ threadId: "thread-2" }));
        yield* manager.open(openInput({ threadId: "thread-3" }));
        // Until its idle name is known, 9000 is asked about like the others.
        yield* waitFor(
          Effect.sync(() => snapshotPids.filter((pids) => pids.includes(9000)).length >= 2),
        );
        foreground = "vim";
        yield* waitFor(
          Effect.map(getEvents, (events) => activityStates(events, "thread-1").join() === "true"),
          "1200 millis",
        );

        snapshotPids = [];
        yield* Effect.sleep("120 millis");
        expect(snapshotPids.length).toBeGreaterThan(0);
        expect(snapshotPids.every((pids) => !pids.includes(9000))).toBe(true);
        expect(snapshotPids.every((pids) => pids.includes(9001) && pids.includes(9002))).toBe(true);
      }),
  );

  it.effect("lets the process table correct a shell that replaced itself", () =>
    Effect.gen(function* () {
      let foreground = "bash";
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.foregroundReaders.set(9000, () => foreground);
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        processTableSnapshotter: () =>
          Effect.succeed({ childrenByParent: new Map<number, number[]>() }),
        subprocessPollIntervalMs: 1_000,
        subprocessIdlePollIntervalMs: 5_000,
      });
      yield* manager.open(openInput());
      const settle = Effect.gen(function* () {
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
      });
      const tick = Effect.gen(function* () {
        yield* TestClock.adjust("1000 millis");
        yield* settle;
      });
      // Let the start-up window lapse with the shell known as bash.
      for (let index = 0; index < 10; index += 1) yield* tick;
      assert.deepEqual(activityStates(yield* getEvents), []);

      // `exec zsh`: a new name in the foreground and still no children. Right after input the
      // new name reads as a command.
      foreground = "zsh";
      yield* manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "x" });
      yield* tick;
      assert.deepEqual(activityStates(yield* getEvents), [true]);

      // Once the fast window lapses, the idle cadence asks the table, which finds the shell
      // idle, and the new name is taken for the shell's from then on.
      for (let index = 0; index < 12; index += 1) yield* tick;
      assert.deepEqual(activityStates(yield* getEvents), [true, false]);
      for (let index = 0; index < 20; index += 1) yield* tick;
      assert.deepEqual(activityStates(yield* getEvents), [true, false]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("lengthens the idle cadence after a minute without input or output", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      const { manager } = yield* createManager(5, {
        processTableSnapshotter: () =>
          Effect.sync(() => {
            snapshots += 1;
            return { childrenByParent: new Map<number, number[]>() };
          }),
        subprocessPollIntervalMs: 1_000,
        subprocessIdlePollIntervalMs: 5_000,
      });
      yield* manager.open(openInput());
      const tick = Effect.gen(function* () {
        yield* TestClock.adjust("1000 millis");
        yield* Effect.yieldNow;
      });
      // Past the start-up I/O window and the minute that follows it.
      for (let index = 0; index < 65; index += 1) yield* tick;

      const deepIdleStart = snapshots;
      for (let index = 0; index < 60; index += 1) yield* tick;
      expect(snapshots - deepIdleStart).toBe(2);

      // Input restores the fast cadence on the next tick.
      const activeStart = snapshots;
      for (let index = 0; index < 5; index += 1) {
        yield* manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "x" });
        yield* tick;
      }
      expect(snapshots - activeStart).toBe(5);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the idle cadence while output keeps arriving", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      const { manager, ptyAdapter } = yield* createManager(5, {
        processTableSnapshotter: () =>
          Effect.sync(() => {
            snapshots += 1;
            return { childrenByParent: new Map<number, number[]>() };
          }),
        subprocessPollIntervalMs: 1_000,
        subprocessIdlePollIntervalMs: 5_000,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const settle = Effect.gen(function* () {
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
      });
      const tick = (output?: string) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("900 millis");
          if (output !== undefined) process.emitData(output);
          yield* settle;
          yield* TestClock.adjust("100 millis");
          yield* settle;
        });
      for (let index = 0; index < 70; index += 1) yield* tick(`line ${index}\n`);

      // A watcher printing every second never counts as quiet, minute after minute.
      const busyStart = snapshots;
      for (let index = 0; index < 10; index += 1) yield* tick(`more ${index}\n`);
      expect(snapshots - busyStart).toBe(2);

      // A minute of silence later, the terminal reaches the deep-idle cadence.
      for (let index = 0; index < 65; index += 1) yield* tick();
      const quietStart = snapshots;
      for (let index = 0; index < 60; index += 1) yield* tick();
      expect(snapshots - quietStart).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reads terminal subprocesses from procfs without a process table", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const procRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-procfs-" });
      const writeChildren = (pid: number, tid: number, children: string) =>
        Effect.gen(function* () {
          const taskDir = path.join(procRoot, String(pid), "task", String(tid));
          yield* fs.makeDirectory(taskDir, { recursive: true });
          yield* fs.writeFileString(path.join(taskDir, "children"), children);
        });
      yield* writeChildren(100, 100, "200 201 ");
      yield* writeChildren(100, 101, "202");
      yield* writeChildren(300, 300, "");

      const snapshot = yield* makeProcfsProcessTableSnapshotter(fs, procRoot)([100, 300, 400]);
      // 300 has no children; 400 already exited.
      expect([...snapshot.childrenByParent.entries()]).toEqual([[100, [200, 201, 202]]]);
    }),
  );

  it.effect("appends each window's output to the history file instead of rewriting it", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(100);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const filePath = historyLogPath(logsDir);

      process.emitData("first\n");
      yield* waitFor(Effect.map(readFileString(filePath), (text) => text === "first\n"));
      // A rewrite would drop this marker; an append keeps it.
      yield* writeFileString(filePath, "marker\nfirst\n");
      process.emitData("second\n");
      yield* waitFor(
        Effect.map(readFileString(filePath), (text) => text === "marker\nfirst\nsecond\n"),
      );
    }),
  );

  it.effect("compacts the history file to the retained history past its bound", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(4);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const filePath = historyLogPath(logsDir);
      const fileIs = (expected: string) =>
        waitFor(
          Effect.map(readFileString(filePath), (text) => text === expected),
          "2 seconds",
        );

      process.emitData("1\n2\n");
      yield* fileIs("1\n2\n");
      // Past the 4-line budget but within the file's 6-line bound: appended.
      process.emitData("3\n4\n5\n");
      yield* fileIs("1\n2\n3\n4\n5\n");
      // Past the file's bound: rewritten with the retained 4 lines.
      process.emitData("6\n7\n");
      yield* fileIs("4\n5\n6\n7\n");
    }),
  );

  it.effect("rewrites the history file after a failed append instead of leaving a gap", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(100);
      const fs = yield* FileSystem.FileSystem;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const filePath = historyLogPath(logsDir);

      process.emitData("a\n");
      yield* waitFor(Effect.map(readFileString(filePath), (text) => text === "a\n"));
      // A directory in the file's place fails the next append.
      yield* fs.remove(filePath);
      yield* fs.makeDirectory(filePath);
      process.emitData("b\n");
      yield* Effect.sleep("200 millis");
      yield* fs.remove(filePath, { recursive: true });

      process.emitData("c\n");
      yield* waitFor(
        Effect.map(
          readFileString(filePath).pipe(Effect.orElseSucceed(() => "")),
          (text) => text === "a\nb\nc\n",
        ),
      );
    }),
  );

  it.effect("bounds retained history by bytes, trimming from the head", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5_000, {
        maxHistoryBytes: 200,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      // One chunk larger than the whole budget: only its tail can be retained.
      process.emitData(`${"a".repeat(150)}\n${"b".repeat(150)}\n`);
      yield* waitFor(
        Effect.flatMap(readFileString(historyLogPath(logsDir)), (text) =>
          Effect.succeed(text.length <= 200 && text.startsWith("b")),
        ),
      );

      const snapshot = yield* manager.listSessions;
      const session = snapshot.find((entry) => entry.threadId === "thread-1");
      expect(session?.history).toBeDefined();
      expect(session?.history.startsWith("a")).toBe(false);
      expect(session?.history.endsWith("\n")).toBe(true);
      expect(session?.history.length).toBeLessThanOrEqual(200);
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect("strips replayable CSI and DCS query traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      // DECRQM/DECRPM (ANSI and private modes), XTVERSION, and kitty-keyboard query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[4$p\u001b[4;2$y");
      process.emitData("\u001b[>q\u001b[>0q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\\u001bP0$r\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      // The same DCS traffic in 8-bit form.
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters and cursor movement share final bytes with the query families but
      // change visible terminal state, so they must survive replay. Sixel stays too.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u\u001b[>1u\u001bPq#0~\u001b\\');
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(
        reopened.history,
        'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[u\u001b[>1u\u001bPq#0~\u001b\\done\n',
      );
    }),
  );

  it.effect("strips CSI and DCS query traffic split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      // Split after the introducer, inside the payload, and between ESC and `\` of ST.
      process.emitData("\u001b");
      process.emitData("P$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(yield* pathExists(historyLogPath(logsDir))).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      yield* waitFor(pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")));
      yield* waitFor(pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")));

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(yield* pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(
        false,
      );
      expect(yield* pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(
        false,
      );
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      yield* waitFor(pathExists(historyLogPath(logsDir, "thread-1")));
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const missingShell =
        process.platform === "win32"
          ? "C:\\definitely\\missing-shell.exe"
          : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        process.platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (process.platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      });

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        platform: "win32",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
        shellResolver: () => "C:\\missing\\custom-shell.exe",
      });
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const originalValues = new Map<string, string | undefined>();
      const setEnv = (key: string, value: string | undefined) => {
        if (!originalValues.has(key)) {
          originalValues.set(key, process.env[key]);
        }
        if (value === undefined) {
          delete process.env[key];
          return;
        }
        process.env[key] = value;
      };
      const restoreEnv = () => {
        for (const [key, value] of originalValues) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      };

      setEnv("PORT", "5173");
      setEnv("RYCO_PORT", "3773");
      setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
      setEnv("TEST_TERMINAL_KEEP", "keep-me");

      try {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const spawnInput = ptyAdapter.spawnInputs[0];
        expect(spawnInput).toBeDefined();
        if (!spawnInput) return;

        expect(spawnInput.env.PORT).toBeUndefined();
        expect(spawnInput.env.RYCO_PORT).toBeUndefined();
        expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
        expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(
        openInput({
          env: {
            RYCO_PROJECT_ROOT: "/repo",
            RYCO_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.RYCO_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.RYCO_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const scope = yield* Effect.scope;
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n" }),
        expect.objectContaining({ type: "output", data: "second\n" }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0 }),
      ]);
    }),
  );

  it.effect("lists active session snapshots for reconnect replay", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("visible history\n");
      yield* waitFor(
        Effect.map(manager.listSessions, (snapshots) =>
          snapshots.some(
            (snapshot) =>
              snapshot.threadId === "thread-1" &&
              snapshot.terminalId === DEFAULT_TERMINAL_ID &&
              snapshot.status === "running" &&
              snapshot.history.includes("visible history\n"),
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("answers an open with a covered cursor with only the history after it", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(100);
      const opened = yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const outputCursors = Effect.map(getEvents, (events) =>
        events.filter((event) => event.type === "output").map((event) => event.cursor!),
      );
      process.emitData("one\n");
      yield* waitFor(Effect.map(outputCursors, (cursors) => cursors.length === 1));
      const [afterOne] = yield* outputCursors;
      process.emitData("two\n");
      yield* waitFor(Effect.map(outputCursors, (cursors) => cursors.length === 2));

      const delta = yield* manager.open(openInput({ sinceCursor: afterOne! }));
      expect(delta.history).toBe("two\n");
      expect(delta.historySince).toEqual(afterOne);
      const caughtUp = yield* manager.open(openInput({ sinceCursor: delta.cursor }));
      expect(caughtUp).toMatchObject({ history: "", historySince: delta.cursor });
      expect((yield* manager.open(openInput({ sinceCursor: opened.cursor }))).history).toBe(
        "one\ntwo\n",
      );

      // Another server generation, or a cursor this session never issued: full history.
      for (const sinceCursor of [
        { generation: "another-server", sequence: afterOne!.sequence },
        { ...delta.cursor!, sequence: delta.cursor!.sequence + 1_000 },
      ]) {
        const full = yield* manager.open(openInput({ sinceCursor }));
        expect(full.history).toBe("one\ntwo\n");
        expect(full.historySince).toBeUndefined();
      }

      // A clear replaces the history: a view from before it gets the full (new) history.
      yield* manager.clear({ threadId: "thread-1" });
      process.emitData("three\n");
      yield* waitFor(Effect.map(outputCursors, (cursors) => cursors.length === 3));
      const afterClear = yield* manager.open(openInput({ sinceCursor: delta.cursor }));
      expect(afterClear.history).toBe("three\n");
      expect(afterClear.historySince).toBeUndefined();

      // An ended session restarts on open: a delta of the old shell would be wrong.
      process.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput({ sinceCursor: afterClear.cursor }));
      expect(reopened.historySince).toBeUndefined();
      expect(reopened.history).toBe("");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("bounds pending output bytes while preserving terminal exit delivery", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
        maxPendingProcessEvents: 10,
        maxPendingProcessOutputBytes: 12,
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const unblockOutput = yield* Deferred.make<void>();
      let shouldBlockOutput = true;
      const scope = yield* Effect.scope;
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && shouldBlockOutput ? Deferred.await(unblockOutput) : Effect.void,
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      process.emitData("first\n");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "first\n"),
        ),
        "1200 millis",
      );

      process.emitData("bbbbbbbbbb");
      process.emitData("cccccccccc");
      process.emitData("dddddddddd");
      process.emitExit({ exitCode: 0, signal: 0 });

      shouldBlockOutput = false;
      yield* Deferred.succeed(unblockOutput, undefined);

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "exited" && event.exitCode === 0),
        ),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      const outputText = relevant
        .filter(
          (event): event is Extract<TerminalEvent, { type: "output" }> => event.type === "output",
        )
        .map((event) => event.data)
        .join("");

      expect(outputText).toBe("first\nccdddddddddd");
      expect(relevant.at(-1)).toEqual(
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0 }),
      );
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
