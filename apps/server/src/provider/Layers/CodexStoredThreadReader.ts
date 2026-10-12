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
 */
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
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
}

export interface CodexStoredThreadReader {
  /** Runs `use` against the shared client, starting it first when none is running. */
  readonly withClient: <A>(
    use: (
      client: CodexClient.CodexAppServerClientShape,
    ) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ) => Effect.Effect<A, CodexErrors.CodexAppServerError>;
  /** Process starts so far (for tests and diagnostics). */
  readonly starts: () => number;
  /** Whether a process is currently running. */
  readonly isRunning: () => boolean;
}

interface LiveReader {
  readonly scope: Scope.Closeable;
  readonly client: CodexClient.CodexAppServerClientShape;
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
  let starts = 0;
  let closed = false;

  const retire = (reader: LiveReader): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (reader.retired) return Effect.void;
      reader.retired = true;
      if (live === reader) live = undefined;
      const idle = reader.idleFiber;
      reader.idleFiber = undefined;
      return (idle ? Fiber.interrupt(idle) : Effect.void).pipe(
        // Killing a process that already exited fails; it is gone either way.
        Effect.andThen(closeQuietly(reader.scope)),
      );
    });

  const start = Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
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
      Effect.onError(() => closeQuietly(scope)),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(context),
    );
    yield* client.request("initialize", buildCodexInitializeParams()).pipe(
      Effect.andThen(client.notify("initialized", undefined)),
      Effect.onError(() => closeQuietly(scope)),
    );
    starts += 1;
    const reader: LiveReader = { scope, client, users: 0, retired: false, idleFiber: undefined };
    holder.reader = reader;
    return reader;
  });

  const acquire = startLock.withPermit(
    Effect.gen(function* () {
      if (closed) {
        return yield* new CodexErrors.CodexAppServerTransportError({
          detail: "The Codex stored-thread reader is shut down.",
          cause: undefined,
        });
      }
      const reader = live !== undefined && !live.retired ? live : yield* start;
      live = reader;
      reader.users += 1;
      const idle = reader.idleFiber;
      reader.idleFiber = undefined;
      if (idle) yield* Fiber.interrupt(idle);
      return reader;
    }),
  );

  const release = (reader: LiveReader) =>
    Effect.suspend(() => {
      reader.users -= 1;
      if (reader.retired || reader.users > 0) return Effect.void;
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
      return live ? retire(live) : Effect.void;
    }),
  );

  const withClient: CodexStoredThreadReader["withClient"] = (use) =>
    Effect.acquireUseRelease(
      acquire,
      (reader) =>
        use(reader.client).pipe(
          // A JSON-RPC error answer comes from a healthy process; anything else may not.
          Effect.tapError((error) =>
            error._tag === "CodexAppServerRequestError" ? Effect.void : retire(reader),
          ),
        ),
      release,
    );

  return {
    withClient,
    starts: () => starts,
    isRunning: () => live !== undefined && !live.retired,
  } satisfies CodexStoredThreadReader;
});
