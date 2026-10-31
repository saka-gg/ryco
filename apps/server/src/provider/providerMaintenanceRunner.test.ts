import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@ryco/contracts";
import { ServerProviderUpdateError } from "@ryco/contracts";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Sink,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";
import { makeProviderInstallLockLive } from "./Layers/ProviderInstallLock.ts";
import { makeProviderInstallLock } from "./providerInstallLock.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  clearLatestProviderVersionCacheForTests,
  makeProviderMaintenanceCapabilities,
  resolveLatestProviderVersion,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import { BUNDLED_MODEL_MANIFEST, ModelManifest, type ModelManifestData } from "./ModelManifest.ts";
import { clearProviderReleaseAgeCacheForTests } from "./providerReleaseAge.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();
// The installer's pid goes into the host install lock, which stays held while it lives: the
// stand-in installers carry the pid of a process that already exited.
const EXITED_PID = spawnSync(process.execPath, ["-e", ""]).pid!;

afterEach(() => {
  clearLatestProviderVersionCacheForTests();
  clearProviderReleaseAgeCacheForTests();
});

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === CURSOR_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseCursorProvider: ServerProvider = {
  ...baseProvider,
  instanceId: CURSOR_INSTANCE_ID,
  driver: CURSOR_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const latestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(EXITED_PID),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });

    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      revalidateStale: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    return {
      registry,
      updateStatesRef,
    };
  });
}

/** A host install lock folder of the test's own: never the host's shared one. */
const tempInstallLockDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "ryco-install-lock-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);

/** `manifestLayer` is an optional `ModelManifest` stub; without it the runner rates against the
 * bundled policies and the code-owned floors. */
const makeTestRunner = (
  registry: ProviderRegistryShape,
  manifestLayer?: Layer.Layer<ModelManifest>,
  options?: { readonly installLockDirectory?: string },
) =>
  Effect.gen(function* () {
    const installLockDirectory = options?.installLockDirectory ?? (yield* tempInstallLockDirectory);
    const runnerLayer = ProviderMaintenanceRunner.layer.pipe(
      Layer.provide(makeProviderInstallLockLive(installLockDirectory)),
      Layer.provide(Layer.succeed(ProviderRegistry, registry)),
      Layer.provide(ServerSettingsService.layerTest()),
    );
    return yield* Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
      Effect.provide(
        manifestLayer === undefined ? runnerLayer : runnerLayer.pipe(Layer.provide(manifestLayer)),
      ),
    );
  });

const manifestWithPolicies = (compatibility: ReadonlyArray<unknown>): ModelManifestData => ({
  ...BUNDLED_MODEL_MANIFEST,
  compatibility,
});

// The realistic kill switch: a provider release that breaks this Ryco release.
const CODEX_BROKEN_RELEASE_MANIFEST = manifestWithPolicies([
  {
    driver: "codex",
    rycoRange: ">=0.0.0",
    ranges: [
      { range: ">=0.200.0", status: "broken", message: "Codex 0.200 breaks approvals." },
      { range: "<0.200.0", status: "supported" },
    ],
  },
]);

const manifestStubLayer = (manifest: Ref.Ref<ModelManifestData>) =>
  Layer.succeed(ModelManifest, {
    current: Ref.get(manifest),
    refresh: Ref.get(manifest),
    refreshIfStale: Ref.get(manifest),
    refreshInBackground: Effect.void,
  });

const staticManifestLayer = (manifest: ModelManifestData) =>
  Layer.effect(
    ModelManifest,
    Ref.make(manifest).pipe(
      Effect.map((ref) => ({
        current: Ref.get(ref),
        refresh: Ref.get(ref),
        refreshIfStale: Ref.get(ref),
        refreshInBackground: Effect.void,
      })),
    ),
  );

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseCursorProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CURSOR_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "succeeded"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("uses the resolved provider capabilities when choosing the update executable", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.0.14",
          latestVersion: "2.1.123",
          updateCommand: "bun i -g @anthropic-ai/claude-code@latest",
          canUpdate: true,
          checkedAt: "2026-04-30T12:00:00.000Z",
          message: "Update available.",
        },
      });
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "bun",
              updateArgs: ["i", "-g", "@openai/codex@latest"],
              updateLockKey: "bun-global",
            }),
          ),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "bun",
          args: ["i", "-g", "@openai/codex@latest"],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "runs update commands through Effect ChildProcess when no test runner is injected",
    () => {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        const runner = yield* makeTestRunner(registry);

        const result = yield* runner.updateProvider(CODEX_DRIVER);

        assert.deepStrictEqual(calls, [
          {
            command: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
          },
        ]);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer((command, args) => {
              calls.push({ command, args });
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("updates a single provider instance without touching sibling instances", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const personalInstanceId = ProviderInstanceId.make("codex_personal");
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const refreshedInstanceIds: Array<ProviderInstanceId> = [];
      const { registry } = yield* makeRegistry([
        {
          ...baseProvider,
          instanceId: personalInstanceId,
          version: "0.124.0-alpha.3",
        },
        {
          ...baseProvider,
          instanceId: workInstanceId,
          version: "0.124.0-alpha.3",
        },
      ]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex-instance-test",
              updateExecutable: "vp",
              updateArgs: ["i", "-g", "@openai/codex"],
              updateLockKey: "vite-plus-global",
            }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => assert.strictEqual(instanceId, personalInstanceId))),
          ),
        refreshInstance: (instanceId) =>
          registry.refreshInstance(instanceId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                refreshedInstanceIds.push(instanceId);
              }),
            ),
          ),
      });

      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        instanceId: personalInstanceId,
      });

      assert.deepStrictEqual(calls, [
        {
          command: "vp",
          args: ["i", "-g", "@openai/codex"],
        },
      ]);
      assert.deepStrictEqual(refreshedInstanceIds, [personalInstanceId]);
      assert.strictEqual(result.providers[0]?.instanceId, personalInstanceId);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(result.providers[1]?.instanceId, workInstanceId);
      assert.strictEqual(result.providers[1]?.updateState, undefined);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.124.0-alpha.3"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("records command failure output in provider update state", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      const updateState = result.providers[0]?.updateState;

      assert.strictEqual(updateState?.status, "failed");
      assert.strictEqual(updateState?.message, "Update command exited with code 1.");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => ({ stderr: "permission denied", code: 1 })),
        ),
      ),
    ),
  );

  it.effect(
    "marks successful commands as unchanged when the refreshed provider is still outdated",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry({
          ...baseProvider,
          installed: true,
          version: "0.1.0",
        });
        const updater = yield* makeTestRunner(registry);

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
        assert.include(result.providers[0]?.updateState?.message ?? "", "still detects");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("9.9.9"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("prevents concurrent updates for the same provider", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started);

      const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(second), true);
      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause);
        assert.strictEqual(Schema.is(ServerProviderUpdateError)(error), true);
        if (Schema.is(ServerProviderUpdateError)(error)) {
          assert.include(error.reason, "already running");
        }
      }

      releaseLatch.resolve();
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("serializes different providers that share the same update lock key", () => {
    const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
              updateExecutable: "npm",
              updateArgs:
                provider === OPENCODE_DRIVER
                  ? ["install", "-g", "opencode-ai@latest"]
                  : ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
            }),
          ),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstStarted);

      const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
      let providersWhileQueued: ReadonlyArray<ServerProvider> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        providersWhileQueued = yield* registry.getProviders;
        const queuedStatus = providersWhileQueued.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;
        if (queuedStatus === "queued") {
          break;
        }
        yield* Effect.yieldNow;
      }
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      assert.strictEqual(
        providersWhileQueued.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );

      releaseFirstLatch.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(calls, [
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            if (calls.length === 1) {
              firstStartedLatch.resolve();
              return {
                stdout: "updated",
                exitCode: Effect.promise(() => releaseFirst).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.live("waits while another Ryco on this machine holds the install lock, then runs", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const installLockDirectory = yield* tempInstallLockDirectory;
      // Another Ryco process on this host: its own lock on the same folder.
      const otherRyco = makeProviderInstallLock({ directory: installLockDirectory });
      const holding = yield* Deferred.make<void>();
      const releaseOther = yield* Deferred.make<void>();
      const other = yield* otherRyco
        .tryRun("cursor-agent", () =>
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(releaseOther))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(holding);

      const { registry, updateStatesRef } = yield* makeRegistry(baseCursorProvider);
      const updater = yield* makeTestRunner(registry, undefined, { installLockDirectory });
      const update = yield* updater.updateProvider(CURSOR_DRIVER).pipe(Effect.forkScoped);

      const waitingMessage = "Another Ryco on this machine is updating this CLI.";
      const sawWaiting = Ref.get(updateStatesRef).pipe(
        Effect.map((states) => states.some((state) => state.message === waitingMessage)),
      );
      for (let attempt = 0; attempt < 200 && !(yield* sawWaiting); attempt += 1) {
        yield* Effect.sleep("10 millis");
      }
      // Still held a while later: queued, and nothing ran.
      yield* Effect.sleep("1500 millis");
      const queued = (yield* Ref.get(updateStatesRef)).at(-1);
      assert.strictEqual(queued?.status, "queued");
      assert.strictEqual(queued?.message, waitingMessage);
      assert.deepStrictEqual(calls, []);

      yield* Deferred.succeed(releaseOther, undefined);
      assert.isTrue(Option.isSome(yield* Fiber.join(other)));
      const result = yield* Fiber.join(update);

      assert.deepStrictEqual(calls, ["agent update"]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "queued", "running", "succeeded"],
      );
      // The runner released the lock it took.
      assert.isFalse(yield* otherRyco.isHeld("cursor-agent"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push([command, ...args].join(" "));
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("accepts arbitrary driver-provided update lock keys", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "unknown-lock-key",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        let blockQueuedState = true;
        const queuedStateWrittenLatch: { resolve: () => void } = { resolve: () => {} };
        const releaseQueuedStateLatch: { resolve: () => void } = { resolve: () => {} };
        const queuedStateWritten = new Promise<void>((resolve) => {
          queuedStateWrittenLatch.resolve = resolve;
        });
        const releaseQueuedState = new Promise<void>((resolve) => {
          releaseQueuedStateLatch.resolve = resolve;
        });

        const updater = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: Effect.fn(
            "providerMaintenanceRunner.test.blockQueuedState",
          )(function* (input) {
            const providers = yield* registry.setProviderMaintenanceActionState(input);
            if (input.state?.status === "queued" && blockQueuedState) {
              queuedStateWrittenLatch.resolve();
              yield* Effect.promise(() => releaseQueuedState);
            }
            return providers;
          }),
        });

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => queuedStateWritten);
        blockQueuedState = false;

        yield* Fiber.interrupt(first);
        releaseQueuedStateLatch.resolve();

        const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(second), true);
        if (Exit.isSuccess(second)) {
          assert.strictEqual(second.value.providers[0]?.updateState?.status, "succeeded");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect(
    "installs and verifies the installer's own latest version, pinned for pnpm, instead of npm's",
    () => {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      let installerLookups = 0;
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.2.3" });
        const updater = yield* makeTestRunner({
          ...registry,
          getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
            Effect.succeed(
              makeProviderMaintenanceCapabilities({
                provider,
                packageName: "@openai/codex",
                updateExecutable: "pnpm",
                updateArgs: ["add", "-g", "--allow-build=@openai/codex", "@openai/codex@latest"],
                updateLockKey: "pnpm-global",
                // `pnpm outdated` honors minimumReleaseAge, so it can trail npm's latest tag.
                lookupLatestVersion: Effect.sync(() => {
                  installerLookups += 1;
                  return "1.2.3";
                }),
              }),
            ),
        });

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.deepStrictEqual(calls, [
          {
            command: "pnpm",
            args: ["add", "-g", "--allow-build=@openai/codex", "@openai/codex@1.2.3"],
          },
        ]);
        // Verification reads the click-time installer answer, so 1.2.3 counts as current even
        // though npm advertises 9.9.9.
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
        assert.strictEqual(installerLookups, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("9.9.9"),
            mockSpawnerLayer((command, args) => {
              calls.push({ command, args });
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("runs the update with the action's environment over the server's", () => {
    const spawned: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: { readonly env?: unknown; readonly extendEnv?: unknown };
    }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "/home/me/.local/bin/codex",
              updateArgs: ["update"],
              updateLockKey: "codex-native",
              env: { CODEX_HOME: "/home/me/.codex" },
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);

      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(spawned.length, 1);
      assert.strictEqual(spawned[0]?.command, "/home/me/.local/bin/codex");
      assert.deepStrictEqual(spawned[0]?.args, ["update"]);
      assert.deepStrictEqual(spawned[0]?.options.env, { CODEX_HOME: "/home/me/.codex" });
      assert.strictEqual(spawned[0]?.options.extendEnv, true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              spawned.push(command as unknown as (typeof spawned)[number]);
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });

  describe("compatibility refusal", () => {
    it.effect("rates the version Homebrew would install, not npm's latest", () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        const updater = yield* makeTestRunner(
          {
            ...registry,
            getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
              Effect.succeed(
                makeProviderMaintenanceCapabilities({
                  provider,
                  packageName: "@openai/codex",
                  updateExecutable: "/opt/homebrew/bin/brew",
                  updateArgs: ["upgrade", "--cask", "codex"],
                  updateLockKey: "homebrew",
                  updateCommand: "brew upgrade --cask codex",
                  latestVersion: null,
                  lookupLatestVersion: Effect.succeed("0.200.1"),
                }),
              ),
          },
          staticManifestLayer(CODEX_BROKEN_RELEASE_MANIFEST),
        );

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
        assert.include(result.providers[0]?.updateState?.message, "v0.200.1");
        assert.deepStrictEqual(calls, []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            // npm's answer would pass the gate; Homebrew's own channel decides.
            latestVersionHttpClient("0.199.0"),
            mockSpawnerLayer((_command, args) => {
              calls.push(args.join(" "));
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    });

    it.effect("refuses to install a latest version the manifest marks broken", () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const { registry, updateStatesRef } = yield* makeRegistry(baseProvider);
        const updater = yield* makeTestRunner(
          registry,
          staticManifestLayer(CODEX_BROKEN_RELEASE_MANIFEST),
        );

        const result = yield* updater.updateProvider(CODEX_DRIVER);
        const updateState = result.providers[0]?.updateState;

        assert.strictEqual(updateState?.status, "failed");
        assert.include(updateState?.message, "v0.200.1");
        assert.include(updateState?.message, "breaks approvals");
        assert.strictEqual(updateState?.startedAt, null);
        assert.deepStrictEqual(calls, []);
        assert.deepStrictEqual(
          (yield* Ref.get(updateStatesRef)).map((state) => state.status),
          ["queued", "failed"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("0.200.1"),
            mockSpawnerLayer((_command, args) => {
              calls.push(args.join(" "));
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    });

    it.effect("rates a click-time fetch instead of the cached latest version", () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        // Warm the hourly cache with a version the policy allows.
        assert.strictEqual(
          yield* resolveLatestProviderVersion(lifecycleFor(CODEX_DRIVER)).pipe(
            Effect.provide(latestVersionHttpClient("0.199.0")),
          ),
          "0.199.0",
        );
        const { registry } = yield* makeRegistry(baseProvider);
        const updater = yield* makeTestRunner(
          registry,
          staticManifestLayer(CODEX_BROKEN_RELEASE_MANIFEST),
        );

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
        assert.include(result.providers[0]?.updateState?.message, "v0.200.1");
        assert.deepStrictEqual(calls, []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("0.200.1"),
            mockSpawnerLayer((_command, args) => {
              calls.push(args.join(" "));
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    });

    it.effect(
      "ignores a stale rating on the snapshot and rates against the current manifest",
      () => {
        const calls: Array<string> = [];
        return Effect.gen(function* () {
          const { registry } = yield* makeRegistry({
            ...baseProvider,
            version: "0.199.0",
            versionAdvisory: {
              status: "behind_latest",
              currentVersion: "0.199.0",
              latestVersion: "0.200.1",
              updateCommand: "npm install -g @openai/codex@latest",
              canUpdate: true,
              checkedAt: "2026-10-04T00:00:00.000Z",
              message: "Update available.",
            },
            compatibilityAdvisory: {
              status: "supported",
              latestVersionStatus: "supported",
              message: null,
            },
          });
          const updater = yield* makeTestRunner(
            registry,
            staticManifestLayer(CODEX_BROKEN_RELEASE_MANIFEST),
          );

          const result = yield* updater.updateProvider(CODEX_DRIVER);

          assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
          assert.include(result.providers[0]?.updateState?.message, "breaks approvals");
          assert.deepStrictEqual(calls, []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              latestVersionHttpClient("0.200.1"),
              mockSpawnerLayer((_command, args) => {
                calls.push(args.join(" "));
                return { stdout: "updated" };
              }),
            ),
          ),
        );
      },
    );

    it.effect("re-checks a queued update after it acquires the lock", () => {
      const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
      const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
      const firstStarted = new Promise<void>((resolve) => {
        firstStartedLatch.resolve = resolve;
      });
      const releaseFirst = new Promise<void>((resolve) => {
        releaseFirstLatch.resolve = resolve;
      });
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const manifest = yield* Ref.make<ModelManifestData>(BUNDLED_MODEL_MANIFEST);
        const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);
        const updater = yield* makeTestRunner(registry, manifestStubLayer(manifest));

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => firstStarted);

        const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const queuedStatus = (yield* registry.getProviders).find(
            (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
          )?.updateState?.status;
          if (queuedStatus === "queued") {
            break;
          }
          yield* Effect.yieldNow;
        }
        yield* Ref.set(
          manifest,
          manifestWithPolicies([
            {
              driver: "opencode",
              rycoRange: ">=0.0.0",
              ranges: [
                { range: "=1.18.40", status: "broken", message: "1.18.40 corrupts sessions." },
              ],
            },
          ]),
        );

        releaseFirstLatch.resolve();
        yield* Fiber.join(first);
        const secondResult = yield* Fiber.join(second);

        const openCodeState = secondResult.providers.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState;
        assert.strictEqual(openCodeState?.status, "failed");
        assert.include(openCodeState?.message, "corrupts sessions");
        assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("1.18.40"),
            mockSpawnerLayer((_command, args) => {
              calls.push(args.join(" "));
              if (calls.length === 1) {
                firstStartedLatch.resolve();
                return {
                  stdout: "updated",
                  exitCode: Effect.promise(() => releaseFirst).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(0)),
                  ),
                };
              }
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    });

    it.effect("installs a latest version the manifest allows", () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        const updater = yield* makeTestRunner(
          registry,
          staticManifestLayer(CODEX_BROKEN_RELEASE_MANIFEST),
        );

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
        assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("0.199.5"),
            mockSpawnerLayer((_command, args) => {
              calls.push(args.join(" "));
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    });
  });
});

describe("unattended provider updates", () => {
  // Codex 0.250.0 is installed; the policy rates 0.260.x supported and 0.270.x graceful, and has
  // no word on anything else (unknown).
  const installedCodex: ServerProvider = { ...baseProvider, version: "0.250.0" };
  const RATED_MANIFEST = manifestWithPolicies([
    {
      driver: "codex",
      rycoRange: ">=0.0.0",
      ranges: [
        { range: ">=0.270.0 <0.271.0", status: "graceful", message: "Works with limits." },
        { range: ">=0.250.0 <0.270.0", status: "supported" },
      ],
    },
  ]);
  const NOW = Date.parse("2026-10-31T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
  const windowOpen = (_heldLockKey: string) => Effect.succeed(true);

  /**
   * The npm registry: `latest` names `latest`, and the package document dates the versions in
   * `published` (every version 3 days old unless given).
   */
  const registryHttpClient = (
    latest: string,
    published: Readonly<Record<string, string>> = { [latest]: hoursAgo(72) },
  ) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/latest") ? { version: latest } : { time: published },
              {
                headers: { "content-type": "application/json" },
              },
            ),
          ),
        ),
      ),
    );

  /** A manifest whose fetch now rates differently from the copy in memory. */
  const refreshingManifestLayer = (current: ModelManifestData, fetched: ModelManifestData) =>
    Layer.effect(
      ModelManifest,
      Ref.make(current).pipe(
        Effect.map((ref) => ({
          current: Ref.get(ref),
          refresh: Ref.set(ref, fetched).pipe(Effect.as(fetched)),
          refreshIfStale: Ref.get(ref),
          refreshInBackground: Effect.void,
        })),
      ),
    );

  /** The runner over an instance whose CLI on disk is `disk.version` (0.250.0 at first). */
  const setup = (
    options: {
      readonly capabilities?: ProviderMaintenanceCapabilities;
      readonly installLockDirectory?: string;
      readonly manifest?: Layer.Layer<ModelManifest>;
    } = {},
  ) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const disk = { version: "0.250.0" };
      const { registry, updateStatesRef } = yield* makeRegistry(installedCodex);
      const onDisk = (providers: ReadonlyArray<ServerProvider>) =>
        providers.map((candidate) => ({ ...candidate, version: disk.version }));
      const runner = yield* makeTestRunner(
        {
          ...registry,
          getProviders: Effect.map(registry.getProviders, onDisk),
          refreshInstance: (instanceId) => Effect.map(registry.refreshInstance(instanceId), onDisk),
          ...(options.capabilities === undefined
            ? {}
            : {
                getProviderMaintenanceCapabilitiesForInstance: () =>
                  Effect.succeed(options.capabilities!),
              }),
        },
        options.manifest ?? staticManifestLayer(RATED_MANIFEST),
        options.installLockDirectory === undefined
          ? undefined
          : { installLockDirectory: options.installLockDirectory },
      );
      const states = Ref.get(updateStatesRef).pipe(
        Effect.map((all) => all.map((state) => `${state.status}: ${state.message}`)),
      );
      const update = (targetVersion = "0.260.0", beforeInstall = windowOpen) =>
        runner.updateProviderUnattended({
          provider: CODEX_DRIVER,
          instanceId: CODEX_INSTANCE_ID,
          targetVersion,
          beforeInstall,
        });
      return { runner, states, disk, update };
    });

  /** Records each installer run. Tests set what it leaves on disk in `beforeInstall`. */
  const spawnerRecording = (calls: Array<string>, options: { readonly code?: number } = {}) =>
    mockSpawnerLayer((command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "updated", code: options.code ?? 0 };
    });

  const nativeCodex = (installProven: boolean) => {
    const capabilities = makeProviderMaintenanceCapabilities({
      provider: CODEX_DRIVER,
      packageName: "@openai/codex",
      updateExecutable: "/home/me/.codex/bin/codex",
      updateArgs: ["update"],
      updateLockKey: "codex-native",
    });
    return installProven
      ? { ...capabilities, update: { ...capabilities.update!, installProven: true as const } }
      : capabilities;
  };

  it.effect("installs a supported release two days old, pinned to the version it rated", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { update, states, disk } = yield* setup();
      // Right before the installer runs: what the pinned npm install leaves on disk.
      const outcome = yield* update("0.260.0", () =>
        Effect.sync(() => {
          disk.version = "0.260.0";
          return true;
        }),
      );
      assert.deepStrictEqual(outcome, { kind: "installed", version: "0.260.0" });
      // Never `@latest`: a release published after the rating cannot land.
      assert.deepStrictEqual(calls, ["npm install -g @openai/codex@0.260.0"]);
      // No queued state for an update nobody clicked; every recorded step says it was automatic.
      assert.deepStrictEqual(yield* states, [
        "running: Automatic update: Updating provider.",
        "succeeded: Automatic update: Provider updated.",
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))));
  });

  it.effect(
    "records a failure when the updater installed a release this Ryco does not support",
    () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        // Codex's own updater takes no version: it installed 0.271.0, which nothing rates.
        const { update, states, disk } = yield* setup({ capabilities: nativeCodex(true) });
        const outcome = yield* update("0.260.0", () =>
          Effect.sync(() => {
            disk.version = "0.271.0";
            return true;
          }),
        );
        const message =
          "Automatic update: installed 0.271.0, which this Ryco release does not support (unknown). Update the provider from Settings, or update Ryco.";
        assert.deepStrictEqual(outcome, { kind: "failed", message });
        assert.deepStrictEqual(calls, ["/home/me/.codex/bin/codex update"]);
        assert.deepStrictEqual(yield* states, [
          "running: Automatic update: Updating provider.",
          `failed: ${message}`,
        ]);
      }).pipe(
        Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))),
      );
    },
  );

  it.effect("records a failure when the installer left another version than the one rated", () =>
    Effect.gen(function* () {
      for (const [left, message] of [
        // Supported, but not what Ryco checked.
        [
          "0.261.0",
          "Automatic update: installed 0.261.0 instead of 0.260.0, the release Ryco checked.",
        ],
        // An updater that reports failure and exits 0 (OpenCode's does) changed nothing.
        [
          "0.250.0",
          "Automatic update: the installer exited without installing 0.260.0; 0.250.0 is still installed.",
        ],
      ] as const) {
        clearLatestProviderVersionCacheForTests();
        const calls: Array<string> = [];
        yield* Effect.gen(function* () {
          const { update, states, disk } = yield* setup();
          const outcome = yield* update("0.260.0", () =>
            Effect.sync(() => {
              disk.version = left;
              return true;
            }),
          );
          assert.deepStrictEqual(outcome, { kind: "failed", message });
          assert.deepStrictEqual((yield* states).at(-1), `failed: ${message}`);
        }).pipe(
          Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))),
        );
      }
    }),
  );

  it.effect("runs a provider's own updater only on an install Ryco identified as its own", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      // The fallback for a path no installer is proven for: one-click updates only.
      const guessed = yield* setup({ capabilities: nativeCodex(false) });
      const outcome = yield* guessed.update();
      assert.strictEqual(outcome.kind, "skipped");
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(yield* guessed.states, []);
    }).pipe(Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))));
  });

  it.effect("leaves a release published less than 48 hours ago, or undated, alone", () =>
    Effect.gen(function* () {
      for (const published of [{ "0.260.0": hoursAgo(47) }, {}]) {
        clearLatestProviderVersionCacheForTests();
        clearProviderReleaseAgeCacheForTests();
        const calls: Array<string> = [];
        yield* Effect.gen(function* () {
          const { update, states } = yield* setup();
          const outcome = yield* update();
          assert.strictEqual(outcome.kind, "skipped");
          assert.deepStrictEqual(calls, []);
          assert.deepStrictEqual(yield* states, []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(registryHttpClient("0.260.0", published), spawnerRecording(calls)),
          ),
        );
      }
    }),
  );

  it.effect("rates the release against the manifest fetched under the lock", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      // The copy in memory rates 0.260.0 supported; the manifest published since breaks it.
      const { update, states } = yield* setup({
        manifest: refreshingManifestLayer(
          RATED_MANIFEST,
          manifestWithPolicies([
            {
              driver: "codex",
              rycoRange: ">=0.0.0",
              ranges: [
                { range: ">=0.260.0 <0.261.0", status: "broken", message: "Breaks approvals." },
                { range: ">=0.250.0 <0.270.0", status: "supported" },
              ],
            },
          ]),
        ),
      });
      const outcome = yield* update();
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "This Ryco release rates 0.260.0 broken.",
      });
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(yield* states, []);
    }).pipe(Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))));
  });

  it.effect("skips a release this Ryco rates unknown or graceful, and records nothing", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      for (const version of ["0.280.0", "0.270.0"]) {
        clearLatestProviderVersionCacheForTests();
        yield* Effect.gen(function* () {
          const { update, states } = yield* setup();
          const outcome = yield* update(version);
          assert.strictEqual(outcome.kind, "skipped");
          assert.deepStrictEqual(yield* states, []);
        }).pipe(Effect.provide(registryHttpClient(version)));
      }
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(spawnerRecording(calls)));
  });

  it.effect("skips an installer that cannot be pinned to the rated version", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { update, states } = yield* setup({
        capabilities: makeProviderMaintenanceCapabilities({
          provider: CODEX_DRIVER,
          packageName: "@openai/codex",
          updateExecutable: "vp",
          updateArgs: ["i", "-g", "@openai/codex"],
          updateLockKey: "vite-plus-global",
        }),
      });
      const outcome = yield* update();
      assert.strictEqual(outcome.kind, "skipped");
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(yield* states, []);
    }).pipe(Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))));
  });

  it.effect("skips when a newer release appeared after the pass picked one", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { update } = yield* setup();
      const outcome = yield* update("0.259.0");
      assert.strictEqual(outcome.kind, "skipped");
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryHttpClient("0.260.0", { "0.259.0": hoursAgo(96), "0.260.0": hoursAgo(72) }),
          spawnerRecording(calls),
        ),
      ),
    );
  });

  it.effect("postpones without a failure when the window closes under the lock", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { update, states } = yield* setup();
      const asked: Array<string> = [];
      const outcome = yield* update("0.260.0", (heldLockKey) =>
        Effect.sync(() => {
          asked.push(heldLockKey);
          return false;
        }),
      );
      assert.strictEqual(outcome.kind, "postponed");
      // The window is asked to set aside only the lock this run holds.
      assert.deepStrictEqual(asked, ["npm-global"]);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(yield* states, []);
    }).pipe(Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))));
  });

  it.effect("postpones at once while another Ryco on this machine installs the CLI", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const installLockDirectory = yield* tempInstallLockDirectory;
      const otherRyco = makeProviderInstallLock({ directory: installLockDirectory });
      const holding = yield* Deferred.make<void>();
      const releaseOther = yield* Deferred.make<void>();
      yield* otherRyco
        .tryRun("npm-global", () =>
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(releaseOther))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(holding);

      const { update, states } = yield* setup({ installLockDirectory });
      const outcome = yield* update();
      assert.strictEqual(outcome.kind, "postponed");
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(yield* states, []);
      yield* Deferred.succeed(releaseOther, undefined);
    }).pipe(Effect.provide(Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls))));
  });

  it.effect("records a failed install in the update state, as a one-click update does", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { update, states } = yield* setup();
      const outcome = yield* update();
      assert.deepStrictEqual(outcome, {
        kind: "failed",
        message: "Automatic update: Update command exited with code 1.",
      });
      assert.deepStrictEqual(calls, ["npm install -g @openai/codex@0.260.0"]);
      assert.deepStrictEqual(yield* states, [
        "running: Automatic update: Updating provider.",
        "failed: Automatic update: Update command exited with code 1.",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(registryHttpClient("0.260.0"), spawnerRecording(calls, { code: 1 })),
      ),
    );
  });
});
