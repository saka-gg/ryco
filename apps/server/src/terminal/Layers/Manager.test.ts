import path from "node:path";
import { writeFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@ryco/contracts";
import {
  Duration,
  Effect,
  Deferred,
  Encoding,
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
import { makeTerminalManagerWithOptions } from "./Manager.ts";
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
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
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
  processTableSnapshotter?: () => Effect.Effect<
    { readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>> },
    Error
  >;
  subprocessPollIntervalMs?: number;
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
        ...(options.processKillGraceMs !== undefined
          ? { processKillGraceMs: options.processKillGraceMs }
          : {}),
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

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let hasRunningSubprocess = false;
      const { manager, getEvents } = yield* createManager(5, {
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
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
        ),
        "1200 millis",
      );

      hasRunningSubprocess = false;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
        ),
        "1200 millis",
      );
    }),
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
      yield* Effect.sleep("50 millis");
      recordSnapshots = true;

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const activeThreads = new Set(
            events
              .filter((event) => event.type === "activity" && event.hasRunningSubprocess === true)
              .map((event) => event.threadId),
          );
          return activeThreads.has("thread-1") && activeThreads.has("thread-2");
        }),
        "1500 millis",
      );

      assert.equal(snapshotCalls, 1);
    }),
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
