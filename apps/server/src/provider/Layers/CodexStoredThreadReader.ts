/**
 * One shared, read-only `codex app-server` per Codex provider instance for reading stored
 * threads (history recovery of threads without a live runtime).
 *
 * Each read used to spawn its own app-server, initialize it and exit it again (~140 ms of
 * process start plus initialize per read, and a ~125 MiB process while it ran). The reader
 * starts one lazily, shares it between concurrent reads (JSON-RPC multiplexes requests), and
 * closes it after an idle period. A process that exits, or a transport failure on a request,
 * retires it; the next read starts a fresh one. A JSON-RPC error answer (for example an
 * unknown thread) leaves the healthy process in place.
 *
 * `thread/read` looks threads up by id in `CODEX_HOME`, so one reader serves every working
 * directory of the instance; it runs in the server's working directory and starts no thread
 * (and therefore no MCP servers).
 *
 * The provider status probe reads account, models and skills through the same process, so a
 * probe while a reader is up starts nothing. A process remembers the binary identity it
 * started under; `retireIfBinaryChanged` drops it once the binary (or anything else the
 * identity covers) differs, so upgrades and missing binaries are noticed.
 *
 * Starting a process is interruptible (a caller's timeout ends a start that never answers), and
 * a process another call is still using is retired by letting those calls finish: it is no
 * longer handed out, and exits with its last user.
 */
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { Duration, Effect, Exit, Fiber, Layer, Scope, Semaphore } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";

export interface CodexStoredThreadReaderOptions {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Working directory of the shared process. */
  readonly cwd: string;
  /** How long an unused process stays up. */
  readonly idleTimeout?: Duration.Input;
  readonly requestTimeoutMs?: number;
  /**
   * Identity of the binary a new process runs: read just before each start and by
   * `retireIfBinaryChanged`. Without it a running process is never retired for its binary.
   */
  readonly binaryIdentity?: Effect.Effect<string>;
}

/** What a caller learns about the process serving its call. */
export interface CodexStoredThreadSession {
  /** The process's answer to `initialize` (for example its `userAgent`). */
  readonly initialize: CodexSchema.V1InitializeResponse;
  /**
   * Retires exactly this process, for example after a request that never answered: it is not
   * handed to new calls and exits once the calls already using it have finished.
   */
  readonly retire: Effect.Effect<void>;
}

export interface CodexStoredThreadReader {
  /** Runs `use` against the shared client, starting it first when none is running. */
  readonly withClient: <A>(
    use: (
      client: CodexClient.CodexAppServerClientShape,
      session: CodexStoredThreadSession,
    ) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ) => Effect.Effect<A, CodexErrors.CodexAppServerError>;
  /**
   * Retires the running process when its binary identity no longer matches `binaryIdentity`
   * (like `CodexStoredThreadSession.retire`); the next call starts a fresh one. Does nothing
   * without a `binaryIdentity` option.
   */
  readonly retireIfBinaryChanged: Effect.Effect<void>;
  /** Process starts so far (for tests and diagnostics). */
  readonly starts: () => number;
  /** Whether a process is currently running. */
  readonly isRunning: () => boolean;
}

interface LiveReader {
  readonly scope: Scope.Closeable;
  readonly client: CodexClient.CodexAppServerClientShape;
  readonly initialize: CodexSchema.V1InitializeResponse;
  /** Binary identity read before this process started. */
  readonly binaryIdentity: string | undefined;
  users: number;
  retired: boolean;
  idleFiber: Fiber.Fiber<void> | undefined;
}

const closeQuietly = (scope: Scope.Closeable) =>
  Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void));

export const DEFAULT_CODEX_STORED_READER_IDLE_TIMEOUT = Duration.seconds(60);

export const makeCodexStoredThreadReader = Effect.fnUntraced(function* (
  options: CodexStoredThreadReaderOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ownerScope = yield* Scope.Scope;
  const startLock = Semaphore.makeUnsafe(1);
  const idleTimeout = Duration.fromInputUnsafe(
    options.idleTimeout ?? DEFAULT_CODEX_STORED_READER_IDLE_TIMEOUT,
  );
  let live: LiveReader | undefined;
  // Retired processes that calls are still using; the last of those calls closes them.
  const draining = new Set<LiveReader>();
  let starts = 0;
  let closed = false;

  // Hands the process to no new call and ends its idle timer.
  const detach = (reader: LiveReader): Effect.Effect<void> => {
    reader.retired = true;
    if (live === reader) live = undefined;
    const idle = reader.idleFiber;
    reader.idleFiber = undefined;
    return idle ? Fiber.interrupt(idle) : Effect.void;
  };

  // Ends the process now, and with it any call still running on it.
  const retire = (reader: LiveReader): Effect.Effect<void> =>
    Effect.suspend(() => {
      draining.delete(reader);
      // Killing a process that already exited fails; it is gone either way.
      return detach(reader).pipe(Effect.andThen(closeQuietly(reader.scope)));
    });

  // Ends the process once no call uses it, so calls already running on it still finish.
  const retireWhenUnused = (reader: LiveReader): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (reader.users === 0) return retire(reader);
      if (reader.retired) return Effect.void;
      draining.add(reader);
      return detach(reader);
    });

  const startProcess = (scope: Scope.Closeable) =>
    Effect.gen(function* () {
      // Read before the spawn: a binary replaced in between is then seen as changed next time,
      // never mistaken for the one this process runs.
      const binaryIdentity = options.binaryIdentity ? yield* options.binaryIdentity : undefined;
      const holder: { reader?: LiveReader } = {};
      const context = yield* CodexClient.layerCommand({
        command: options.binaryPath,
        args: ["app-server"],
        cwd: options.cwd,
        env: {
          ...(options.environment ?? process.env),
          ...(options.homePath ? { CODEX_HOME: expandHomePath(options.homePath) } : {}),
        } as Record<string, string>,
        requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
        // A process that exits is retired at once, not on the next read's failure.
        onTermination: () =>
          Effect.suspend(() => (holder.reader ? retire(holder.reader) : Effect.void)).pipe(
            Effect.forkIn(ownerScope),
            Effect.asVoid,
          ),
      }).pipe(
        Layer.build,
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(context),
      );
      const initialize = yield* client
        .request("initialize", buildCodexInitializeParams())
        .pipe(Effect.tap(() => client.notify("initialized", undefined)));
      starts += 1;
      const reader: LiveReader = {
        scope,
        client,
        initialize,
        binaryIdentity,
        users: 0,
        retired: false,
        idleFiber: undefined,
      };
      holder.reader = reader;
      return reader;
    });

  // The process is spawned and initialized interruptibly, so a caller that gives up on a start
  // that never answers (a timeout) does not wait out the request timeout. Anything but a started
  // process closes the scope, which stops what was spawned.
  const start = Effect.uninterruptibleMask((restore) =>
    Scope.make("sequential").pipe(
      Effect.flatMap((scope) =>
        restore(startProcess(scope)).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeQuietly(scope))),
        ),
      ),
    ),
  );

  // Interruptible while it waits for the start lock or for a start; once a process is in hand,
  // counting the caller as a user cannot be interrupted, so every acquire is matched by a release.
  const acquire = startLock.withPermit(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) {
          return yield* new CodexErrors.CodexAppServerTransportError({
            detail: "The Codex stored-thread reader is shut down.",
            cause: undefined,
          });
        }
        const reader = live !== undefined && !live.retired ? live : yield* restore(start);
        live = reader;
        reader.users += 1;
        const idle = reader.idleFiber;
        reader.idleFiber = undefined;
        if (idle) yield* Fiber.interrupt(idle);
        return reader;
      }),
    ),
  );

  const release = (reader: LiveReader) =>
    Effect.suspend(() => {
      reader.users -= 1;
      if (reader.retired) {
        if (reader.users > 0) return Effect.void;
        draining.delete(reader);
        return closeQuietly(reader.scope);
      }
      if (reader.users > 0) return Effect.void;
      return Effect.sleep(idleTimeout).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            // This fiber retires the reader itself: it must not interrupt itself.
            reader.idleFiber = undefined;
            return reader.users === 0 ? retire(reader) : Effect.void;
          }),
        ),
        Effect.forkIn(ownerScope),
        Effect.tap((fiber) =>
          Effect.sync(() => {
            reader.idleFiber = fiber;
          }),
        ),
        Effect.asVoid,
      );
    });

  yield* Scope.addFinalizer(
    ownerScope,
    Effect.suspend(() => {
      closed = true;
      return Effect.forEach([...(live ? [live] : []), ...draining], retire, { discard: true });
    }),
  );

  const retireIfBinaryChanged: CodexStoredThreadReader["retireIfBinaryChanged"] = Effect.suspend(
    () => {
      const reader = live;
      const identity = options.binaryIdentity;
      if (reader === undefined || reader.retired || identity === undefined) return Effect.void;
      return identity.pipe(
        Effect.flatMap((current) =>
          current === reader.binaryIdentity ? Effect.void : retireWhenUnused(reader),
        ),
      );
    },
  );

  // The caller can be interrupted while it waits for a process and while it uses one; whichever
  // process it holds is released on every exit.
  const withClient: CodexStoredThreadReader["withClient"] = (use) =>
    Effect.uninterruptibleMask((restore) =>
      restore(acquire).pipe(
        Effect.flatMap((reader) =>
          restore(
            use(reader.client, {
              initialize: reader.initialize,
              retire: retireWhenUnused(reader),
            }).pipe(
              // A JSON-RPC error answer comes from a healthy process; anything else may not.
              Effect.tapError((error) =>
                error._tag === "CodexAppServerRequestError" ? Effect.void : retire(reader),
              ),
            ),
          ).pipe(Effect.onExit(() => release(reader))),
        ),
      ),
    );

  return {
    withClient,
    retireIfBinaryChanged,
    starts: () => starts,
    isRunning: () => live !== undefined && !live.retired,
  } satisfies CodexStoredThreadReader;
});
