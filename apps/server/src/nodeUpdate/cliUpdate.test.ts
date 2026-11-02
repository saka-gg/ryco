import { describe, expect, it } from "@effect/vitest";
import type { HubConnectorStatus } from "@ryco/contracts";
import { Deferred, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  awaitNodeReadyAfterUpdate,
  awaitNodeReadyOrExit,
  hubConnectorSettledForBoot,
  NODE_BOOT_HUB_WAIT,
  NODE_NOT_READY_EXIT_CODE,
  nodeUpdatePreflightVerdict,
  UNATTENDED_BOOT_READY_TIMEOUT,
} from "./cliUpdate.ts";
import { NODE_UPDATE_PREFLIGHT_PASSED, NODE_UPDATE_PREFLIGHT_STARTED } from "./updateProtocol.ts";

describe("node update preflight verdict", () => {
  it("passes a release that announced itself and reported its version", () => {
    expect(
      nodeUpdatePreflightVerdict(
        `${NODE_UPDATE_PREFLIGHT_STARTED}\n${NODE_UPDATE_PREFLIGHT_PASSED} 0.1.36\n`,
      ),
    ).toEqual({ kind: "passed", version: "0.1.36" });
  });

  it("fails a release that announced itself and stopped before passing", () => {
    expect(nodeUpdatePreflightVerdict(`${NODE_UPDATE_PREFLIGHT_STARTED}\n`)).toEqual({
      kind: "failed",
    });
  });

  it("tells a release that does not know the preflight from one that failed it", () => {
    // What 0.1.35 prints for the preflight's arguments.
    expect(nodeUpdatePreflightVerdict("USAGE\n  ryco <subcommand> [flags]\n")).toEqual({
      kind: "unsupported",
    });
    expect(nodeUpdatePreflightVerdict("")).toEqual({ kind: "unsupported" });
  });
});

const status = (overrides: Partial<HubConnectorStatus>): HubConnectorStatus => ({
  state: "connecting",
  transitionedAt: "2026-10-21T10:00:00.000Z",
  activeChannels: 0,
  queuedBytes: 0,
  ...overrides,
});

describe("node readiness after an update", () => {
  it("waits for the Hub while the connector can still get online by itself", () => {
    expect(hubConnectorSettledForBoot(status({ state: "online" }))).toBe(true);
    expect(hubConnectorSettledForBoot(status({ state: "connecting" }))).toBe(false);
    expect(hubConnectorSettledForBoot(status({ state: "authenticating" }))).toBe(false);
    expect(
      hubConnectorSettledForBoot(status({ state: "degraded", degradedMode: "backing_off" })),
    ).toBe(false);
    // Nothing changes these without a person.
    expect(
      hubConnectorSettledForBoot(
        status({ state: "degraded", degradedMode: "operator_action_required" }),
      ),
    ).toBe(true);
    expect(hubConnectorSettledForBoot(status({ state: "awaiting_approval" }))).toBe(true);
    expect(hubConnectorSettledForBoot(status({ state: "revoked" }))).toBe(true);
  });

  it.effect("is ready once the runtime is built when the Hub connector is off", () =>
    Effect.gen(function* () {
      const commandReady = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        awaitNodeReadyAfterUpdate({
          commandReady: Deferred.await(commandReady),
          hubConnector: null,
        }),
      );
      yield* TestClock.adjust(Duration.minutes(10));
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(commandReady, undefined);
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("waits for the connector to get online", () =>
    Effect.gen(function* () {
      let current = status({ state: "connecting" });
      const fiber = yield* Effect.forkChild(
        awaitNodeReadyAfterUpdate({
          commandReady: Effect.void,
          hubConnector: Effect.succeed({ connectorEnabled: true, status: () => current }),
        }),
      );
      yield* TestClock.adjust(Duration.seconds(30));
      expect(fiber.pollUnsafe()).toBeUndefined();
      current = status({ state: "online", protocolMajor: 1, protocolMinor: 1 });
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("counts the node as ready when the Hub stays out of reach", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        awaitNodeReadyAfterUpdate({
          commandReady: Effect.void,
          hubConnector: Effect.succeed({
            connectorEnabled: true,
            status: () => status({ state: "degraded", degradedMode: "backing_off" }),
          }),
        }),
      );
      yield* TestClock.adjust(Duration.subtract(NODE_BOOT_HUB_WAIT, Duration.seconds(1)));
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(fiber);
    }),
  );
});

describe("readiness watchdog after an unattended update", () => {
  const recordExits = () => {
    const exits: Array<number> = [];
    return { exits, exit: (code: number) => Effect.sync(() => exits.push(code)) };
  };

  it.effect("exits non-zero when the node is not ready 10 minutes after it started", () =>
    Effect.gen(function* () {
      const { exits, exit } = recordExits();
      const fiber = yield* Effect.forkChild(
        awaitNodeReadyOrExit({ commandReady: Effect.never, hubConnector: null }, exit),
      );
      yield* TestClock.adjust(
        Duration.subtract(UNATTENDED_BOOT_READY_TIMEOUT, Duration.seconds(1)),
      );
      expect(exits).toEqual([]);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(exits).toEqual([NODE_NOT_READY_EXIT_CODE]);
      expect(NODE_NOT_READY_EXIT_CODE).not.toBe(0);
      // It never reports the node ready, so the update is not confirmed.
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("returns once the node is ready in time, and exits at once when startup failed", () =>
    Effect.gen(function* () {
      const ready = recordExits();
      const commandReady = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        awaitNodeReadyOrExit(
          { commandReady: Deferred.await(commandReady), hubConnector: null },
          ready.exit,
        ),
      );
      yield* TestClock.adjust(Duration.minutes(9));
      yield* Deferred.succeed(commandReady, undefined);
      yield* Fiber.join(fiber);
      yield* TestClock.adjust(Duration.hours(1));
      expect(ready.exits).toEqual([]);

      const failed = recordExits();
      const failing = yield* Effect.forkChild(
        awaitNodeReadyOrExit(
          { commandReady: Effect.die(new Error("migration failed")), hubConnector: null },
          failed.exit,
        ),
      );
      yield* Effect.yieldNow;
      expect(failed.exits).toEqual([NODE_NOT_READY_EXIT_CODE]);
      yield* Fiber.interrupt(failing);
    }),
  );
});
