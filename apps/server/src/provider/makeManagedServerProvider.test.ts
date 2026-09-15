import { describe, it, assert } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import { Deferred, Duration, Effect, Equal, Fiber, PubSub, Ref, Stream } from "effect";
import { vi } from "vitest";
import { TestClock } from "effect/testing";

import { isProviderSnapshotFresh, makeManagedServerProvider } from "./makeManagedServerProvider.ts";

// Keep the real PubSub implementation, but allow a test to pause its publication boundary.
vi.mock("effect", async (importOriginal) => {
  const effect = await importOriginal<typeof import("effect")>();
  return { ...effect, PubSub: { ...effect.PubSub } };
});

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const fastModeCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: fastModeCapabilities,
    },
  ],
};

const refreshedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:03.000Z",
  message: "Refreshed provider availability again.",
  skills: [{ name: "new", path: "/skills/new/SKILL.md", enabled: true }],
  slashCommands: [{ name: "new" }],
};

const enrichedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshotSecond,
  checkedAt: "2026-04-10T00:00:04.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
};

describe("makeManagedServerProvider", () => {
  it("treats a snapshot as stale at the exact freshness boundary", () => {
    assert.strictEqual(
      isProviderSnapshotFresh({
        lastRefreshAttemptAtMs: 1_000,
        nowMs: 300_999,
        freshnessMs: 300_000,
      }),
      true,
    );
    assert.strictEqual(
      isProviderSnapshotFresh({
        lastRefreshAttemptAtMs: 1_000,
        nowMs: 301_000,
        freshnessMs: 300_000,
      }),
      false,
    );
    assert.strictEqual(
      isProviderSnapshotFresh({
        lastRefreshAttemptAtMs: null,
        nowMs: 0,
        freshnessMs: 300_000,
      }),
      false,
    );
  });

  it.effect("coalesces an overlapping refresh with the background initial provider check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap(() => Deferred.await(releaseCheck)),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 hour",
        });

        const initial = yield* provider.getSnapshot;
        assert.deepStrictEqual(initial, initialSnapshot);

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const overlappingRefresh = yield* provider.refresh.pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const refreshResult = yield* Fiber.join(overlappingRefresh);
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot]);
        assert.deepStrictEqual(refreshResult, refreshedSnapshot);
        assert.deepStrictEqual(latest, refreshedSnapshot);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ),
  );

  it.effect("does not run periodic checks when automatic refresh is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckComplete = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckComplete, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: null,
        });

        yield* Deferred.await(initialCheckComplete);
        yield* TestClock.adjust(Duration.minutes(120));
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("coalesces concurrent forced refreshes into one provider check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckComplete = yield* Deferred.make<void>();
        const manualCheckStarted = yield* Deferred.make<void>();
        const releaseManualCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) => {
              if (count === 1) {
                return Deferred.succeed(initialCheckComplete, undefined).pipe(
                  Effect.as(refreshedSnapshot),
                );
              }
              return Deferred.succeed(manualCheckStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseManualCheck)),
                Effect.as(refreshedSnapshotSecond),
              );
            }),
          ),
          refreshInterval: null,
        });

        yield* Deferred.await(initialCheckComplete);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (Equal.equals(yield* provider.getSnapshot, refreshedSnapshot)) break;
          yield* Effect.yieldNow;
        }
        const refreshes = yield* Effect.all(
          Array.from({ length: 20 }, () => provider.refresh),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);

        yield* Deferred.await(manualCheckStarted);
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);

        yield* Deferred.succeed(releaseManualCheck, undefined);
        const snapshots = yield* Fiber.join(refreshes);

        assert.strictEqual(snapshots.length, 20);
        assert.ok(snapshots.every((snapshot) => Equal.equals(snapshot, refreshedSnapshotSecond)));
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ),
  );

  it.effect("coalesces stale revalidation callers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckComplete = yield* Deferred.make<void>();
        const staleCheckStarted = yield* Deferred.make<void>();
        const releaseStaleCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) => {
              if (count === 1) {
                return Deferred.succeed(initialCheckComplete, undefined).pipe(
                  Effect.as(refreshedSnapshot),
                );
              }
              return Deferred.succeed(staleCheckStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStaleCheck)),
                Effect.as(refreshedSnapshotSecond),
              );
            }),
          ),
          refreshInterval: null,
          snapshotFreshness: Duration.zero,
        });

        yield* Deferred.await(initialCheckComplete);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (Equal.equals(yield* provider.getSnapshot, refreshedSnapshot)) break;
          yield* Effect.yieldNow;
        }
        const revalidations = yield* Effect.all(
          Array.from({ length: 20 }, () => provider.revalidate),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);

        yield* Deferred.await(staleCheckStarted);
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);

        yield* Deferred.succeed(releaseStaleCheck, undefined);
        const snapshots = yield* Fiber.join(revalidations);
        assert.ok(snapshots.every((snapshot) => Equal.equals(snapshot, refreshedSnapshotSecond)));
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const releaseSettingsCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Deferred.await(releaseSettingsCheck).pipe(Effect.as(refreshedSnapshotSecond)),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.succeed(releaseSettingsCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(latest, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ),
  );

  it.effect("ignores stale enrichment callbacks after a newer refresh advances generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publishCallbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const refreshCount = yield* Ref.make(0);
        const firstCallbackReady = yield* Deferred.make<void>();
        const secondCallbackReady = yield* Deferred.make<void>();
        const allowFirstRefresh = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(allowFirstRefresh).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              publishCallbacks.push(publishSnapshot);
              if (publishCallbacks.length === 1) {
                yield* Deferred.succeed(firstCallbackReady, undefined).pipe(Effect.ignore);
              } else if (publishCallbacks.length === 2) {
                yield* Deferred.succeed(secondCallbackReady, undefined).pipe(Effect.ignore);
              }
            }),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(allowFirstRefresh, undefined);
        yield* Deferred.await(firstCallbackReady);

        yield* provider.refresh;
        yield* Deferred.await(secondCallbackReady);

        yield* publishCallbacks[0]!(enrichedSnapshot);
        yield* publishCallbacks[1]!(enrichedSnapshotSecond);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [
          refreshedSnapshot,
          refreshedSnapshotSecond,
          enrichedSnapshotSecond,
        ]);
        assert.deepStrictEqual(latest, enrichedSnapshotSecond);
      }),
    ),
  );

  it.effect("orders an in-flight skill enrichment publication before a newer refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldInventory: ServerProvider = {
          ...refreshedSnapshot,
          skills: [{ name: "old", path: "/skills/old/SKILL.md", enabled: true }],
          slashCommands: [{ name: "old" }],
        };
        const oldEnrichment = { ...oldInventory, message: "Old enrichment" };
        const removedInventory = { ...refreshedSnapshotSecond, skills: [], slashCommands: [] };
        const callbackReady = yield* Deferred.make<void>();
        const publicationStarted = yield* Deferred.make<void>();
        const releasePublication = yield* Deferred.make<void>();
        const firstCheck = yield* Deferred.make<void>();
        const checks = yield* Ref.make(0);
        const callbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const originalPublish = PubSub.publish;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(PubSub, "publish")
              .mockImplementation((pubsub, value) =>
                value === oldEnrichment
                  ? Deferred.succeed(publicationStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePublication)),
                      Effect.andThen(originalPublish(pubsub, value)),
                    )
                  : originalPublish(pubsub, value),
              ),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.updateAndGet(checks, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n === 1
                ? Deferred.await(firstCheck).pipe(Effect.as(oldInventory))
                : Effect.succeed(removedInventory),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.sync(() => {
              callbacks.push(publishSnapshot);
            }).pipe(Effect.andThen(Deferred.succeed(callbackReady, undefined)), Effect.asVoid),
          refreshInterval: null,
        });
        const observed: Array<ServerProvider> = [];
        yield* Stream.runForEach(provider.streamChanges, (snapshot) =>
          Effect.sync(() => {
            observed.push(snapshot);
          }),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(firstCheck, undefined);
        yield* Deferred.await(callbackReady);
        const oldPublication = yield* callbacks[0]!(oldEnrichment).pipe(Effect.forkChild);
        yield* Deferred.await(publicationStarted);
        const refresh = yield* provider.refresh.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releasePublication, undefined);
        yield* Fiber.join(oldPublication);
        yield* Fiber.join(refresh);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(yield* provider.getSnapshot, removedInventory);
        assert.deepStrictEqual(observed.at(-1), removedInventory);
        yield* callbacks[0]!(oldEnrichment);
        assert.deepStrictEqual(yield* provider.getSnapshot, removedInventory);
      }),
    ),
  );

  it.effect("retains the last known inventory when a refresh reports an error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstCheckComplete = yield* Deferred.make<void>();
        const checkCount = yield* Ref.make(0);
        const availableSnapshot: ServerProvider = {
          ...refreshedSnapshot,
          models: enrichedSnapshot.models,
          slashCommands: [{ name: "review" }],
          skills: [
            {
              name: "frontend",
              path: "/skills/frontend/SKILL.md",
              enabled: true,
            },
          ],
        };
        const failedSnapshot: ServerProvider = {
          ...refreshedSnapshotSecond,
          status: "error",
          message: "Temporary inventory failure.",
          models: [],
          slashCommands: [],
          skills: [],
        };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => initialSnapshot,
          checkProvider: Ref.updateAndGet(checkCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(firstCheckComplete, undefined).pipe(Effect.as(availableSnapshot))
                : Effect.succeed(
                    count === 2
                      ? failedSnapshot
                      : { ...refreshedSnapshotSecond, skills: [], slashCommands: [] },
                  ),
            ),
          ),
          retainInventoryOnError: true,
          refreshInterval: null,
        });

        yield* Deferred.await(firstCheckComplete);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (Equal.equals(yield* provider.getSnapshot, availableSnapshot)) break;
          yield* Effect.yieldNow;
        }

        const result = yield* provider.refresh;
        assert.strictEqual(result.status, "error");
        assert.deepStrictEqual(result.models, availableSnapshot.models);
        assert.deepStrictEqual(result.slashCommands, availableSnapshot.slashCommands);
        assert.deepStrictEqual(result.skills, availableSnapshot.skills);
        const recovered = yield* provider.refresh;
        assert.strictEqual(recovered.status, "ready");
        assert.deepStrictEqual(recovered.skills, []);
        assert.deepStrictEqual(recovered.slashCommands, []);
      }),
    ),
  );
});
