import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { USAGE_CONTRACT_VERSION, UsageReadError } from "@ryco/contracts";
import { Deferred, Duration, Effect, Exit, Fiber, FileSystem, Layer, Path } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeUsageServiceDeferred, type UsageServiceModule } from "./UsageServiceDeferred.ts";
import { makeEmptyUsageSummary, UsageService, usageRatesCachePath } from "./UsageServiceTag.ts";

const request = {
  contractVersion: USAGE_CONTRACT_VERSION,
  timeZone: "UTC",
  endDate: "2026-10-28",
} as const;

const settle = Effect.gen(function* () {
  for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

/**
 * A stand-in for `UsageService.ts`: counts imports and builds. A held loader answers once
 * released; a failing one rejects its first import.
 */
function fakeLoader(options: { readonly held?: boolean; readonly failFirst?: boolean } = {}) {
  let imports = 0;
  let builds = 0;
  const imported = Deferred.makeUnsafe<void>();
  let release: () => void = () => {};
  const released = options.held
    ? new Promise<void>((resolve) => (release = resolve))
    : Promise.resolve();
  const module: UsageServiceModule = {
    makeUsageService: () =>
      Effect.sync(() => {
        builds += 1;
        return UsageService.of({
          readSummary: (input) => Effect.succeed(makeEmptyUsageSummary(input)),
          priceStatistics: (snapshot) => Effect.succeed(snapshot),
        });
      }),
  };
  return {
    load: async (): Promise<UsageServiceModule> => {
      imports += 1;
      Deferred.doneUnsafe(imported, Exit.void);
      await released;
      if (options.failFirst && imports === 1) throw new Error("chunk missing");
      return module;
    },
    imported,
    release: () => release(),
    imports: () => imports,
    builds: () => builds,
  };
}

/** The deferred layer over a temporary state directory; `exists` checks are reported. */
function usageLayer(
  load: () => Promise<UsageServiceModule>,
  onExists: (path: string, exists: boolean) => void = () => {},
) {
  const observedFileSystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({
        ...fileSystem,
        exists: (path) =>
          fileSystem
            .exists(path)
            .pipe(Effect.tap((exists) => Effect.sync(() => onExists(path, exists)))),
      });
    }),
  );
  return Layer.effect(UsageService, makeUsageServiceDeferred(load)).pipe(
    Layer.provide(
      Layer.mergeAll(
        observedFileSystem,
        Layer.mock(ServerSettingsService)({}),
        Layer.mock(ServerEnvironment)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unused")),
        ),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-usage-deferred-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("UsageServiceDeferredLive", () => {
  it.effect("imports the usage pipeline with the first summary, not at boot", () => {
    const loader = fakeLoader();
    return Effect.gen(function* () {
      const usage = yield* UsageService;
      yield* settle;
      assert.strictEqual(loader.imports(), 0);

      const summary = yield* usage.readSummary(request);
      assert.deepStrictEqual(summary, makeEmptyUsageSummary(request));
      yield* usage.readSummary(request);
      assert.strictEqual(loader.imports(), 1);
      assert.strictEqual(loader.builds(), 1);
    }).pipe(Effect.provide(usageLayer(loader.load)));
  });

  it.effect("builds the pipeline once for concurrent first summaries", () => {
    const loader = fakeLoader({ held: true });
    return Effect.gen(function* () {
      const usage = yield* UsageService;
      const first = yield* Effect.forkChild(usage.readSummary(request));
      const second = yield* Effect.forkChild(usage.readSummary(request));
      yield* Deferred.await(loader.imported);
      yield* settle;
      loader.release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(loader.imports(), 1);
      assert.strictEqual(loader.builds(), 1);
    }).pipe(Effect.provide(usageLayer(loader.load)));
  });

  it.effect("finishes the build for the next summary when the first caller goes away", () => {
    const loader = fakeLoader({ held: true });
    return Effect.gen(function* () {
      const usage = yield* UsageService;
      // A closed socket interrupts the first summary while the pipeline is still loading.
      const first = yield* Effect.forkChild(usage.readSummary(request));
      yield* Deferred.await(loader.imported);
      yield* Fiber.interrupt(first);
      const second = yield* Effect.forkChild(usage.readSummary(request));
      yield* settle;
      loader.release();
      const summary = yield* Fiber.join(second);
      assert.strictEqual(summary.endDate, request.endDate);
      assert.strictEqual(loader.imports(), 1);
      assert.strictEqual(loader.builds(), 1);
    }).pipe(Effect.provide(usageLayer(loader.load)));
  });

  it.effect("reports a failed load and retries it with the next summary", () => {
    const loader = fakeLoader({ failFirst: true });
    return Effect.gen(function* () {
      const usage = yield* UsageService;
      const failed = yield* Effect.flip(usage.readSummary(request));
      assert.instanceOf(failed, UsageReadError);
      assert.strictEqual(failed.reason, "scan-failed");

      const summary = yield* usage.readSummary(request);
      assert.strictEqual(summary.endDate, request.endDate);
      assert.strictEqual(loader.imports(), 2);
      assert.strictEqual(loader.builds(), 1);
    }).pipe(Effect.provide(usageLayer(loader.load)));
  });

  it.effect("loads nothing after boot, even on a node that has downloaded rates", () => {
    const loader = fakeLoader();
    let checks = 0;
    return Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const ratesPath = usageRatesCachePath(path, config.stateDir);
      yield* fileSystem.makeDirectory(path.dirname(ratesPath), { recursive: true });
      yield* fileSystem.writeFileString(ratesPath, "{}");
      yield* UsageService;
      // The price list is refreshed when Usage or Statistics is first read, never on a timer.
      yield* TestClock.adjust(Duration.hours(1));
      yield* settle;
      assert.strictEqual(loader.imports(), 0);
      assert.strictEqual(checks, 0);
    }).pipe(
      Effect.provide(
        usageLayer(loader.load, () => {
          checks += 1;
        }),
      ),
    );
  });
});
