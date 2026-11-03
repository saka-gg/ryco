/**
 * In-memory PTYs for tests: they record what was written, resized and killed, and emit output and
 * an exit when the test says so. Nothing is spawned.
 *
 * @module fakePty
 */
import { Deferred, Effect } from "effect";

import {
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY.ts";

export class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  /** Whether a kill ends the process at once, reporting the signal, as a process that obeys it. */
  exitOnKill = false;
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
    if (this.exitOnKill) this.emitExit({ exitCode: 0, signal: signal === "SIGKILL" ? 9 : 1 });
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

export class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  /** By pid: spawned PTYs with an entry can name their foreground process. */
  readonly foregroundReaders = new Map<number, () => string | undefined>();
  /** Passed on to the PTYs it spawns from then on (`FakePtyProcess.exitOnKill`). */
  exitOnKill = false;
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
    process.exitOnKill = this.exitOnKill;
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
export class GatedPtyAdapter extends FakePtyAdapter {
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
