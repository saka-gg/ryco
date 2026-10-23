import type { OpenCodeSettings } from "@ryco/contracts";
import { Effect, Exit, Fiber, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { AgentProcessPriorityShape } from "./agentProcessPriority.ts";
import {
  OpenCodeRuntime,
  type OpenCodeRuntimeError,
  type OpenCodeServerProcess,
} from "./opencodeRuntime.ts";

export const OPENCODE_MANAGED_SERVER_IDLE_TTL = "30 seconds";

export interface OpenCodeServerOwner {
  /** A scoped lease. Closing the caller's scope releases its reference. */
  readonly acquire: Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
}

interface OwnedServer {
  readonly process: OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  leases: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

export const makeOpenCodeServerOwner = Effect.fn("makeOpenCodeServerOwner")(function* (
  settings: Pick<OpenCodeSettings, "binaryPath" | "serverPassword">,
  environment: NodeJS.ProcessEnv = process.env,
  options?: {
    /**
     * Lowers the shared server. The plan is made when the server starts, so a setting change
     * reaches OpenCode when its shared server restarts (after its last lease and the idle TTL).
     */
    readonly processPriority?: AgentProcessPriorityShape | undefined;
  },
): Effect.fn.Return<OpenCodeServerOwner, never, OpenCodeRuntime | Scope.Scope> {
  const runtime = yield* OpenCodeRuntime;
  const ownerScope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  let owned: OwnedServer | null = null;

  const closeOwned = (record: OwnedServer) =>
    Effect.gen(function* () {
      if (owned === record) owned = null;
      const idleFiber = record.idleCloseFiber;
      record.idleCloseFiber = null;
      if (idleFiber !== null) {
        yield* Fiber.interrupt(idleFiber).pipe(Effect.ignore);
      }
      yield* Scope.close(record.scope, Exit.void).pipe(Effect.ignore);
    });

  const cancelIdleClose = (record: OwnedServer) =>
    Effect.gen(function* () {
      const fiber = record.idleCloseFiber;
      record.idleCloseFiber = null;
      if (fiber !== null) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    });

  const acquireProcess = mutex.withPermit(
    Effect.gen(function* () {
      if (owned !== null) {
        yield* cancelIdleClose(owned);
        owned.leases += 1;
        return owned.process;
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const processScope = yield* Scope.make();
          const started = yield* Effect.exit(
            restore(
              runtime
                .startOpenCodeServerProcess({
                  binaryPath: settings.binaryPath,
                  ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
                  environment,
                  ...(options?.processPriority ? { processPriority: options.processPriority } : {}),
                })
                .pipe(Effect.provideService(Scope.Scope, processScope)),
            ),
          );
          if (Exit.isFailure(started)) {
            yield* Scope.close(processScope, Exit.void).pipe(Effect.ignore);
            return yield* Effect.failCause(started.cause);
          }
          owned = {
            process: started.value,
            scope: processScope,
            leases: 1,
            idleCloseFiber: null,
          };
          return started.value;
        }),
      );
    }),
  );

  const releaseProcess = (process: OpenCodeServerProcess) =>
    mutex.withPermit(
      Effect.gen(function* () {
        const record = owned;
        if (record === null || record.process !== process) return;
        record.leases = Math.max(0, record.leases - 1);
        if (record.leases > 0 || record.idleCloseFiber !== null) return;

        record.idleCloseFiber = yield* Effect.sleep(OPENCODE_MANAGED_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (owned !== record || record.leases > 0) return;
                record.idleCloseFiber = null;
                yield* closeOwned(record);
              }),
            ),
          ),
          Effect.forkIn(ownerScope),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (owned !== null) yield* closeOwned(owned);
      }),
    ),
  );

  return {
    acquire: Effect.acquireRelease(acquireProcess, releaseProcess),
  };
});
