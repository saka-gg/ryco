import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect";

import { HubConnectorStart, makeDeferredHubConnectorLive } from "./HubConnectorDeferred.ts";
import {
  awaitHubConnector,
  HubConnectorReady,
  HubConnectorService,
  type HubConnectorServiceShape,
} from "./HubConnectorService.ts";

const connector = { connectorEnabled: true } as unknown as HubConnectorServiceShape;

class Probe extends Context.Service<Probe, { readonly label: string }>()("test/HubProbe") {}

/** A connector layer that records construction, what it saw, and its release. */
const recordingConnector = (events: string[]) =>
  Layer.effect(
    HubConnectorService,
    Effect.gen(function* () {
      const probe = yield* Probe;
      events.push(`build:${probe.label}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => events.push("release")));
      return connector;
    }),
  );

const buildDeferred = (layer: Layer.Layer<HubConnectorReady | HubConnectorStart, never, Probe>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope).pipe(
      Effect.provideService(Probe, { label: "serve-context" }),
    );
    return {
      scope,
      ready: Context.get(context, HubConnectorReady),
      start: Context.get(context, HubConnectorStart).start,
    };
  });

describe("makeDeferredHubConnectorLive", () => {
  it.live("loads nothing until started, then serves waiting routes the built connector", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      let loads = 0;
      const { scope, ready, start } = yield* buildDeferred(
        makeDeferredHubConnectorLive(async () => {
          loads += 1;
          return recordingConnector(events);
        }),
      );

      // A Hub route that arrives before the server serves waits for custody.
      let answered = false;
      const waiting = yield* awaitHubConnector.pipe(
        Effect.provideService(HubConnectorReady, ready),
        Effect.tap(() => Effect.sync(() => (answered = true))),
        Effect.forkChild,
      );
      yield* Effect.sleep("20 millis");
      expect(loads).toBe(0);
      expect(events).toEqual([]);
      expect(answered).toBe(false);

      yield* start;
      yield* start;
      expect(yield* Fiber.join(waiting)).toBe(connector);
      expect(yield* ready.await).toBe(connector);
      // Built once, from the context the serve layer was built in.
      expect(loads).toBe(1);
      expect(events).toEqual(["build:serve-context"]);

      // Its finalizers (lock release, connector stop) run with the server's scope.
      yield* Scope.close(scope, Exit.void);
      expect(events).toEqual(["build:serve-context", "release"]);
    }),
  );

  it.live("fails waiting routes, without failing the server, when the connector cannot be built", () =>
    Effect.gen(function* () {
      const { scope, ready, start } = yield* buildDeferred(
        makeDeferredHubConnectorLive(async () =>
          Layer.effect(HubConnectorService, Effect.die(new Error("custody exploded"))),
        ),
      );
      yield* start;
      const exit = yield* Effect.exit(ready.await);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("Hub connector failed to start");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.live("interrupts waiting routes when the server shuts down mid-build", () =>
    Effect.gen(function* () {
      const { scope, ready, start } = yield* buildDeferred(
        makeDeferredHubConnectorLive(() => new Promise<never>(() => undefined)),
      );
      yield* start;
      const waiting = yield* ready.await.pipe(Effect.forkChild);
      yield* Effect.sleep("10 millis");
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.await(waiting);
      expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
    }),
  );
});
