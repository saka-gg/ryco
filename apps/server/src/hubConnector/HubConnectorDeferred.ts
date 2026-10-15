/**
 * HubConnectorDeferred - builds the Hub connector after the HTTP router serves.
 *
 * Building the connector takes the identity's process lock and opens key
 * custody (state stores, the OS credential store probe). Built inside the serve
 * layer, all of that sat between the port bind and request handler attachment,
 * and the connector's whole module graph (relay, E2EE, noble) was evaluated on
 * every boot. Here the routes get {@link HubConnectorReady} at once. A server
 * whose connector is enabled calls `start` once handlers are attached, which
 * loads the connector module and builds it in the server's scope; a disabled
 * connector (no lock, no custody, no relay) is built only when a Hub route first
 * asks for it, so most boots never load that graph. Hub routes wait for the
 * construction, so nothing uses the identity before custody has completed.
 *
 * @module hubConnector/HubConnectorDeferred
 */
import { Cause, Context, Deferred, Effect, Exit, Layer } from "effect";

import type { HubConnectorConfig } from "../config.ts";
import {
  HubConnectorReady,
  HubConnectorService,
  type HubConnectorServiceShape,
} from "./HubConnectorService.ts";

export interface HubConnectorStartShape {
  /**
   * Begins building the connector in the background; later calls do nothing.
   * Returns without waiting for the build.
   */
  readonly start: Effect.Effect<void>;
}

export class HubConnectorStart extends Context.Service<HubConnectorStart, HubConnectorStartShape>()(
  "ryco/hubConnector/HubConnectorStart",
) {}

/** Thrown to Hub routes when the connector could not be built at all. */
export class HubConnectorStartupError extends Error {
  constructor() {
    super("Hub connector failed to start.");
    this.name = "HubConnectorStartupError";
  }
}

export const makeDeferredHubConnectorLive = <E, R>(
  load: () => Promise<Layer.Layer<HubConnectorService, E, R>>,
): Layer.Layer<HubConnectorReady | HubConnectorStart, never, R> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      // The connector runs requests through this context (relay RPC sessions),
      // so it must see the same services the serve layer did.
      const context = yield* Effect.context<R>();
      const built = yield* Deferred.make<HubConnectorServiceShape>();
      let started = false;

      const build = Effect.gen(function* () {
        const layer = yield* Effect.promise(load);
        const services = yield* Layer.buildWithScope(layer, scope);
        return Context.get(services, HubConnectorService);
      }).pipe(
        Effect.withSpan("server.startup.hub.connector"),
        Effect.provideContext(context),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Deferred.succeed(built, exit.value);
          if (Cause.hasInterruptsOnly(exit.cause)) return Deferred.interrupt(built);
          return Effect.logError("Hub connector failed to start", { cause: exit.cause }).pipe(
            Effect.andThen(Deferred.die(built, new HubConnectorStartupError())),
          );
        }),
        Effect.ignore,
      );

      const start = Effect.suspend(() => {
        if (started) return Effect.void;
        started = true;
        return Effect.asVoid(Effect.forkIn(build, scope));
      });

      return Context.make(HubConnectorReady, {
        await: start.pipe(Effect.andThen(Deferred.await(built))),
      }).pipe(Context.add(HubConnectorStart, { start }));
    }),
  );

/**
 * Run once request handlers are attached. A Hub-enabled node (a running Desktop standby
 * included) starts the connector now, so the process lock and key custody are held before the
 * first Hub request. A disabled connector takes neither, so it is left to the first Hub route
 * and most boots never load its module graph.
 */
export const startHubConnectorAfterServe = (
  config: Pick<HubConnectorConfig, "enabled"> | undefined,
): Effect.Effect<void, never, HubConnectorStart> =>
  Effect.gen(function* () {
    if (config?.enabled !== true) return;
    const { start } = yield* HubConnectorStart;
    yield* start;
  });

/** The connector of this process, loaded and built once the router serves. */
export const HubConnectorDeferredLive = makeDeferredHubConnectorLive(async () => {
  const { HubConnectorLive } = await import("./HubConnectorLive.ts");
  return HubConnectorLive;
});
