import { PassThrough } from "node:stream";

import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert, live } from "@effect/vitest";
import {
  Context,
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
  type ServerProviderRateLimits,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@ryco/contracts";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { deepMerge } from "@ryco/shared/Struct";
import { TestClock } from "effect/testing";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import {
  checkClaudeProviderStatus,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
} from "./ClaudeProvider.ts";
import type { ClaudeCredentialStore } from "./ClaudeUsage.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { AgentProcessPriorityOffLive } from "../agentProcessPriority.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";
import {
  haveProvidersChanged,
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  ProviderRegistryLive,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";
import { ServerConfig } from "../../config.ts";
import {
  attachDesktopLifecycleChannel,
  DESKTOP_STARTUP_PROVIDERS_READY_PHASE,
  detachDesktopLifecycleChannelForTests,
} from "../../desktopLifecycle.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import {
  readProviderStatusCache,
  readProviderStatusCacheEntry,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceBootGate } from "../Services/ProviderInstanceBootGate.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { BUNDLED_MODEL_MANIFEST, ModelManifest, type ModelManifestData } from "../ModelManifest.ts";

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
          maintenanceCapabilities: Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: initial.driver,
              packageName: null,
            }),
          ),
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
    // Building the registry never probes; seed every source with one explicit refresh.
    yield* registry.refresh();
    yield* Effect.forEach(controls, (control) => Deferred.await(control.booted));
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

// The hydration layer builds drivers only once the server listens and releases the boot gate.
const openProviderBootGate = Effect.gen(function* () {
  const gate = yield* ProviderInstanceBootGate;
  yield* gate.awaitInitialReconcile;
});

const pollProviders = (predicate: (providers: ReadonlyArray<ServerProvider>) => boolean) =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    let providers = yield* registry.getProviders;
    for (let attempt = 0; attempt < 200 && !predicate(providers); attempt += 1) {
      yield* Effect.yieldNow;
      providers = yield* registry.getProviders;
    }
    return providers;
  });

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

// A Claude instance routed through a local proxy such as CLIProxyAPI.
const PROXIED_CLAUDE_ENVIRONMENT = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
  ANTHROPIC_AUTH_TOKEN: "proxy-token",
  ANTHROPIC_API_KEY: "",
};

const CLAUDE_USAGE_FIXTURE: ServerProviderRateLimits = {
  limitId: "claude-oauth",
  primary: { usedPercent: 42, windowDurationMins: 300 },
};

function recordingClaudeUsageProbe() {
  const stores: Array<ClaudeCredentialStore> = [];
  const probe = (store: ClaudeCredentialStore) =>
    Effect.sync(() => {
      stores.push(store);
      return CLAUDE_USAGE_FIXTURE;
    });
  return { probe, stores };
}

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

const claudeVersionSpawnerLayer = mockSpawnerLayer((args) => {
  const joined = args.join(" ");
  if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
  throw new Error(`Unexpected args: ${joined}`);
});

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
      withSettingsSnapshot: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = Schema.decodeSync(ServerSettings)(applyServerSettingsPatch(current, patch));
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
              maintenanceCapabilities: Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: cursorDriver,
                  packageName: null,
                }),
              ),
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
            // The per-instance change subscription starts in a forked fiber.
            for (let attempt = 0; attempt < 5; attempt += 1) yield* Effect.yieldNow;
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
              maintenanceCapabilities: Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: codexDriver,
                  packageName: null,
                }),
              ),
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

      it.effect("never probes while building; a client revalidation probes in the background", () =>
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
          const probes = yield* Ref.make(0);
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
              maintenanceCapabilities: Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: codexDriver,
                  packageName: null,
                }),
              ),
              getSnapshot: Effect.succeed(initialProvider),
              isFresh: Effect.succeed(false),
              revalidate: Ref.update(probes, (count) => count + 1).pipe(
                Effect.andThen(Deferred.await(releaseRefresh)),
                Effect.as(refreshedProvider),
              ),
              refresh: Effect.die(new Error("explicit refresh is not expected")),
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
            for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
            assert.strictEqual(yield* Ref.get(probes), 0);

            const revalidation = yield* registry.revalidateStale.pipe(Effect.forkChild);
            // Background probes start staggered; the first waits one stagger interval.
            yield* TestClock.adjust("1 second");
            yield* Deferred.succeed(releaseRefresh, undefined);
            const providers = yield* Fiber.join(revalidation);

            assert.deepStrictEqual(providers, [refreshedProvider]);
            assert.strictEqual(yield* Ref.get(probes), 1);
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
              maintenanceCapabilities: Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: provider.driver,
                  packageName: null,
                }),
              ),
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
      it.effect("propagates real Codex probe failures to the aggregator once probed", () =>
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
            Layer.provideMerge(AgentProcessPriorityOffLive),
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
            yield* openProviderBootGate;
            yield* pollProviders((current) =>
              current.some((provider) => provider.instanceId === "codex_personal"),
            );
            yield* registry.refreshInstance(ProviderInstanceId.make("codex_personal"));
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
            Layer.provideMerge(AgentProcessPriorityOffLive),
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
            yield* openProviderBootGate;
            for (let attempts = 0; attempts < 60; attempts += 1) {
              const providers = yield* registry.getProviders;
              if (providers.some((provider) => provider.instanceId === "codex")) break;
              yield* Effect.sleep("10 millis");
            }
            // First probe on demand: the default codex instance is enabled with
            // `firstMissing`, so the real spawner yields ENOENT and the
            // probe reports `status: "error"`.
            yield* registry.refreshInstance(ProviderInstanceId.make("codex"));
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

      it.effect("builds provider drivers only once the boot gate opens", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                  copilot: { enabled: false },
                  grok: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-boot-gate-" }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
              Layer.provideMerge(AgentProcessPriorityOffLive),
              Layer.provideMerge(OpenCodeRuntimeLive),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const instanceRegistry = yield* ProviderInstanceRegistry;
            for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
            assert.deepStrictEqual(yield* instanceRegistry.listInstances, []);
            const configured = yield* instanceRegistry.listConfigured!;
            assert.deepStrictEqual(configured.map((identity) => identity.instanceId).toSorted(), [
              "claudeAgent",
              "codex",
              "copilot",
              "cursor",
              "grok",
              "opencode",
            ]);
            assert.isTrue(configured.every((identity) => identity.enabled === false));

            yield* openProviderBootGate;
            assert.deepStrictEqual(
              (yield* instanceRegistry.listInstances)
                .map((instance) => instance.instanceId)
                .toSorted(),
              ["claudeAgent", "codex", "copilot", "cursor", "grok", "opencode"],
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("builds from the settings current when the gate opens and reports them", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                  copilot: { enabled: false },
                  grok: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderInstanceRegistryHydrationLive.pipe(
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-boot-current-" }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
              Layer.provideMerge(AgentProcessPriorityOffLive),
              Layer.provideMerge(OpenCodeRuntimeLive),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const instanceRegistry = yield* ProviderInstanceRegistry;
            const codexIdentity = Effect.map(instanceRegistry.listConfigured!, (identities) =>
              identities.find((identity) => identity.instanceId === "codex"),
            );
            // Construction never probes, so enabling a missing binary spawns nothing here.
            yield* serverSettings.updateSettings({
              providers: { codex: { enabled: true, binaryPath: "ryco-codex-not-installed" } },
            });
            // Until the build starts, the boot read is what is configured.
            assert.strictEqual((yield* codexIdentity)?.enabled, false);

            yield* openProviderBootGate;
            assert.strictEqual((yield* codexIdentity)?.enabled, true);
            const codex = yield* instanceRegistry.getInstance(ProviderInstanceId.make("codex"));
            assert.strictEqual(codex?.enabled, true);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("builds only the requested driver on demand before the boot gate opens", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                  copilot: { enabled: false },
                  grok: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderInstanceRegistryHydrationLive.pipe(
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-boot-demand-" }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
              Layer.provideMerge(AgentProcessPriorityOffLive),
              Layer.provideMerge(OpenCodeRuntimeLive),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const instanceRegistry = yield* ProviderInstanceRegistry;
            const codex = yield* instanceRegistry.getInstance(ProviderInstanceId.make("codex"));
            assert.strictEqual(codex?.instanceId, "codex");
            // Unknown ids never wait for (or trigger) the deferred build.
            assert.strictEqual(
              yield* instanceRegistry.getInstance(ProviderInstanceId.make("ghost")),
              undefined,
            );
            // Only the requested driver is built; the gate stays closed for the others.
            for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
            assert.deepStrictEqual(
              (yield* instanceRegistry.listInstances).map((instance) => instance.instanceId),
              ["codex"],
            );
            const opencode = yield* instanceRegistry.getInstance(
              ProviderInstanceId.make("opencode"),
            );
            assert.strictEqual(opencode?.instanceId, "opencode");
            assert.deepStrictEqual(
              (yield* instanceRegistry.listInstances)
                .map((instance) => instance.instanceId)
                .toSorted(),
              ["codex", "opencode"],
            );

            // Opening the gate builds the rest and keeps the instances built on demand.
            yield* openProviderBootGate;
            assert.deepStrictEqual(
              (yield* instanceRegistry.listInstances)
                .map((instance) => instance.instanceId)
                .toSorted(),
              ["claudeAgent", "codex", "copilot", "cursor", "grok", "opencode"],
            );
            assert.strictEqual(
              yield* instanceRegistry.getInstance(ProviderInstanceId.make("codex")),
              codex,
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("keeps the persisted snapshots of instances not yet built on demand", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                  copilot: { enabled: false },
                  grok: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const base = yield* Layer.build(
            ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-boot-partial-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));
          const config = Context.get(base, ServerConfig);
          const opencodeId = ProviderInstanceId.make("opencode");
          const persistedOpencode: ServerProvider = {
            instanceId: opencodeId,
            driver: ProviderDriverKind.make("opencode"),
            enabled: false,
            installed: true,
            version: "1.0.0",
            status: "disabled",
            auth: { status: "unknown" },
            checkedAt: "2026-10-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          };
          yield* writeProviderStatusCache({
            filePath: yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: opencodeId,
            }),
            provider: persistedOpencode,
          }).pipe(Effect.provide(base));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
              Layer.provideMerge(AgentProcessPriorityOffLive),
              Layer.provideMerge(OpenCodeRuntimeLive),
              Layer.provideMerge(Layer.succeedContext(base)),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const instanceRegistry = yield* ProviderInstanceRegistry;
            const opencodeSnapshot = (providers: ReadonlyArray<ServerProvider>) =>
              providers.find((provider) => provider.instanceId === opencodeId);
            assert.strictEqual(
              opencodeSnapshot(yield* (yield* ProviderRegistry).getProviders)?.checkedAt,
              persistedOpencode.checkedAt,
            );

            // A pre-gate consumer builds codex alone; the registry adopts its arrival.
            const codex = yield* instanceRegistry.getInstance(ProviderInstanceId.make("codex"));
            assert.strictEqual(codex?.instanceId, "codex");
            const providers = yield* pollProviders((current) =>
              current.some((provider) => provider.instanceId === "codex"),
            );
            assert.isTrue(providers.some((provider) => provider.instanceId === "codex"));
            assert.deepStrictEqual(
              (yield* instanceRegistry.listInstances).map((instance) => instance.instanceId),
              ["codex"],
            );
            // opencode is still waiting for the gate and keeps its persisted snapshot.
            assert.strictEqual(opencodeSnapshot(providers)?.checkedAt, persistedOpencode.checkedAt);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("reports the providers-ready milestone once the initial build settles", () =>
        Effect.gen(function* () {
          const channel = new PassThrough();
          const chunks: Array<string> = [];
          channel.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
          detachDesktopLifecycleChannelForTests();
          attachDesktopLifecycleChannel(channel);
          yield* Effect.addFinalizer(() => Effect.sync(detachDesktopLifecycleChannelForTests));
          const milestones = Effect.promise(
            () => new Promise((resolve) => setImmediate(resolve)),
          ).pipe(
            Effect.map(() =>
              chunks
                .join("")
                .split("\n")
                .filter((line) => line.length > 0)
                .map((line) => JSON.parse(line) as { name?: string; durationMs?: number })
                .filter((frame) => frame.durationMs === undefined)
                .map((frame) => frame.name),
            ),
          );
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  opencode: { enabled: false },
                  copilot: { enabled: false },
                  grok: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderInstanceRegistryHydrationLive.pipe(
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-boot-ready-" }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
              Layer.provideMerge(AgentProcessPriorityOffLive),
              Layer.provideMerge(OpenCodeRuntimeLive),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const instanceRegistry = yield* ProviderInstanceRegistry;
            // An on-demand build before the gate opens is not the initial build.
            yield* instanceRegistry.getInstance(ProviderInstanceId.make("codex"));
            assert.deepStrictEqual(yield* milestones, []);

            yield* openProviderBootGate;
            assert.deepStrictEqual(yield* milestones, [DESKTOP_STARTUP_PROVIDERS_READY_PHASE]);
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
            Layer.provideMerge(AgentProcessPriorityOffLive),
            Layer.provideMerge(OpenCodeRuntimeLive),
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            yield* openProviderBootGate;
            const providers = yield* pollProviders(
              (current) =>
                current.some((provider) => provider.instanceId === "ghost_main") &&
                current.some((provider) => provider.instanceId === "cursor"),
            );
            const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

            assert.notStrictEqual(ghost, undefined);
            assert.strictEqual(ghost?.driver, "ghostDriver");
            assert.strictEqual(ghost?.availability, "unavailable");
            assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
            // Unavailable shadows have no adapter, so revert support stays unknown.
            assert.strictEqual(ghost?.supportsConversationRollback, undefined);
            // Every live snapshot carries its adapter's rollback capability.
            const rollbackSupport = (instanceId: string) =>
              providers.find((provider) => provider.instanceId === instanceId)
                ?.supportsConversationRollback;
            assert.strictEqual(rollbackSupport("claudeAgent"), true);
            assert.strictEqual(rollbackSupport("codex"), true);
            assert.strictEqual(rollbackSupport("opencode"), true);
            assert.strictEqual(rollbackSupport("cursor"), false);
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
              Layer.provideMerge(AgentProcessPriorityOffLive),
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
              yield* openProviderBootGate;
              const providers = yield* pollProviders((current) => current.length >= 6);
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
            claudeCapabilities({ subscriptionType: "max" }),
            {},
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
        }).pipe(Effect.provide(claudeVersionSpawnerLayer)),
      );

      it.effect("reads Claude OAuth usage from the instance's own credential store", () => {
        const usage = recordingClaudeUsageProbe();
        return Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            { ...defaultClaudeSettings, homePath: "/tmp/ryco-claude-home" },
            claudeCapabilities({ subscriptionType: "max" }),
            {},
            usage.probe,
          );

          assert.deepStrictEqual(usage.stores, [
            {
              credentialsPath: "/tmp/ryco-claude-home/.claude/.credentials.json",
              keychain: undefined,
            },
          ]);
          assert.deepStrictEqual(status.rateLimits, CLAUDE_USAGE_FIXTURE);
        }).pipe(Effect.provide(claudeVersionSpawnerLayer));
      });

      it.effect(
        "never reads the local Claude login's usage for an instance routed through a proxy",
        () => {
          const usage = recordingClaudeUsageProbe();
          return Effect.gen(function* () {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              claudeCapabilities({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
              PROXIED_CLAUDE_ENVIRONMENT,
              usage.probe,
            );

            assert.strictEqual(status.auth.type, "apiKey");
            assert.strictEqual(status.rateLimits, undefined);
            assert.deepStrictEqual(usage.stores, []);
          }).pipe(Effect.provide(claudeVersionSpawnerLayer));
        },
      );

      it.effect("skips Claude OAuth usage when account metadata is unavailable", () => {
        const usage = recordingClaudeUsageProbe();
        return Effect.gen(function* () {
          for (const environment of [{}, PROXIED_CLAUDE_ENVIRONMENT]) {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              noClaudeCapabilities,
              environment,
              usage.probe,
            );
            assert.strictEqual(status.rateLimits, undefined);
          }
          assert.deepStrictEqual(usage.stores, []);
        }).pipe(Effect.provide(claudeVersionSpawnerLayer));
      });

      it.effect("skips Claude OAuth usage unless the CLI reports using its claude.ai login", () => {
        const usage = recordingClaudeUsageProbe();
        return Effect.gen(function* () {
          for (const account of [
            {},
            { tokenSource: "claude.ai" },
            { tokenSource: "apiKeyHelper" },
            { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" },
          ]) {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              claudeCapabilities(account),
              {},
              usage.probe,
            );
            assert.strictEqual(status.rateLimits, undefined);
          }
          assert.deepStrictEqual(usage.stores, []);
        }).pipe(Effect.provide(claudeVersionSpawnerLayer));
      });

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
            ["low", "medium", "high", "xhigh", "max", "ultracode"],
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
            ["low", "medium", "high", "xhigh", "max", "ultracode"],
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

/**
 * A registry over one inline instance. `manifest` is the optional `ModelManifest` service; without
 * it the registry rates against the bundled policies and the code-owned floors.
 */
const buildSingleInstanceRegistry = Effect.fn("buildSingleInstanceRegistry")(function* (
  provider: ServerProvider,
  manifest?: ModelManifest["Service"],
) {
  const probes = yield* Ref.make(0);
  const instance = {
    instanceId: provider.instanceId,
    driverKind: provider.driver,
    continuationIdentity: {
      driverKind: provider.driver,
      continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: provider.driver,
          packageName: null,
        }),
      ),
      getSnapshot: Effect.succeed(provider),
      revalidate: Effect.succeed(provider),
      refresh: Ref.update(probes, (count) => count + 1).pipe(Effect.as(provider)),
      streamChanges: Stream.empty,
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === provider.instanceId ? instance : undefined),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  });
  const registryLayer = ProviderRegistryLive.pipe(
    Layer.provideMerge(instanceRegistryLayer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-registry-compat-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const runtimeServices = yield* Layer.build(
    manifest === undefined
      ? registryLayer
      : registryLayer.pipe(Layer.provide(Layer.succeed(ModelManifest, manifest))),
  ).pipe(Scope.provide(scope));
  return { runtimeServices, probes };
});

const waitForProvider = (
  instanceId: ProviderInstanceId,
  predicate: (provider: ServerProvider | undefined) => boolean,
) =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    let provider = (yield* registry.getProviders).find((entry) => entry.instanceId === instanceId);
    for (let attempt = 0; attempt < 200 && !predicate(provider); attempt += 1) {
      yield* Effect.yieldNow;
      provider = (yield* registry.getProviders).find((entry) => entry.instanceId === instanceId);
    }
    return provider;
  });

describe("ProviderRegistry compatibility advisories", () => {
  it.effect("rates an installed OpenCode 2.x as unsupported from the code floor", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("opencode");
      const { runtimeServices } = yield* buildSingleInstanceRegistry({
        instanceId,
        driver: ProviderDriverKind.make("opencode"),
        enabled: true,
        installed: true,
        version: "2.0.18",
        status: "error",
        auth: { status: "unknown" },
        checkedAt: "2026-10-04T00:00:00.000Z",
        message: "OpenCode v2.0.18 is not supported yet.",
        models: [],
        slashCommands: [],
        skills: [],
      });

      const provider = yield* waitForProvider(
        instanceId,
        (candidate) => candidate?.compatibilityAdvisory !== undefined,
      ).pipe(Effect.provide(runtimeServices));

      assert.strictEqual(provider?.compatibilityAdvisory?.status, "unsupported");
    }),
  );

  it.effect(
    "refreshes the manifest without a Claude instance and re-rates existing snapshots",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("codex");
        const manifestRef = yield* Ref.make<ModelManifestData>(BUNDLED_MODEL_MANIFEST);
        const refreshes = yield* Ref.make(0);
        const codexPolicyManifest: ModelManifestData = {
          ...BUNDLED_MODEL_MANIFEST,
          compatibility: [
            {
              driver: "codex",
              rycoRange: ">=0.0.0",
              ranges: [
                { range: ">=0.200.0", status: "broken", message: "Codex 0.200 breaks approvals." },
                { range: "<0.200.0", status: "supported" },
              ],
            },
          ],
        };
        const { runtimeServices, probes } = yield* buildSingleInstanceRegistry(
          {
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "0.199.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-10-04T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
            versionAdvisory: {
              status: "behind_latest",
              currentVersion: "0.199.0",
              latestVersion: "0.200.1",
              updateCommand: "npm install -g @openai/codex@latest",
              canUpdate: true,
              checkedAt: "2026-10-04T00:00:00.000Z",
              message: null,
            },
          },
          {
            current: Ref.get(manifestRef),
            refresh: Ref.get(manifestRef),
            refreshIfStale: Ref.update(refreshes, (count) => count + 1).pipe(
              Effect.andThen(Ref.set(manifestRef, codexPolicyManifest)),
              Effect.as(codexPolicyManifest),
            ),
            refreshInBackground: Effect.void,
          },
        );

        // The first probe is on demand; it schedules the TTL-gated manifest refresh.
        yield* Effect.gen(function* () {
          yield* (yield* ProviderRegistry).refresh();
        }).pipe(Effect.provide(runtimeServices));
        const provider = yield* waitForProvider(
          instanceId,
          (candidate) => candidate?.compatibilityAdvisory?.latestVersionStatus === "broken",
        ).pipe(Effect.provide(runtimeServices));

        assert.deepStrictEqual(provider?.compatibilityAdvisory, {
          status: "supported",
          latestVersionStatus: "broken",
          message: null,
        });
        assert.isAtLeast(yield* Ref.get(refreshes), 1);
        // The snapshot was probed once, before the manifest changed: the rating came from the
        // registry re-rating it, not from a new probe.
        assert.strictEqual(yield* Ref.get(probes), 1);
      }),
  );
});

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

const codexSnapshot = (overrides?: Partial<ServerProvider>): ServerProvider => ({
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER_KIND,
  enabled: true,
  installed: true,
  version: "0.199.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

/**
 * A registry whose single configured codex instance arrives after the registry is built, like
 * the deferred hydration layer. The instance is a real managed provider with a fixed fingerprint.
 */
const buildDeferredCodexRegistry = Effect.fn("buildDeferredCodexRegistry")(function* (input: {
  readonly persisted?: {
    readonly provider: ServerProvider;
    readonly probeFreshness?: { readonly fingerprint: string; readonly checkedAt: string };
  };
  readonly fingerprint: string;
  readonly probed: ServerProvider;
  readonly refreshUsage?: (snapshot: ServerProvider) => Effect.Effect<ServerProvider>;
}) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const base = yield* Layer.build(
    ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-freshness-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ).pipe(Scope.provide(scope));
  const config = Context.get(base, ServerConfig);
  const cachePath = yield* resolveProviderStatusCachePath({
    cacheDir: config.providerStatusCacheDir,
    instanceId: CODEX_INSTANCE_ID,
  }).pipe(Effect.provide(base));
  if (input.persisted) {
    yield* writeProviderStatusCache({
      filePath: cachePath,
      provider: input.persisted.provider,
      probeFreshness: input.persisted.probeFreshness,
    }).pipe(Effect.provide(base));
  }

  const checks = yield* Ref.make(0);
  const fingerprintReads = yield* Ref.make(0);
  const snapshot = yield* makeManagedServerProvider<{ readonly enabled: boolean }>({
    maintenanceCapabilities: Effect.succeed(
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER_KIND,
        packageName: null,
      }),
    ),
    probeFingerprint: Ref.update(fingerprintReads, (count) => count + 1).pipe(
      Effect.as(input.fingerprint),
    ),
    getSettings: Effect.succeed({ enabled: true }),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => codexSnapshot({ status: "warning", message: "Checking..." }),
    checkProvider: Ref.update(checks, (count) => count + 1).pipe(Effect.as(input.probed)),
    ...(input.refreshUsage ? { refreshUsage: input.refreshUsage } : {}),
    refreshInterval: null,
  }).pipe(Scope.provide(scope));
  const instance: ProviderInstance = {
    instanceId: CODEX_INSTANCE_ID,
    driverKind: CODEX_DRIVER_KIND,
    continuationIdentity: { driverKind: CODEX_DRIVER_KIND, continuationKey: "codex" },
    displayName: undefined,
    enabled: true,
    snapshot,
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
  const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([]);
  const changes = yield* PubSub.unbounded<void>();
  const instanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Ref.get(instancesRef).pipe(
        Effect.map((instances) => instances.find((entry) => entry.instanceId === instanceId)),
      ),
    listInstances: Ref.get(instancesRef),
    listUnavailable: Effect.succeed([]),
    listConfigured: Effect.succeed([
      {
        instanceId: CODEX_INSTANCE_ID,
        driverKind: CODEX_DRIVER_KIND,
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
      },
    ]),
    streamChanges: Stream.fromPubSub(changes),
    subscribeChanges: PubSub.subscribe(changes),
  });
  const runtimeServices = yield* Layer.build(
    ProviderRegistryLive.pipe(
      Layer.provideMerge(instanceRegistry),
      Layer.provideMerge(Layer.succeedContext(base)),
    ),
  ).pipe(Scope.provide(scope));
  // Deliver the driver and wait until the registry has settled its arrival.
  const arrive = Effect.gen(function* () {
    yield* Ref.set(instancesRef, [instance]);
    yield* PubSub.publish(changes, undefined);
    for (let attempt = 0; attempt < 200 && (yield* Ref.get(fingerprintReads)) === 0; attempt++) {
      yield* Effect.yieldNow;
    }
    for (let attempt = 0; attempt < 10; attempt++) yield* Effect.yieldNow;
  });
  const readPersisted = readProviderStatusCacheEntry(cachePath).pipe(Effect.provide(base));
  return { runtimeServices, checks, arrive, readPersisted, snapshot };
});

const revalidateInBackground = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const fiber = yield* registry.revalidateStale.pipe(Effect.forkChild);
  yield* TestClock.adjust("2 seconds");
  return yield* Fiber.join(fiber);
});

describe("ProviderRegistry persisted probe freshness", () => {
  it.effect(
    "serves the persisted snapshot before the driver exists and adopts it when its fingerprint matches",
    () =>
      Effect.gen(function* () {
        const persisted = codexSnapshot({ checkedAt: "2026-10-02T00:00:00.000Z" });
        const { runtimeServices, checks, arrive, snapshot } = yield* buildDeferredCodexRegistry({
          persisted: {
            provider: persisted,
            probeFreshness: { fingerprint: "fp-1", checkedAt: new Date().toISOString() },
          },
          fingerprint: "fp-1",
          probed: codexSnapshot({ checkedAt: "2026-10-03T00:00:00.000Z" }),
        });

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          const before = yield* registry.getProviders;
          assert.strictEqual(before.length, 1);
          assert.strictEqual(before[0]?.checkedAt, persisted.checkedAt);
          assert.strictEqual(before[0]?.status, "ready");

          yield* arrive;
          assert.strictEqual((yield* snapshot.getSnapshot).checkedAt, persisted.checkedAt);
          const after = yield* revalidateInBackground;
          assert.strictEqual(after[0]?.checkedAt, persisted.checkedAt);
          assert.strictEqual(yield* Ref.get(checks), 0);
        }).pipe(Effect.provide(runtimeServices));
      }),
  );

  it.effect("keeps a stale persisted snapshot until a demand probes and re-persists it", () =>
    Effect.gen(function* () {
      const persisted = codexSnapshot({ checkedAt: "2026-10-02T00:00:00.000Z" });
      const probed = codexSnapshot({ checkedAt: "2026-10-03T00:00:00.000Z" });
      const { runtimeServices, checks, arrive, readPersisted } = yield* buildDeferredCodexRegistry({
        persisted: {
          provider: persisted,
          probeFreshness: { fingerprint: "fp-old-binary", checkedAt: new Date().toISOString() },
        },
        fingerprint: "fp-1",
        probed,
      });

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        yield* arrive;
        assert.strictEqual((yield* registry.getProviders)[0]?.checkedAt, persisted.checkedAt);
        assert.strictEqual(yield* Ref.get(checks), 0);

        const after = yield* revalidateInBackground;
        assert.strictEqual(after[0]?.checkedAt, probed.checkedAt);
        assert.strictEqual(yield* Ref.get(checks), 1);
        assert.strictEqual((yield* readPersisted)?.probeFreshness?.fingerprint, "fp-1");
      }).pipe(Effect.provide(runtimeServices));
    }),
  );

  it.effect(
    "re-reads only the usage of an adopted snapshot, keeping its persisted probe record",
    () =>
      Effect.gen(function* () {
        const probedAt = new Date().toISOString();
        const persisted = codexSnapshot({
          checkedAt: "2026-10-02T00:00:00.000Z",
          rateLimits: { primary: { usedPercent: 10 } },
        });
        const usageReads = yield* Ref.make(0);
        const { runtimeServices, checks, arrive, readPersisted } =
          yield* buildDeferredCodexRegistry({
            persisted: {
              provider: persisted,
              probeFreshness: { fingerprint: "fp-1", checkedAt: probedAt },
            },
            fingerprint: "fp-1",
            probed: codexSnapshot({ checkedAt: "2026-10-03T00:00:00.000Z" }),
            refreshUsage: (snapshot) =>
              Ref.update(usageReads, (count) => count + 1).pipe(
                Effect.as({ ...snapshot, rateLimits: { primary: { usedPercent: 55 } } }),
              ),
          });

        yield* Effect.gen(function* () {
          yield* arrive;
          // The adopted usage is past its five-minute window; the rest is not.
          yield* TestClock.adjust("6 minutes");
          const after = yield* revalidateInBackground;
          assert.deepStrictEqual(after[0]?.rateLimits, { primary: { usedPercent: 55 } });
          assert.strictEqual(after[0]?.checkedAt, persisted.checkedAt);
          assert.strictEqual(yield* Ref.get(checks), 0);
          assert.strictEqual(yield* Ref.get(usageReads), 1);
          const written = yield* readPersisted;
          assert.deepStrictEqual(written?.provider.rateLimits, { primary: { usedPercent: 55 } });
          assert.deepStrictEqual(written?.probeFreshness, {
            fingerprint: "fp-1",
            checkedAt: probedAt,
          });
        }).pipe(Effect.provide(runtimeServices));
      }),
  );

  it.effect("publishes the pending placeholder when nothing was persisted", () =>
    Effect.gen(function* () {
      const { runtimeServices, checks, arrive } = yield* buildDeferredCodexRegistry({
        fingerprint: "fp-1",
        probed: codexSnapshot(),
      });

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        assert.deepStrictEqual(yield* registry.getProviders, []);
        yield* arrive;
        assert.strictEqual((yield* registry.getProviders)[0]?.message, "Checking...");
        assert.strictEqual(yield* Ref.get(checks), 0);
      }).pipe(Effect.provide(runtimeServices));
    }),
  );

  it.effect("never persists probe freshness for warning outcomes", () =>
    Effect.gen(function* () {
      const { runtimeServices, arrive, readPersisted } = yield* buildDeferredCodexRegistry({
        fingerprint: "fp-1",
        probed: codexSnapshot({ status: "warning", message: "Could not verify auth." }),
      });

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        yield* arrive;
        yield* registry.refreshInstance(CODEX_INSTANCE_ID);
        const persisted = yield* readPersisted;
        assert.strictEqual(persisted?.provider.status, "warning");
        assert.strictEqual(persisted?.probeFreshness, undefined);
      }).pipe(Effect.provide(runtimeServices));
    }),
  );

  it.effect("runs at most two background probes at once", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const started = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      const instances = ["codex", "codex_a", "codex_b", "codex_c"].map((id): ProviderInstance => {
        const provider = codexSnapshot({ instanceId: ProviderInstanceId.make(id) });
        return {
          instanceId: provider.instanceId,
          driverKind: CODEX_DRIVER_KIND,
          continuationIdentity: { driverKind: CODEX_DRIVER_KIND, continuationKey: id },
          displayName: undefined,
          enabled: true,
          snapshot: {
            maintenanceCapabilities: Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: CODEX_DRIVER_KIND,
                packageName: null,
              }),
            ),
            getSnapshot: Effect.succeed(provider),
            isFresh: Effect.succeed(false),
            revalidate: Effect.gen(function* () {
              yield* Ref.update(started, (count) => count + 1);
              const now = yield* Ref.updateAndGet(active, (count) => count + 1);
              yield* Ref.update(maxActive, (count) => Math.max(count, now));
              yield* Deferred.await(release);
              yield* Ref.update(active, (count) => count - 1);
              return provider;
            }),
            refresh: Effect.succeed(provider),
            streamChanges: Stream.empty,
          },
          adapter: {} as ProviderInstance["adapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        };
      });
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const runtimeServices = yield* Layer.build(
        ProviderRegistryLive.pipe(
          Layer.provideMerge(
            Layer.succeed(ProviderInstanceRegistry, {
              getInstance: (instanceId) =>
                Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
              listInstances: Effect.succeed(instances),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            }),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "ryco-provider-background-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ).pipe(Scope.provide(scope));

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        const pass = yield* registry.revalidateStale.pipe(Effect.forkChild);
        // A second client during the pass joins it instead of starting another.
        const joined = yield* registry.revalidateStale.pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(active), 2);
        assert.strictEqual(yield* Ref.get(started), 2);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pass);
        yield* Fiber.join(joined);
        assert.strictEqual(yield* Ref.get(maxActive), 2);
        assert.strictEqual(yield* Ref.get(started), 4);
      }).pipe(Effect.provide(runtimeServices));
    }),
  );
});
