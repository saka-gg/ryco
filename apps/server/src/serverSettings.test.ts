import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "./auth/Services/ServerSecretStore.ts";
import { acquireStorageSettingsLease, storageLifecycleLock } from "./storage/lifecycle.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { ServerConfig } from "./config.ts";
import { ServerSettingsLive, ServerSettingsService, makeServerSettings } from "./serverSettings.ts";

const makeServerSettingsLayer = (store?: ServerSecretStoreShape) =>
  (store
    ? Layer.effect(ServerSettingsService, makeServerSettings).pipe(
        Layer.provide(Layer.succeed(ServerSecretStore, store)),
      )
    : ServerSettingsLive
  ).pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "ryco-server-settings-test-",
        }),
      ),
    ),
  );

const syntheticSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  const mutations: string[] = [];
  let beforeSet: Effect.Effect<void> = Effect.void;
  const store: ServerSecretStoreShape = {
    get: (name) => Effect.sync(() => values.get(name) ?? null),
    set: (name, value) =>
      Effect.gen(function* () {
        yield* beforeSet;
        mutations.push("set:" + name);
        values.set(name, value.slice());
      }),
    remove: (name) =>
      Effect.sync(() => {
        mutations.push("remove:" + name);
        values.delete(name);
      }),
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
  };
  return {
    store,
    values,
    mutations,
    pauseSet: (effect: Effect.Effect<void>) => {
      beforeSet = effect;
    },
  };
};

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("persists concurrent submodule project patches and reloads inheritance resets", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ worktreeSubmodules: "top-level" });
      yield* Effect.all(
        [
          settings.updateSettings({ projectWorktreeSubmodules: { a: "none" } }),
          settings.updateSettings({ projectWorktreeSubmodules: { b: "recursive" } }),
        ],
        { concurrency: 2 },
      );
      assert.deepEqual((yield* settings.getSettings).projectWorktreeSubmodules, {
        a: "none",
        b: "recursive",
      });
      yield* settings.updateSettings({ projectWorktreeSubmodules: { a: null } });
      const reloaded = yield* Effect.gen(function* () {
        return yield* (yield* ServerSettingsService).getSettings;
      }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));
      assert.equal(reloaded.worktreeSubmodules, "top-level");
      assert.deepEqual(reloaded.projectWorktreeSubmodules, { b: "recursive" });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "serializes publication snapshots with settings writes without losing a queued update",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const started = yield* Deferred.make<void>();
        const updated = yield* Deferred.make<void>();
        const writer = yield* settings.withSettingsSnapshot(
          Effect.gen(function* () {
            const before = yield* settings.getSettings;
            const writer = yield* Effect.forkChild(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* settings.updateSettings({ environmentIcon: "cloud" });
                yield* Deferred.succeed(updated, undefined);
              }),
            );
            yield* Deferred.await(started);
            yield* Effect.yieldNow;
            assert.equal(yield* Deferred.isDone(updated), false);
            assert.equal((yield* settings.getSettings).environmentIcon, before.environmentIcon);
            return writer;
          }),
        );
        yield* Fiber.join(writer);
        assert.equal((yield* settings.getSettings).environmentIcon, "cloud");
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("canonicalizes root saves and persists independent project resets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "settings-root-" });
      const canonical = yield* fs.realPath(root);
      const settings = yield* ServerSettingsService;
      const saved = yield* settings.updateSettings({
        worktreeRoot: root,
        projectWorktreeRoots: { a: `${root}/a`, b: `${root}/b` },
      });
      assert.equal(saved.worktreeRoot, canonical);
      assert.equal(saved.projectWorktreeRoots.a, `${canonical}/a`);
      yield* settings.updateSettings({ projectWorktreeRoots: { a: null } });
      const { settingsPath } = yield* ServerConfig;
      const persisted = JSON.parse(yield* fs.readFileString(settingsPath));
      assert.equal(persisted.worktreeRoot, canonical);
      assert.deepEqual(persisted.projectWorktreeRoots, { b: `${canonical}/b` });
      const before = yield* fs.readFileString(settingsPath);
      const result = yield* settings
        .updateSettings({ worktreeRoot: "relative/path" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(yield* fs.readFileString(settingsPath), before);
      assert.equal((yield* settings.getSettings).worktreeRoot, canonical);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("refuses provider and retention publication during a cleanup settings lease", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const lease = yield* storageLifecycleLock.withPermit(
        Effect.sync(acquireStorageSettingsLease),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => lease.release()));
      const before = yield* settings.getSettings;
      const provider = yield* settings
        .updateSettings({
          providerInstances: {
            [ProviderInstanceId.make("late-source")]: {
              driver: ProviderDriverKind.make("cursor"),
              enabled: false,
              config: { usageExportPath: "/fixture/export.json" },
            },
          },
        })
        .pipe(Effect.result);
      assert.equal(provider._tag, "Failure");
      const retention = yield* settings
        .updateSettings({
          storageRetention: { automatic: true, completedWorktreeDays: 30, temporaryDataDays: 7 },
        })
        .pipe(Effect.result);
      assert.equal(retention._tag, "Failure");
      assert.deepEqual(yield* settings.getSettings, before);
      lease.release();
      const after = yield* settings.updateSettings({
        storageRetention: { automatic: true, completedWorktreeDays: 30, temporaryDataDays: 7 },
      });
      assert.isTrue(after.storageRetention.automatic);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "refuses raw sensitive path updates and structural changes before any secret mutations",
    () =>
      Effect.gen(function* () {
        const fake = syntheticSecretStore();
        yield* Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig;
          const id = ProviderInstanceId.make("synthetic-sensitive-home");
          const instance = {
            driver: ProviderDriverKind.make("codex"),
            config: {},
            environment: [
              { name: "CODEX_HOME", value: "/fixture/current-home", sensitive: true },
              { name: "USAGE_EXPORT_PATH", value: "/fixture/current-export.json", sensitive: true },
            ],
          };
          yield* settings.updateSettings({ providerInstances: { [id]: instance } });
          const before = yield* settings.getSettings;
          const persisted = yield* fs.readFileString(config.settingsPath);
          const secrets = Array.from(fake.values, ([name, value]) => [name, Array.from(value)]);
          fake.mutations.length = 0;
          const lease = yield* storageLifecycleLock.withPermit(
            Effect.sync(acquireStorageSettingsLease),
          );
          yield* Effect.addFinalizer(() => Effect.sync(lease.release));
          for (const environment of [
            [
              { name: "CODEX_HOME", value: "/fixture/new-home", sensitive: true },
              { name: "USAGE_EXPORT_PATH", value: "/fixture/new-export.json", sensitive: true },
            ],
            [{ name: "CODEX_HOME", value: "/fixture/new-home", sensitive: false }],
            [],
          ]) {
            const rejected = yield* settings
              .updateSettings({ providerInstances: { [id]: { ...instance, environment } } })
              .pipe(Effect.result);
            assert.equal(rejected._tag, "Failure");
            assert.deepEqual(fake.mutations, []);
            assert.deepEqual(
              Array.from(fake.values, ([name, value]) => [name, Array.from(value)]),
              secrets,
            );
            assert.equal(yield* fs.readFileString(config.settingsPath), persisted);
            assert.deepEqual(yield* settings.getSettings, before);
            lease.assertValid();
          }
        }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
      }),
  );
  it.effect("blocks new cleanup admission while an admitted sensitive-path writer is paused", () =>
    Effect.gen(function* () {
      const fake = syntheticSecretStore();
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const id = ProviderInstanceId.make("synthetic-paused-writer");
        const instance = {
          driver: ProviderDriverKind.make("codex"),
          config: {},
          environment: [{ name: "CODEX_HOME", value: "/fixture/old-home", sensitive: true }],
        };
        yield* settings.updateSettings({ providerInstances: { [id]: instance } });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fake.pauseSet(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const writer = yield* Effect.forkChild(
          settings.updateSettings({
            providerInstances: {
              [id]: {
                ...instance,
                environment: [{ name: "CODEX_HOME", value: "/fixture/new-home", sensitive: true }],
              },
            },
          }),
        );
        yield* Deferred.await(entered);
        const refused = yield* storageLifecycleLock
          .withPermit(Effect.sync(acquireStorageSettingsLease))
          .pipe(Effect.exit);
        assert.equal(refused._tag, "Failure");
        assert.equal(
          (yield* settings.getSettings).providerInstances[id]!.environment![0]!.value,
          "/fixture/old-home",
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        const lease = yield* storageLifecycleLock.withPermit(
          Effect.sync(acquireStorageSettingsLease),
        );
        yield* Effect.addFinalizer(() => Effect.sync(lease.release));
        const current = yield* settings.getSettings;
        assert.equal(current.providerInstances[id]!.environment![0]!.value, "/fixture/new-home");
        lease.assertValid();
      }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
    }),
  );

  it.effect("keeps settings mutation admission until a cancelled secret write fully settles", () =>
    Effect.gen(function* () {
      const fake = syntheticSecretStore();
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const id = ProviderInstanceId.make("synthetic-cancelled-writer");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fake.pauseSet(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const writer = yield* Effect.forkChild(
          settings.updateSettings({
            providerInstances: {
              [id]: {
                driver: ProviderDriverKind.make("codex"),
                config: {},
                environment: [
                  { name: "CODEX_HOME", value: "/fixture/settled-home", sensitive: true },
                ],
              },
            },
          }),
        );
        yield* Deferred.await(entered);
        const cancellation = yield* Effect.forkChild(Fiber.interrupt(writer));
        yield* Effect.yieldNow;
        assert.equal(
          (yield* storageLifecycleLock
            .withPermit(Effect.sync(acquireStorageSettingsLease))
            .pipe(Effect.exit))._tag,
          "Failure",
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(cancellation);
        const lease = yield* storageLifecycleLock.withPermit(
          Effect.sync(acquireStorageSettingsLease),
        );
        yield* Effect.addFinalizer(() => Effect.sync(lease.release));
        assert.equal(
          (yield* settings.getSettings).providerInstances[id]!.environment![0]!.value,
          "/fixture/settled-home",
        );
        lease.assertValid();
      }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
    }),
  );

  it.effect("decodes nested settings patches", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

      assert.deepEqual(decodePatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }), {
        providers: { codex: { binaryPath: "/tmp/codex" } },
      });

      assert.deepEqual(
        decodePatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.sync(() => {
        const decode = Schema.decodeUnknownSync(ServerSettings);

        const decoded = decode({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        shadowHomePath: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        homePath: "",
        customModels: ["claude-custom"],
        launchArgs: "",
      });
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "uses explicit provider instance enabled state over legacy provider enabled state",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providers: {
            claudeAgent: {
              enabled: false,
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
          opencode: {
            binaryPath: "  /opt/homebrew/bin/opencode  ",
            serverUrl: "  http://127.0.0.1:4096  ",
            serverPassword: "  secret-password  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        shadowHomePath: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        homePath: "",
        customModels: [],
        launchArgs: "",
      });
      assert.deepEqual(next.providers.opencode, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "secret-password",
        customModels: [],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists the node icon and removes the override on Automatic", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const updated = yield* settings.updateSettings({ environmentIcon: "mini-pc" });
      assert.equal(updated.environmentIcon, "mini-pc");
      assert.equal(
        JSON.parse(yield* fs.readFileString(config.settingsPath)).environmentIcon,
        "mini-pc",
      );
      yield* settings.updateSettings({ environmentIcon: null });
      assert.equal((yield* settings.getSettings).environmentIcon, null);
      assert.equal(
        JSON.parse(yield* fs.readFileString(config.settingsPath)).environmentIcon,
        undefined,
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default server settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
