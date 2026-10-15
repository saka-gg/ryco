import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { HttpServerRespondable } from "effect/http";
import { TestClock } from "effect/testing";

import {
  HubConnectorStart,
  makeDeferredHubConnectorLive,
  startHubConnectorAfterServe,
} from "./HubConnectorDeferred.ts";
import {
  awaitHubConnector,
  HUB_CONNECTOR_READY_TIMEOUT,
  HubConnectorNotReadyError,
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

      yield* Effect.sleep("20 millis");
      expect(loads).toBe(0);
      expect(events).toEqual([]);

      yield* start;
      // A Hub route that arrives while custody is being built waits for it.
      const waiting = yield* awaitHubConnector.pipe(
        Effect.provideService(HubConnectorReady, ready),
        Effect.forkChild,
      );
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

  it.live("builds on the first Hub route when the server never started it", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      let loads = 0;
      const { scope, ready } = yield* buildDeferred(
        makeDeferredHubConnectorLive(async () => {
          loads += 1;
          return recordingConnector(events);
        }),
      );

      // A disabled connector is not started at boot; Settings asking about it builds it once.
      const [first, second] = yield* Effect.all(
        [
          awaitHubConnector.pipe(Effect.provideService(HubConnectorReady, ready)),
          awaitHubConnector.pipe(Effect.provideService(HubConnectorReady, ready)),
        ],
        { concurrency: "unbounded" },
      );
      expect(first).toBe(connector);
      expect(second).toBe(connector);
      expect(loads).toBe(1);
      expect(events).toEqual(["build:serve-context"]);

      yield* Scope.close(scope, Exit.void);
      expect(events).toEqual(["build:serve-context", "release"]);
    }),
  );

  it.live(
    "fails waiting routes, without failing the server, when the connector cannot be built",
    () =>
      Effect.gen(function* () {
        const { scope, ready, start } = yield* buildDeferred(
          makeDeferredHubConnectorLive(async () =>
            Layer.effect(HubConnectorService, Effect.die(new Error("custody exploded"))),
          ),
        );
        yield* start;
        const exit = yield* Effect.exit(ready.await);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain("Hub connector failed to start");
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

describe("startHubConnectorAfterServe", () => {
  const startAfterServe = (config: { readonly enabled: boolean; readonly standby?: true }) =>
    Effect.gen(function* () {
      const events: string[] = [];
      let loads = 0;
      const { scope, ready, start } = yield* buildDeferred(
        makeDeferredHubConnectorLive(async () => {
          loads += 1;
          return recordingConnector(events);
        }),
      );
      yield* startHubConnectorAfterServe(config).pipe(
        Effect.provideService(HubConnectorStart, { start }),
      );
      if (loads > 0) yield* ready.await;
      yield* Effect.sleep("20 millis");
      const result = { loads, events: [...events] };
      yield* Scope.close(scope, Exit.void);
      return result;
    });

  it.live("leaves a disabled connector unloaded until a Hub route asks", () =>
    Effect.gen(function* () {
      expect(yield* startAfterServe({ enabled: false })).toEqual({ loads: 0, events: [] });
    }),
  );

  it.live("builds an enabled or running standby connector once handlers are attached", () =>
    Effect.gen(function* () {
      const built = { loads: 1, events: ["build:serve-context"] };
      expect(yield* startAfterServe({ enabled: true })).toEqual(built);
      expect(yield* startAfterServe({ enabled: true, standby: true })).toEqual(built);
    }),
  );
});

describe("awaitHubConnector", () => {
  it.effect("answers 503 with Retry-After when custody does not finish in time", () =>
    Effect.gen(function* () {
      const waiting = yield* awaitHubConnector.pipe(
        Effect.provideService(HubConnectorReady, { await: Effect.never }),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(HUB_CONNECTOR_READY_TIMEOUT);
      const error = yield* Fiber.join(waiting);
      expect(error).toBeInstanceOf(HubConnectorNotReadyError);

      const response = yield* HttpServerRespondable.toResponse(error);
      expect(response.status).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
    }),
  );
});
