import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert, live } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PubSub,
  Ref,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@ryco/contracts";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@ryco/shared/Struct";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import {
  checkClaudeProviderStatus,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
} from "./ClaudeProvider.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";
import {
  haveProvidersChanged,
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  ProviderRegistryLive,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

// A registry-only fixture keeps inventory races independent of provider subprocesses.
const makeInventoryRegistry = Effect.fn("makeInventoryRegistry")(function* (
  fileSystem?: FileSystem.FileSystem,
) {
  const driver = ProviderDriverKind.make("codex");
  const inventories = ["codex", "codex-work", "claude"].map(
    (id) =>
      ({
        instanceId: ProviderInstanceId.make(id),
        driver: ProviderDriverKind.make(id === "claude" ? "claude" : "codex"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-09-15T00:00:00.000Z",
        models: [],
        skills: [{ name: "old", path: "/skills/old/SKILL.md", enabled: true }],
        slashCommands: [{ name: "old" }],
      }) satisfies ServerProvider,
  );
  const controls = yield* Effect.forEach(inventories, (initial) =>
    Effect.gen(function* () {
      const next = yield* Ref.make<ServerProvider>(initial);
      const calls = yield* Ref.make(0);
      const booted = yield* Deferred.make<void>();
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const instance: ProviderInstance = {
        instanceId: initial.instanceId,
        driverKind: initial.driver,
        continuationIdentity: { driverKind: initial.driver, continuationKey: initial.instanceId },
        displayName: undefined,
        enabled: true,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: initial.driver,
            packageName: null,
          }),
          getSnapshot: Effect.succeed(initial),
          revalidate: Ref.get(next),
          refresh: Ref.update(calls, (count) => count + 1).pipe(
            Effect.andThen(Ref.get(next)),
            Effect.tap(() => Deferred.succeed(booted, undefined)),
          ),
          streamChanges: Stream.fromPubSub(changes),
        },
        adapter: {} as ProviderInstance["adapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      };
      return { initial, next, calls, changes, instance, booted };
    }),
  );
  const instanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (id) =>
      Effect.succeed(controls.find((control) => control.initial.instanceId === id)?.instance),
    listInstances: Effect.succeed(controls.map((control) => control.instance)),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  });
  const services = yield* Layer.build(
    ProviderRegistryLive.pipe(
      Layer.provideMerge(instanceRegistry),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-skill-refresh-" })),
      Layer.provideMerge(
        fileSystem ? Layer.succeed(FileSystem.FileSystem, fileSystem) : NodeServices.layer,
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  return yield* Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const config = yield* ServerConfig;
    // Wait for background sources to run before changing their inventories.
    yield* Effect.forEach(controls, (control) => Deferred.await(control.booted));
    yield* Effect.yieldNow;
    yield* registry.refresh();
    const cachePath = (instanceId: ProviderInstanceId) =>
      resolveProviderStatusCachePath({
        cacheDir: config.providerStatusCacheDir,
        instanceId,
      });
    return { registry, controls, driver, cachePath };
  }).pipe(Effect.provide(services));
});

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const defaultCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({});
const disabledCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({
  enabled: false,
});

process.env.RYCO_CURSOR_ENABLED = "1";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      slashCommands: [],
      ...overrides,
    });
}

const noClaudeCapabilities = () =>
  Effect.sync(() => undefined as TestClaudeCapabilities | undefined);

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function recordingMockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const commands: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        args: ReadonlyArray<string>;
        options?: {
          readonly env?: NodeJS.ProcessEnv;
        };
      };
      commands.push({ args: cmd.args, env: cmd.options?.env });
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
  return { layer, commands };
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    selectDescriptor("reasoningEffort", "Reasoning", [
      { id: "high", label: "High", isDefault: true },
      { id: "low", label: "Low" },
    ]),
    booleanDescriptor("fastMode", "Fast Mode"),
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    rateLimits: undefined,
    ...input,
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = Schema.decodeSync(ServerSettings)(deepMerge(current, patch));
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    } satisfies ServerSettingsShape;
  });
}

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("uses the app-server account and model list for provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                skills: [
                  {
                    name: "github:gh-fix-ci",
                    path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                    enabled: true,
                    displayName: "CI Debug",
                    shortDescription: "Debug failing GitHub Actions checks",
                  },
                ],
              }),
            ),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "1.0.0");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
          assert.strictEqual(status.auth.email, "test@example.com");
          assert.deepStrictEqual(status.models, [
            {
              slug: "gpt-live-codex",
              name: "GPT Live Codex",
              isCustom: false,
              capabilities: codexModelCapabilities,
            },
          ]);
          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
        }),
      );

      it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: null,
                  requiresOpenaiAuth: true,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }),
      );

      it.effect(
        "returns ready with unknown auth when app-server does not require OpenAI auth",
        () =>
          Effect.gen(function* () {
            const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
              Effect.succeed(
                makeCodexProbeSnapshot({
                  account: {
                    account: null,
                    requiresOpenaiAuth: false,
                  },
                }),
              ),
            );

            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.auth.status, "unknown");
          }),
      );

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "apiKey" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
        }),
      );

      it.effect("forwards rateLimits from the probe snapshot onto the provider", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                rateLimits: {
                  limitName: "ChatGPT Pro",
                  planType: "pro",
                  primary: {
                    usedPercent: 42,
                    resetsAt: 1_700_000_000,
                    windowDurationMins: 300,
                  },
                  secondary: {
                    usedPercent: 7,
                    windowDurationMins: 7 * 24 * 60,
                  },
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.deepStrictEqual(status.rateLimits, {
            limitName: "ChatGPT Pro",
            planType: "pro",
            primary: {
              usedPercent: 42,
              resetsAt: 1_700_000_000,
              windowDurationMins: 300,
            },
            secondary: {
              usedPercent: 7,
              windowDurationMins: 7 * 24 * 60,
            },
          });
        }),
      );

      it.effect("omits rateLimits when the probe snapshot has none", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(makeCodexProbeSnapshot()),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.rateLimits, undefined);
        }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.fail(
              new CodexErrors.CodexAppServerSpawnError({
                command: "codex app-server",
                cause: new Error("spawn codex ENOENT"),
              }),
            ),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
        }),
      );
    });

    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });

      it("preserves previously discovered provider models when a refresh returns none", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("fills missing capabilities from the previous provider snapshot", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [],
              }),
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("persists merged provider snapshots for the providers that were refreshed", () => {
        const previousProviders = [
          {
            instanceId: ProviderInstanceId.make("cursor"),
            driver: ProviderDriverKind.make("cursor"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                    booleanDescriptor("fastMode", "Fast Mode"),
                    booleanDescriptor("thinking", "Thinking"),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;
        const refreshedCursor = {
          ...previousProviders[0],
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        const mergedProviders = mergeProviderSnapshots(previousProviders, [refreshedCursor]);
        const persistedProviders = selectProvidersByKind(
          mergedProviders,
          new Set([ProviderDriverKind.make("cursor")]),
        );

        assert.deepStrictEqual(persistedProviders, [
          {
            ...refreshedCursor,
            models: [...previousProviders[0].models],
          },
        ]);
      });

      it.effect(
        "replaces skill inventories through instance, default-driver and global refresh",
        () =>
          Effect.gen(function* () {
            const { registry, controls, driver, cachePath } = yield* makeInventoryRegistry();
            const [personal, work, claude] = controls;
            assert.ok(personal && work && claude);
            const added = (initial: ServerProvider): ServerProvider => ({
              ...initial,
              skills: [{ name: "new", path: "/skills/new/SKILL.md", enabled: true }],
              slashCommands: [{ name: "new" }],
            });
            for (const control of controls) yield* Ref.set(control.next, added(control.initial));
            const counts = yield* Effect.forEach(controls, (control) => Ref.get(control.calls));
            yield* registry.refreshInstance(work.initial.instanceId);
            assert.deepStrictEqual(
              yield* registry.getProviders,
              [personal.initial, claude.initial, added(work.initial)].toSorted(
                (a, b) =>
                  a.driver.localeCompare(b.driver) || a.instanceId.localeCompare(b.instanceId),
              ),
            );
            assert.deepStrictEqual(
              yield* Effect.forEach(controls, (control) => Ref.get(control.calls)),
              [counts[0], counts[1]! + 1, counts[2]],
            );
            yield* registry.refresh(driver);
            assert.deepStrictEqual(
              (yield* registry.getProviders).find(
                (p) => p.instanceId === personal.initial.instanceId,
              ),
              added(personal.initial),
            );
            assert.strictEqual(yield* Ref.get(claude.calls), counts[2]);
            yield* registry.refresh();
            for (const control of controls) {
              assert.deepStrictEqual(
                yield* readProviderStatusCache(yield* cachePath(control.initial.instanceId)),
                added(control.initial),
              );
              yield* Ref.set(control.next, { ...control.initial, skills: [], slashCommands: [] });
            }
            yield* registry.refresh();
            for (const control of controls) {
              const expected = { ...control.initial, skills: [], slashCommands: [] };
              assert.deepStrictEqual(
                (yield* registry.getProviders).find(
                  (p) => p.instanceId === control.initial.instanceId,
                ),
                expected,
              );
              assert.deepStrictEqual(
                yield* readProviderStatusCache(yield* cachePath(control.initial.instanceId)),
                expected,
              );
            }
          }),
      );

      for (const source of ["refresh", "stream"] as const) {
        it.effect(
          `keeps stream and disk inventory current when an older ${source} publication stalls during persistence`,
          () =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const oldWriteStarted = yield* Deferred.make<void>();
              const releaseOldWrite = yield* Deferred.make<void>();
              let pauseNextWrite = false;
              const files = new Map<string, string>();
              let tempDirectory = 0;
              const memoryFs: FileSystem.FileSystem = {
                ...fs,
                exists: (path) => Effect.sync(() => files.has(path)),
                makeDirectory: () => Effect.void,
                makeTempDirectoryScoped: () => Effect.sync(() => `/cache-test/${++tempDirectory}`),
                writeFileString: (path, contents) =>
                  Effect.sync(() => {
                    files.set(path, contents);
                  }),
                readFileString: (path) =>
                  files.has(path) ? Effect.succeed(files.get(path)!) : fs.readFileString(path),
                rename: (from, to) =>
                  Effect.gen(function* () {
                    if (pauseNextWrite) {
                      pauseNextWrite = false;
                      yield* Deferred.succeed(oldWriteStarted, undefined);
                      yield* Deferred.await(releaseOldWrite);
                    }
                    files.set(to, files.get(from)!);
                    files.delete(from);
                  }),
              };
              const { registry, controls, cachePath } = yield* makeInventoryRegistry(memoryFs);
              const control = controls[0]!;
              const old = { ...control.initial, checkedAt: "2026-09-15T00:01:00.000Z" };
              const current = {
                ...control.initial,
                checkedAt: "2026-09-15T00:02:00.000Z",
                skills: [],
                slashCommands: [],
              };
              const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
              yield* registry.streamChanges.pipe(
                Stream.runForEach((providers) => Ref.set(published, providers)),
                Effect.forkChild,
              );
              // The subscriber runs before the filesystem barrier is reached.
              yield* Effect.yieldNow;
              yield* Ref.set(control.next, old);
              pauseNextWrite = true;
              const older = yield* (
                source === "refresh"
                  ? registry.refreshInstance(control.initial.instanceId)
                  : PubSub.publish(control.changes, old)
              ).pipe(Effect.forkChild);
              yield* Deferred.await(oldWriteStarted);
              yield* Ref.set(control.next, current);
              const newer = yield* registry
                .refreshInstance(control.initial.instanceId)
                .pipe(Effect.forkChild);
              // Let the newer publication attempt run while the older atomic rename is paused.
              yield* Effect.yieldNow;
              yield* Deferred.succeed(releaseOldWrite, undefined);
              yield* Fiber.join(older);
              yield* Fiber.join(newer);
              yield* Effect.yieldNow;
              assert.deepStrictEqual(
                {
                  authoritative: (yield* registry.getProviders).find(
                    (p) => p.instanceId === control.initial.instanceId,
                  ),
                  persisted: yield* readProviderStatusCache(
                    yield* cachePath(control.initial.instanceId),
                  ).pipe(Effect.provideService(FileSystem.FileSystem, memoryFs)),
                  streamed: (yield* Ref.get(published)).find(
                    (p) => p.instanceId === control.initial.instanceId,
                  ),
                },
                { authoritative: current, persisted: current, streamed: current },
              );
            }),
        );
      }

      it.effect("persists the merged snapshot when a live update has empty models", () =>
        Effect.gen(function* () {
          const cursorDriver = ProviderDriverKind.make("cursor");
          const cursorInstanceId = ProviderInstanceId.make("cursor");
          const initialProvider = {
            instanceId: cursorInstanceId,
            driver: cursorDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshedProvider = {
            ...initialProvider,
            checkedAt: "2026-04-14T00:01:00.000Z",
            models: [],
          } satisfies ServerProvider;
          const changes = yield* PubSub.unbounded<ServerProvider>();
          const instance = {
            instanceId: cursorInstanceId,
            driverKind: cursorDriver,
            continuationIdentity: {
              driverKind: cursorDriver,
              continuationKey: "cursor:instance:cursor",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: cursorDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              revalidate: Effect.succeed(initialProvider),
              refresh: Effect.succeed(refreshedProvider),
              streamChanges: Stream.fromPubSub(changes),
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "ryco-provider-registry-merged-persist-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            const config = yield* ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: cursorInstanceId,
            });

            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
              ...initialProvider.models,
            ]);
            yield* PubSub.publish(changes, refreshedProvider);

            let cachedProvider = yield* readProviderStatusCache(filePath);
            for (
              let attempt = 0;
              attempt < 50 && cachedProvider?.checkedAt !== refreshedProvider.checkedAt;
              attempt += 1
            ) {
              yield* Effect.yieldNow;
              cachedProvider = yield* readProviderStatusCache(filePath);
            }

            assert.deepStrictEqual(cachedProvider, {
              ...refreshedProvider,
              models: [...initialProvider.models],
            });
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("returns the cached provider list when a manual refresh fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const cachedProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [{ name: "retained" }],
            skills: [{ name: "retained", path: "/skills/retained/SKILL.md", enabled: true }],
          } as const satisfies ServerProvider;
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(cachedProvider),
              revalidate: Effect.succeed(cachedProvider),
              refresh: Effect.die(new Error("simulated refresh failure")),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "ryco-provider-registry-refresh-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;

            assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refresh(codexDriver), [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
              cachedProvider,
            ]);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("does not block registry startup on initial provider refresh", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const initialProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshedProvider = {
            ...initialProvider,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:01:00.000Z",
          } as const satisfies ServerProvider;
          const releaseRefresh = yield* Deferred.make<void>();
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              revalidate: Effect.succeed(initialProvider),
              refresh: Deferred.await(releaseRefresh).pipe(Effect.as(refreshedProvider)),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "ryco-provider-registry-initial-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [initialProvider]);

            yield* Deferred.succeed(releaseRefresh, undefined);
            let providers = yield* registry.getProviders;
            for (
              let attempt = 0;
              attempt < 50 && providers[0]?.checkedAt !== refreshedProvider.checkedAt;
              attempt += 1
            ) {
              yield* Effect.yieldNow;
              providers = yield* registry.getProviders;
            }

            assert.deepStrictEqual(providers, [refreshedProvider]);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("keeps consuming registry changes after one sync fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
          const codexProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const claudeProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:01:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const makeInstance = (provider: ServerProvider): ProviderInstance => ({
            instanceId: provider.instanceId,
            driverKind: provider.driver,
            continuationIdentity: {
              driverKind: provider.driver,
              continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              revalidate: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const codexInstance = makeInstance(codexProvider);
          const claudeInstance = makeInstance(claudeProvider);
          const changes = yield* PubSub.unbounded<void>();
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([codexInstance]);
          const failNextList = yield* Ref.make(false);
          const wait = (millis: number) =>
            Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, millis)));
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Ref.get(instancesRef).pipe(
                Effect.map((instances) =>
                  instances.find((instance) => instance.instanceId === instanceId),
                ),
              ),
            listInstances: Effect.gen(function* () {
              const shouldFail = yield* Ref.get(failNextList);
              if (shouldFail) {
                yield* Ref.set(failNextList, false);
                return yield* Effect.die(new Error("simulated registry list failure"));
              }
              return yield* Ref.get(instancesRef);
            }),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "ryco-provider-registry-sync-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [codexProvider]);

            yield* Ref.set(failNextList, true);
            yield* PubSub.publish(changes, undefined);

            yield* Ref.set(instancesRef, [codexInstance, claudeInstance]);
            yield* PubSub.publish(changes, undefined);

            let providers = yield* registry.getProviders;
            for (
              let attempt = 0;
              attempt < 50 &&
              !providers.some((provider) => provider.instanceId === claudeInstanceId);
              attempt += 1
            ) {
              yield* wait(10);
              providers = yield* registry.getProviders;
            }

            assert.deepStrictEqual(
              providers.map((provider) => provider.instanceId).toSorted(),
              [codexInstanceId, claudeInstanceId].toSorted(),
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // This test intentionally avoids `mockCommandSpawnerLayer` so the real
      // `probeCodexAppServerProvider` path runs — including the full
      // `codex app-server` RPC handshake via `CodexClient.layerCommand`.
      // We point `binaryPath` at a name that cannot exist on any machine so
      // the real `ChildProcessSpawner` deterministically returns ENOENT; the
      // probe wraps that as `CodexAppServerSpawnError` and
      // `checkCodexProviderStatus` turns it into the user-visible "not
      // installed" error snapshot. If the aggregator's `syncLiveSources`
      // breaks — the `codex_personal`-never-probes bug we are guarding
      // against — that snapshot never lands in `getProviders` and the
      // assertions below fail.
      it.effect("propagates real Codex probe failures to the aggregator at boot", () =>
        Effect.gen(function* () {
          const missingBinary = `ryco_codex_missing_${process.pid}_${Date.now()}`;
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  // Disable every built-in probe that would otherwise spawn
                  // on the CI host. `enabled: false` short-circuits each
                  // driver's probe *before* it touches the spawner, so the
                  // test environment stays isolated from the dev
                  // machine's PATH.
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                },
                // `providerInstances` keys are branded `ProviderInstanceId`;
                // the branded index signature rejects plain string literals
                // at the TS level even though the runtime schema happily
                // accepts + decodes them. Cast the patch to `unknown` so
                // the `Schema.decodeSync` below does the real validation.
                providerInstances: {
                  // Matches the shape the user had in `.ryco/dev/settings.json`
                  // when the bug was reported: a custom enabled Codex instance
                  // pointing at a binary the server has to actually spawn.
                  codex_personal: {
                    driver: "codex",
                    displayName: "Codex Personal",
                    enabled: true,
                    config: {
                      binaryPath: missingBinary,
                      homePath: `/tmp/${missingBinary}_home`,
                    },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "ryco-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            Layer.provideMerge(OpenCodeRuntimeLive),
            // NO spawner mock — `ChildProcessSpawner` is supplied by the
            // outer `NodeServices.layer` on `it.layer(...)` and will
            // genuinely spawn a subprocess. The missing-binary ENOENT is
            // what exercises the same failure mode as a misconfigured
            // production `binaryPath`.
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            const providers = yield* Effect.gen(function* () {
              for (let attempts = 0; attempts < 100; attempts += 1) {
                const current = yield* registry.getProviders;
                const codex = current.find((provider) => provider.instanceId === "codex_personal");
                if (codex?.status === "error") {
                  return current;
                }
                yield* Effect.yieldNow;
              }
              return yield* registry.getProviders;
            });
            const codexPersonal = providers.find(
              (provider) => provider.instanceId === "codex_personal",
            );
            assert.notStrictEqual(
              codexPersonal,
              undefined,
              `Expected the aggregator to know about codex_personal; instead saw: ${providers
                .map((provider) => provider.instanceId)
                .join(", ")}`,
            );
            assert.strictEqual(
              codexPersonal?.status,
              "error",
              "Real Codex probe against a missing binary should surface as 'error' in the aggregator",
            );
            assert.strictEqual(codexPersonal?.installed, false);
            assert.strictEqual(
              codexPersonal?.message,
              "Codex CLI (`codex`) is not installed or not on PATH.",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // Guards the second half of the reported bug: changing
      // `providers.codex.binaryPath` in settings must tear down the live
      // instance and rebuild it so a fresh probe runs with the new binary.
      // This test drives the real settings stream → registry reconcile →
      // aggregator sync pipeline and asserts that `getProviders` reflects
      // the new probe's outcome. If `syncLiveSources` stops awaiting the
      // rebuilt instance's refresh (previous bug mode), the aggregator
      // keeps the old snapshot and this test fails.
      //
      // `live` (imported from `@effect/vitest`) is used instead of
      // `it.effect` so real timers coordinate the fibres that drive the
      // settings → reconcile → sync pipeline. Under `it.effect`'s
      // TestClock, `Effect.sleep` blocks until `TestClock.adjust`, which
      // would require this test to reach into the internals of the
      // reconcile pipeline to advance it step by step.
      //
      // The nested `it` handed to `it.layer(…, (it) => …)` is the
      // `MethodsNonLive` variant and therefore lacks `.live`; the
      // top-level `live` export from `@effect/vitest` is the equivalent.
      live("re-probes when settings change the codex binaryPath", () =>
        Effect.gen(function* () {
          const firstMissing = `ryco_codex_first_${process.pid}_${Date.now()}`;
          const secondMissing = `ryco_codex_second_${process.pid}_${Date.now()}`;
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: true, binaryPath: firstMissing },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "ryco-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            Layer.provideMerge(OpenCodeRuntimeLive),
            // `it.live` does not inherit layers from the outer `it.layer`
            // wrapper, so provide `NodeServices.layer` inline. This is the
            // same real `ChildProcessSpawner` + `FileSystem` + `Path`
            // services that production uses.
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            // Boot-time probe: the default codex instance is enabled with
            // `firstMissing`, so the real spawner yields ENOENT and the
            // background refresh eventually reports `status: "error"`.
            // What *distinguishes* the two probe runs is `checkedAt` —
            // each probe stamps a fresh DateTime, so we capture it and
            // assert it advances after the settings mutation.
            const initialProviders = yield* Effect.gen(function* () {
              for (let attempts = 0; attempts < 60; attempts += 1) {
                const providers = yield* registry.getProviders;
                const codex = providers.find((provider) => provider.instanceId === "codex");
                if (codex?.status === "error") {
                  return providers;
                }
                yield* Effect.sleep("50 millis");
              }
              return yield* registry.getProviders;
            });
            const initialCodex = initialProviders.find(
              (provider) => provider.instanceId === "codex",
            );
            assert.strictEqual(initialCodex?.status, "error");
            assert.strictEqual(initialCodex?.installed, false);
            const initialCheckedAt = initialCodex?.checkedAt;
            assert.notStrictEqual(initialCheckedAt, undefined);

            // Drive a settings change. The Hydration layer's
            // `SettingsWatcherLive` consumes this via `streamChanges`,
            // calls `reconcile`, which rebuilds the codex instance (the
            // envelope changed because `binaryPath` differs → `entryEqual`
            // is false). The registry's `Stream.runForEach(
            // instanceRegistry.streamChanges, () => syncLiveSources)`
            // fires `syncLiveSources`, which subscribes + awaits a fresh
            // refresh on the rebuilt instance.
            yield* serverSettings.updateSettings({
              providers: {
                codex: { enabled: true, binaryPath: secondMissing },
              },
            });

            // Poll with real timers (via `it.live`) until `checkedAt`
            // advances or we hit a generous 3-second ceiling. Anything
            // slower than that is a regression — the real probe fails
            // fast on ENOENT, and the reconcile + sync pipeline is
            // purely in-process.
            const refreshed = yield* Effect.gen(function* () {
              for (let attempts = 0; attempts < 60; attempts += 1) {
                const providers = yield* registry.getProviders;
                const codex = providers.find((provider) => provider.instanceId === "codex");
                if (codex !== undefined && codex.checkedAt !== initialCheckedAt) {
                  return providers;
                }
                yield* Effect.sleep("50 millis");
              }
              return yield* registry.getProviders;
            });

            const reprobedCodex = refreshed.find((provider) => provider.instanceId === "codex");
            assert.notStrictEqual(
              reprobedCodex?.checkedAt,
              initialCheckedAt,
              "Expected a fresh probe after settings change, got the stale snapshot",
            );
            assert.strictEqual(reprobedCodex?.status, "error");
            assert.strictEqual(reprobedCodex?.installed, false);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("includes unavailable instance snapshots in getProviders", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                },
                providerInstances: {
                  ghost_main: {
                    driver: "ghostDriver",
                    displayName: "A fork-only driver we don't ship",
                    enabled: false,
                    config: { arbitrary: "payload" },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "ryco-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            Layer.provideMerge(OpenCodeRuntimeLive),
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            const providers = yield* registry.getProviders;
            const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

            assert.notStrictEqual(ghost, undefined);
            assert.strictEqual(ghost?.driver, "ghostDriver");
            assert.strictEqual(ghost?.availability, "unavailable");
            assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "keeps cursor disabled and skips probing when the provider setting is disabled",
        () =>
          Effect.gen(function* () {
            const serverSettings = yield* makeMutableServerSettingsService(
              Schema.decodeSync(ServerSettings)(
                deepMerge(DEFAULT_SERVER_SETTINGS, {
                  providers: {
                    codex: {
                      enabled: false,
                    },
                    cursor: {
                      enabled: false,
                    },
                  },
                }),
              ),
            );
            let cursorSpawned = false;
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const providerRegistryLayer = ProviderRegistryLive.pipe(
              Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "ryco-provider-registry-",
                }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
              Layer.provideMerge(OpenCodeRuntimeLive),
              Layer.provideMerge(
                mockCommandSpawnerLayer((command, args) => {
                  if (command === "agent") {
                    cursorSpawned = true;
                  }
                  const joined = args.join(" ");
                  if (joined === "--version") {
                    return {
                      stdout: `${command} 1.0.0\n`,
                      stderr: "",
                      code: 0,
                    };
                  }
                  if (joined === "auth status") {
                    return {
                      stdout: '{"authenticated":true}\n',
                      stderr: "",
                      code: 0,
                    };
                  }
                  throw new Error(`Unexpected args: ${command} ${joined}`);
                }),
              ),
            );
            const runtimeServices = yield* Layer.build(
              Layer.mergeAll(
                Layer.succeed(ServerSettingsService, serverSettings),
                providerRegistryLayer,
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry;
              const providers = yield* registry.getProviders;
              const cursorProvider = providers.find(
                (provider) => provider.instanceId === ProviderInstanceId.make("cursor"),
              );

              assert.deepStrictEqual(providers.map((provider) => provider.instanceId).toSorted(), [
                "claudeAgent",
                "codex",
                "copilot",
                "cursor",
                "grok",
                "opencode",
              ]);
              assert.strictEqual(cursorProvider?.enabled, false);
              assert.strictEqual(cursorProvider?.status, "disabled");
              assert.strictEqual(cursorProvider?.message, "Cursor is disabled in Ryco settings.");
              assert.strictEqual(cursorSpawned, false);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(disabledCodexSettings).pipe(
            Effect.provide(failingSpawnerLayer("spawn codex ENOENT")),
          );
          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in Ryco settings.");
        }),
      );
    });

    // ── checkClaudeProviderStatus tests ──────────────────────────

    describe("checkClaudeProviderStatus", () => {
      it.effect("returns ready when claude is installed and authenticated", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes Claude OAuth usage limits when the usage probe succeeds", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
            process.env,
            () =>
              Effect.succeed({
                limitId: "claude-oauth",
                limitName: "Claude Max Subscription",
                planType: "Claude Max Subscription",
                primary: {
                  usedPercent: 42,
                  windowDurationMins: 300,
                },
                secondary: {
                  usedPercent: 7,
                  windowDurationMins: 10_080,
                },
              }),
          );

          assert.deepStrictEqual(status.rateLimits, {
            limitId: "claude-oauth",
            limitName: "Claude Max Subscription",
            planType: "Claude Max Subscription",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
            },
            secondary: {
              usedPercent: 7,
              windowDurationMins: 10_080,
            },
          });
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect(
        "includes Claude Opus 4.7 with fast mode and xhigh as the default effort on supported versions",
        () =>
          Effect.gen(function* () {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              claudeCapabilities(),
            );
            const opus47 = status.models.find((model) => model.slug === "claude-opus-4-7");
            if (!opus47) {
              assert.fail("Expected Claude Opus 4.7 to be present for Claude Code v2.1.111.");
            }
            if (!opus47.capabilities) {
              assert.fail(
                "Expected Claude Opus 4.7 capabilities to be present for Claude Code v2.1.111.",
              );
            }
            const effortDescriptor = opus47.capabilities.optionDescriptors?.find(
              (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
            );
            assert.deepStrictEqual(
              effortDescriptor?.type === "select"
                ? effortDescriptor.options.find((option) => option.isDefault)
                : undefined,
              { id: "xhigh", label: "Extra High", isDefault: true },
            );
            assert.deepStrictEqual(
              opus47.capabilities.optionDescriptors?.find(
                (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
              ),
              { id: "fastMode", label: "Fast Mode", type: "boolean" },
            );
            assert.strictEqual(
              status.models.some((model) => model.slug === "claude-opus-4-8"),
              false,
            );
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "2.1.111\n", stderr: "", code: 0 };
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          ),
      );

      it.effect(
        "includes Claude Opus 4.8 with fast mode and high as the default effort on supported versions",
        () =>
          Effect.gen(function* () {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              claudeCapabilities(),
            );
            const opus48 = status.models.find((model) => model.slug === "claude-opus-4-8");
            if (!opus48) {
              assert.fail("Expected Claude Opus 4.8 to be present for Claude Code v2.1.154.");
            }
            if (!opus48.capabilities) {
              assert.fail(
                "Expected Claude Opus 4.8 capabilities to be present for Claude Code v2.1.154.",
              );
            }
            const effortDescriptor = opus48.capabilities.optionDescriptors?.find(
              (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
            );
            assert.deepStrictEqual(
              effortDescriptor?.type === "select"
                ? effortDescriptor.options.find((option) => option.isDefault)
                : undefined,
              { id: "high", label: "High", isDefault: true },
            );
            assert.deepStrictEqual(
              effortDescriptor?.type === "select"
                ? effortDescriptor.options.find((option) => option.id === "xhigh")
                : undefined,
              { id: "xhigh", label: "Extra High" },
            );
            assert.deepStrictEqual(
              effortDescriptor?.type === "select"
                ? effortDescriptor.options.find((option) => option.id === "ultracode")
                : undefined,
              { id: "ultracode", label: "Ultracode" },
            );
            assert.deepStrictEqual(
              opus48.capabilities.optionDescriptors?.find(
                (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
              ),
              { id: "fastMode", label: "Fast Mode", type: "boolean" },
            );
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "2.1.154\n", stderr: "", code: 0 };
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          ),
      );

      it.effect("includes Claude Opus 5 with the upstream static capabilities", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          const opus5 = status.models.find((model) => model.slug === "claude-opus-5");
          if (!opus5?.capabilities) {
            assert.fail("Expected Claude Opus 5 capabilities on Claude Code v2.1.219.");
          }

          const effortDescriptor = opus5.capabilities.optionDescriptors?.find(
            (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
          );
          assert.deepStrictEqual(
            effortDescriptor?.type === "select"
              ? effortDescriptor.options.map((option) => option.id)
              : undefined,
            ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
          );
          assert.deepStrictEqual(
            effortDescriptor?.type === "select"
              ? effortDescriptor.options.find((option) => option.isDefault)
              : undefined,
            { id: "high", label: "High", isDefault: true },
          );
          assert.deepStrictEqual(
            opus5.capabilities.optionDescriptors?.find(
              (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
            ),
            { id: "fastMode", label: "Fast Mode", type: "boolean" },
          );

          const contextWindowDescriptor = opus5.capabilities.optionDescriptors?.find(
            (descriptor) => descriptor.type === "select" && descriptor.id === "contextWindow",
          );
          assert.deepStrictEqual(
            contextWindowDescriptor?.type === "select"
              ? contextWindowDescriptor.options.find((option) => option.isDefault)
              : undefined,
            { id: "1m", label: "1M", isDefault: true },
          );
          assert.strictEqual(
            resolveClaudeApiModelId(
              createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5", []),
            ),
            "claude-opus-5[1m]",
          );
          assert.strictEqual(normalizeClaudeCliEffort("ultracode", "claude-opus-5"), "xhigh");
          assert.strictEqual(
            resolveClaudeApiModelId(
              createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5", [
                { id: "contextWindow", value: "200k" },
              ]),
            ),
            "claude-opus-5",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.219\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Opus 5 before Claude Code v2.1.219", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-5"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.218 is too old for Claude Opus 5. Upgrade to v2.1.219 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.218\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes Claude Fable 5 without fast mode on supported versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          const fable = status.models.find((model) => model.slug === "claude-fable-5");
          if (!fable) {
            assert.fail("Expected Claude Fable 5 to be present for Claude Code v2.2.0.");
          }
          if (!fable.capabilities) {
            assert.fail("Expected Claude Fable 5 capabilities to be present.");
          }
          const effortDescriptor = fable.capabilities.optionDescriptors?.find(
            (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
          );
          assert.deepStrictEqual(
            effortDescriptor?.type === "select"
              ? effortDescriptor.options.map((option) => option.id)
              : undefined,
            ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
          );
          assert.deepStrictEqual(
            effortDescriptor?.type === "select"
              ? effortDescriptor.options.find((option) => option.isDefault)
              : undefined,
            { id: "high", label: "High", isDefault: true },
          );
          assert.strictEqual(normalizeClaudeCliEffort("ultracode", "claude-fable-5"), "xhigh");
          // Fast mode is Opus-only — Fable must not expose it.
          assert.strictEqual(
            fable.capabilities.optionDescriptors?.some(
              (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
            ),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.2.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Fable 5 on Claude Code versions before its minimum", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-fable-5"),
            false,
          );
          // Opus 4.8 remains available even though newer models are still gated.
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-8"),
            true,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.193\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("exposes compatible max effort on Sonnet 4.6 and omits fast mode on Opus 4.5", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          // Sonnet 4.6 exposes `max` in the UI and normalizes it to the
          // SDK/CLI-supported `high` effort (see ClaudeAdapter.test).
          const sonnet = status.models.find((model) => model.slug === "claude-sonnet-4-6");
          const sonnetEffort = sonnet?.capabilities?.optionDescriptors?.find(
            (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
          );
          assert.deepStrictEqual(
            sonnetEffort?.type === "select"
              ? sonnetEffort.options.find((option) => option.id === "max")
              : undefined,
            { id: "max", label: "Max" },
          );
          assert.strictEqual(normalizeClaudeCliEffort("max", "claude-sonnet-4-6"), "high");
          // Fast mode is only available on Opus 4.6+, so 4.5 must not expose it.
          const opus45 = status.models.find((model) => model.slug === "claude-opus-4-5");
          assert.strictEqual(
            opus45?.capabilities?.optionDescriptors?.some(
              (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
            ),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.154\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Opus 4.8 on Claude Code versions before v2.1.154", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-8"),
            false,
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-7"),
            true,
          );
          assert.strictEqual(
            status.message,
            // The upgrade nudge names only the model with the lowest unmet
            // minimum: the smallest upgrade that unlocks something.
            "Claude Code v2.1.153 is too old for Claude Opus 4.8. Upgrade to v2.1.154 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.153\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Opus 4.7 and 4.8 on older Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-7"),
            false,
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-8"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.110 is too old for Claude Opus 4.7. Upgrade to v2.1.111 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.110\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns a display label for claude subscription types", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ subscriptionType: "maxplan" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "maxplan");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in full subscription labels", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max Subscription",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max Subscription");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in provider-prefixed subscription names", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns claude auth email from initialization result", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ email: "claude@example.com" }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.email, "claude@example.com");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout:
                    '{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"claude@example.com"}}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("runs Claude status probes with the configured Claude HOME", () => {
        const claudeHome = "/tmp/ryco-claude-home";
        const recorded = recordingMockSpawnerLayer((args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
          if (joined === "auth status")
            return {
              stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
              stderr: "",
              code: 0,
            };
          throw new Error(`Unexpected args: ${joined}`);
        });

        return Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            {
              ...defaultClaudeSettings,
              homePath: claudeHome,
            },
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.deepStrictEqual(
            recorded.commands.map((command) => command.env?.HOME),
            [claudeHome],
          );
        }).pipe(Effect.provide(recorded.layer));
      });

      it.effect("includes probed claude slash commands in the provider snapshot", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "review",
                  description: "Review a pull request",
                  input: { hint: "pr-or-branch" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "review",
              description: "Review a pull request",
              input: { hint: "pr-or-branch" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("deduplicates probed claude slash commands by name", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "ui",
                  description: "Explore and refine UI",
                },
                {
                  name: "ui",
                  input: { hint: "component-or-screen" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "ui",
              description: "Explore and refine UI",
              input: { hint: "component-or-screen" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for claude api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "Claude API Key");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unavailable when claude is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent CLI (`claude`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
      );

      it.effect("returns error when version check fails with non-zero exit code", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version")
                return {
                  stdout: "",
                  stderr: "Something went wrong",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns warning when the Claude initialization result is unavailable", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Could not verify Claude authentication status from initialization result.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false}\n',
                  stderr: "",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
