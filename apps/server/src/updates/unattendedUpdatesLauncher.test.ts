import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@ryco/contracts";
import { Effect, FileSystem, Layer, Path, PubSub, Stream } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { NodeUpdateService } from "../nodeUpdate/NodeUpdateService.ts";
import { AgentWorkActivity } from "../orchestration/AgentWorkActivity.ts";
import { ProviderMaintenanceRunner } from "../provider/providerMaintenanceRunner.ts";
import { ProviderInstallLock } from "../provider/Services/ProviderInstallLock.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { ClientInteraction } from "./ClientInteraction.ts";
import type * as UnattendedUpdates from "./unattendedUpdates.ts";
import { LOAD_RETRY_INTERVAL, makeUnattendedUpdatesLauncher } from "./unattendedUpdatesLauncher.ts";

const settle = Effect.gen(function* () {
  for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

const settings = (automaticUpdates: boolean): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  automaticUpdates,
  enableProviderUpdateChecks: true,
});

/**
 * The launcher over a settings service whose first read returns `firstRead` (and runs `duringRead`
 * first), and an updater whose load fails `failedLoads` times. Nothing else is touched before the
 * updater runs, so the other services are empty stand-ins.
 */
const launch = (options: {
  readonly firstRead: ServerSettings;
  readonly duringRead?: (changes: PubSub.PubSub<ServerSettings>) => Effect.Effect<unknown>;
  readonly failedLoads?: number;
}) =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ServerSettings>();
    let current = options.firstRead;
    let reads = 0;
    const serverSettings = {
      getSettings: Effect.suspend(() => {
        reads += 1;
        if (reads > 1) return Effect.succeed(current);
        const answer = current;
        return (options.duringRead?.(changes) ?? Effect.void).pipe(Effect.as(answer));
      }),
      streamChanges: Stream.fromPubSub(changes).pipe(
        Stream.tap((next) =>
          Effect.sync(() => {
            current = next;
          }),
        ),
      ),
    } as unknown as ServerSettingsShape;
    const runs: Array<string> = [];
    let loads = 0;
    const load = () => {
      loads += 1;
      if (loads <= (options.failedLoads ?? 0)) {
        return Promise.reject(new Error("server files replaced on disk"));
      }
      return Promise.resolve({
        runUnattendedUpdates: () =>
          Effect.sync(() => runs.push("running")).pipe(Effect.andThen(Effect.never)),
      } as unknown as typeof UnattendedUpdates);
    };
    yield* Layer.build(
      makeUnattendedUpdatesLauncher(load).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, {
              devUrl: undefined,
              stateDir: "/state",
            } as unknown as ServerConfigShape),
            Layer.succeed(ServerSettingsService, serverSettings),
            Layer.succeed(ProviderRegistry, {} as never),
            Layer.succeed(ProviderMaintenanceRunner, {} as never),
            Layer.succeed(ProviderInstallLock, {} as never),
            Layer.succeed(ClientInteraction, {} as never),
            Layer.succeed(AgentWorkActivity, {} as never),
            Layer.succeed(HttpClient.HttpClient, {} as never),
            Layer.succeed(NodeUpdateService, {} as never),
            Layer.succeed(TerminalManager, { listDiagnostics: Effect.succeed([]) } as never),
            Layer.succeed(FileSystem.FileSystem, {} as never),
            Layer.succeed(Path.Path, { join: (...parts: string[]) => parts.join("/") } as never),
          ),
        ),
      ),
    );
    yield* settle;
    return { runs, changes, loads: () => loads };
  });

describe("unattendedUpdatesLauncher", () => {
  it.effect("starts when the setting turns on while it reads the settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The owner turns it on between the subscription and the first read's answer.
        const { runs } = yield* launch({
          firstRead: settings(false),
          duringRead: (changes) => PubSub.publish(changes, settings(true)),
        });
        assert.deepStrictEqual(runs, ["running"]);
      }),
    ),
  );

  it.effect("waits while the setting is off, and starts once when it turns on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runs, changes, loads } = yield* launch({ firstRead: settings(false) });
        assert.deepStrictEqual(runs, []);
        assert.strictEqual(loads(), 0);
        yield* PubSub.publish(changes, settings(true));
        yield* settle;
        yield* PubSub.publish(changes, settings(true));
        yield* settle;
        assert.deepStrictEqual(runs, ["running"]);
      }),
    ),
  );

  it.effect("loads the updater again after a failed load", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runs, loads } = yield* launch({ firstRead: settings(true), failedLoads: 1 });
        assert.strictEqual(loads(), 1);
        assert.deepStrictEqual(runs, []);
        yield* TestClock.adjust(LOAD_RETRY_INTERVAL);
        yield* settle;
        assert.strictEqual(loads(), 2);
        assert.deepStrictEqual(runs, ["running"]);
      }),
    ),
  );
});
