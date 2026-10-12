import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "./auth/Services/ServerSecretStore.ts";
import { acquireStorageSettingsLease, storageLifecycleLock } from "./storage/lifecycle.ts";
import { isDeepStrictEqual } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CliProxyHubId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { fromLenientJson } from "@ryco/shared/schemaJson";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { resolveStorageRetentionPolicy } from "@ryco/shared/storageRetention";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Predicate, Schema } from "effect";
import { ServerConfig } from "./config.ts";
import {
  ServerSettingsLive,
  ServerSettingsService,
  makePersistedSettingsEncoder,
  makeServerSettings,
  redactServerSettingsForClient,
} from "./serverSettings.ts";

const serverSettingsServiceLayer = (store?: ServerSecretStoreShape) =>
  store
    ? Layer.effect(ServerSettingsService, makeServerSettings).pipe(
        Layer.provide(Layer.succeed(ServerSecretStore, store)),
      )
    : ServerSettingsLive;

const makeServerSettingsLayer = (store?: ServerSecretStoreShape) =>
  serverSettingsServiceLayer(store).pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "ryco-server-settings-test-",
        }),
      ),
    ),
  );

/** Loads settings.json the way a restarted server does: a new service with an empty cache. */
const loadSettingsInFreshService = (store?: ServerSecretStoreShape) =>
  Effect.gen(function* () {
    return yield* (yield* ServerSettingsService).getSettings;
  }).pipe(Effect.provide(Layer.fresh(serverSettingsServiceLayer(store))));

/** Runs `effect` against a new service over the same settings file, as after a restart. */
const inFreshService = <A, E>(
  effect: (settings: typeof ServerSettingsService.Service) => Effect.Effect<A, E>,
  store?: ServerSecretStoreShape,
) =>
  Effect.gen(function* () {
    return yield* effect(yield* ServerSettingsService);
  }).pipe(Effect.provide(Layer.fresh(serverSettingsServiceLayer(store))));

const unreadableSettingsBackups = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { settingsPath } = yield* ServerConfig;
  const directory = path.dirname(settingsPath);
  return (yield* fs.readDirectory(directory))
    .filter((name) => name.includes(".unreadable-"))
    .map((name) => path.join(directory, name));
});

const decodeSettingsFile = Schema.decodeUnknownSync(fromLenientJson(ServerSettings));

const leafAt = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], value);

const withLeaf = (value: unknown, path: ReadonlyArray<string>, leaf: unknown): unknown => {
  const [key, ...rest] = path;
  if (key === undefined) return leaf;
  const record = value as Record<string, unknown>;
  return { ...record, [key]: withLeaf(record[key], rest, leaf) };
};

/** Leaf paths inside nested settings structs, e.g. `storageRetention.automatic`. */
const nestedLeafPaths = (
  value: unknown,
  path: ReadonlyArray<string> = [],
): Array<ReadonlyArray<string>> =>
  Predicate.isObject(value) && Object.keys(value).length > 0
    ? Object.entries(value).flatMap(([key, child]) => nestedLeafPaths(child, [...path, key]))
    : path.length > 1
      ? [path]
      : [];

/** A valid value for the leaf at `path` that differs from its default. */
const changedLeaf = (path: ReadonlyArray<string>): unknown => {
  const current = leafAt(DEFAULT_SERVER_SETTINGS, path);
  const candidates =
    typeof current === "boolean"
      ? [!current]
      : typeof current === "number"
        ? [current + 1]
        : typeof current === "string"
          ? [`${current}-changed`, "changed"]
          : Array.isArray(current)
            ? [current.length > 0 ? [] : ["changed"]]
            : [1, "changed", true];
  const changed = candidates.find((candidate) => {
    const decoded = Schema.decodeUnknownExit(ServerSettings)(
      withLeaf(DEFAULT_SERVER_SETTINGS, path, candidate),
    );
    return Exit.isSuccess(decoded) && isDeepStrictEqual(leafAt(decoded.value, path), candidate);
  });
  assert.isDefined(changed, `no valid changed value for ${path.join(".")}`);
  return changed;
};

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

  it.effect("validates the chats folder like a worktree root and keeps empty as the default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "settings-chats-root-" });
      const canonical = yield* fs.realPath(root);
      const settings = yield* ServerSettingsService;
      const saved = yield* settings.updateSettings({ chatsRoot: `${root}/chats` });
      assert.equal(saved.chatsRoot, `${canonical}/chats`);
      const rejected = yield* settings
        .updateSettings({ chatsRoot: "relative/chats" })
        .pipe(Effect.flip);
      assert.include(rejected.detail, "Chats folder must be an absolute directory");
      assert.equal((yield* settings.getSettings).chatsRoot, `${canonical}/chats`);
      assert.equal((yield* settings.updateSettings({ chatsRoot: "" })).chatsRoot, "");
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

  it.effect("keeps CLIProxyAPI management and Cloudflare secrets out of files and clients", () => {
    const fake = syntheticSecretStore();
    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const hubId = CliProxyHubId.make("home-hub");

      const saved = yield* serverSettings.updateSettings({
        cliProxyHubs: {
          [hubId]: {
            url: "http://127.0.0.1:8317",
            managementKey: " mgmt-secret ",
            enabled: true,
            cloudflareAccessClientId: "token.access",
            cloudflareAccessClientSecret: " cf-secret ",
          },
        },
      });
      // The server keeps working with the materialized key.
      assert.equal(saved.cliProxyHubs[hubId]?.managementKey, "mgmt-secret");
      assert.equal(saved.cliProxyHubs[hubId]?.cloudflareAccessClientSecret, "cf-secret");
      assert.deepEqual(redactServerSettingsForClient(saved).cliProxyHubs[hubId], {
        url: "http://127.0.0.1:8317",
        managementKey: "",
        managementKeyRedacted: true,
        enabled: true,
        cloudflareAccessClientId: "token.access",
        cloudflareAccessClientSecret: "",
        cloudflareAccessClientSecretRedacted: true,
      });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "mgmt-secret");
      assert.notInclude(raw, "cf-secret");
      assert.equal(fake.values.size, 2);
      const restarted = yield* loadSettingsInFreshService(fake.store);
      assert.equal(restarted.cliProxyHubs[hubId]?.cloudflareAccessClientSecret, "cf-secret");

      // Sending the redacted entry back (an edit of other fields) keeps the stored key.
      const relabeled = yield* serverSettings.updateSettings({
        cliProxyHubs: {
          [hubId]: {
            url: "http://127.0.0.1:8317",
            label: "Home",
            managementKey: "",
            managementKeyRedacted: true,
            enabled: true,
          },
        },
      });
      assert.equal(relabeled.cliProxyHubs[hubId]?.managementKey, "mgmt-secret");
      assert.equal(relabeled.cliProxyHubs[hubId]?.label, "Home");
      // A client that predates Cloudflare fields preserves the token when relabeling.
      assert.equal(relabeled.cliProxyHubs[hubId]?.cloudflareAccessClientSecret, "cf-secret");

      // The saved key never follows the hub to another address; a loopback alias is the same one.
      const moved = yield* serverSettings
        .updateSettings({
          cliProxyHubs: {
            [hubId]: {
              url: "https://other.example:8317",
              managementKey: "",
              managementKeyRedacted: true,
              enabled: true,
            },
          },
        })
        .pipe(Effect.flip);
      assert.include(moved.detail, "its address changed");
      assert.equal(
        (yield* serverSettings.getSettings).cliProxyHubs[hubId]?.url,
        "http://127.0.0.1:8317",
      );
      const aliased = yield* serverSettings.updateSettings({
        cliProxyHubs: {
          [hubId]: {
            url: "http://localhost:8317/v0/management",
            label: "Home",
            managementKey: "",
            managementKeyRedacted: true,
            enabled: true,
          },
        },
      });
      assert.equal(aliased.cliProxyHubs[hubId]?.managementKey, "mgmt-secret");
      assert.equal(aliased.cliProxyHubs[hubId]?.cloudflareAccessClientSecret, "cf-secret");

      const visible = redactServerSettingsForClient(aliased).cliProxyHubs[hubId]!;
      const changedId = yield* serverSettings
        .updateSettings({
          cliProxyHubs: { [hubId]: { ...visible, cloudflareAccessClientId: "new-token.access" } },
        })
        .pipe(Effect.flip);
      assert.include(changedId.detail, "its Client ID changed");
      const changedAddress = yield* serverSettings
        .updateSettings({
          cliProxyHubs: {
            [hubId]: {
              ...visible,
              url: "https://other.example",
              managementKey: "new-management-key",
              managementKeyRedacted: false,
            },
          },
        })
        .pipe(Effect.flip);
      assert.include(changedAddress.detail, "Cloudflare Access Client Secret");
      assert.include(changedAddress.detail, "its address changed");
      assert.equal(
        (yield* serverSettings.getSettings).cliProxyHubs[hubId]?.managementKey,
        "mgmt-secret",
      );

      const rotated = yield* serverSettings.updateSettings({
        cliProxyHubs: { [hubId]: { ...visible, cloudflareAccessClientSecret: "rotated-secret" } },
      });
      assert.equal(rotated.cliProxyHubs[hubId]?.cloudflareAccessClientSecret, "rotated-secret");
      const cleared = yield* serverSettings.updateSettings({
        cliProxyHubs: {
          [hubId]: {
            ...redactServerSettingsForClient(rotated).cliProxyHubs[hubId]!,
            cloudflareAccessClientId: "",
            cloudflareAccessClientSecret: "",
            cloudflareAccessClientSecretRedacted: false,
          },
        },
      });
      assert.equal(cleared.cliProxyHubs[hubId]?.cloudflareAccessClientSecret, "");
      assert.equal(fake.values.size, 1);
      assert.notInclude(JSON.stringify(redactServerSettingsForClient(cleared)), "rotated-secret");

      yield* serverSettings.updateSettings({
        cliProxyHubs: {
          [hubId]: {
            ...redactServerSettingsForClient(cleared).cliProxyHubs[hubId]!,
            cloudflareAccessClientId: "token.access",
            cloudflareAccessClientSecret: "cf-secret",
          },
        },
      });
      assert.equal(fake.values.size, 2);

      // Removing the hub removes its key.
      const removed = yield* serverSettings.updateSettings({ cliProxyHubs: { [hubId]: null } });
      assert.deepEqual(removed.cliProxyHubs, {});
      assert.equal(fake.values.size, 0);
    }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
  });

  it.effect("does not bind a leftover hub secret to a newly created address", () => {
    const fake = syntheticSecretStore();
    const store = { ...fake.store, remove: () => Effect.void };
    return Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const hubId = CliProxyHubId.make("home");
      const saved = yield* settings.updateSettings({
        cliProxyHubs: {
          [hubId]: {
            url: "https://old.example",
            managementKey: "mgmt-secret",
            enabled: true,
            cloudflareAccessClientId: "token.access",
            cloudflareAccessClientSecret: "cf-secret",
          },
        },
      });
      yield* settings.updateSettings({ cliProxyHubs: { [hubId]: null } });
      assert.equal(fake.values.size, 2, "the stale-secret cleanup left records behind");
      const refused = yield* settings
        .updateSettings({
          cliProxyHubs: {
            [hubId]: {
              ...redactServerSettingsForClient(saved).cliProxyHubs[hubId]!,
              url: "https://new.example",
            },
          },
        })
        .pipe(Effect.flip);
      assert.include(refused.detail, "no saved value exists");
      assert.deepEqual((yield* settings.getSettings).cliProxyHubs, {});
    }).pipe(Effect.provide(makeServerSettingsLayer(store)));
  });

  it.effect("reloads policies saved with one field at its default without losing other keys", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const instanceId = ProviderInstanceId.make("codex_work");
      const saved = yield* settings.updateSettings({
        lifecycleSuggestions: { archiveInactiveThreadsDays: 14, removeArchivedCheckoutsDays: 7 },
        storageRetention: { automatic: true, completedWorktreeDays: 30, temporaryDataDays: null },
        agentControl: { enabled: true },
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: {},
            environment: [
              { name: "CODEX_HOME", value: "/fixture/codex-home", sensitive: false },
              { name: "OPENAI_API_KEY", value: "sk-fixture", sensitive: true },
            ],
          },
        },
      });

      const reloaded = yield* loadSettingsInFreshService();
      assert.deepEqual(reloaded, saved);
      assert.deepEqual(reloaded.lifecycleSuggestions, {
        archiveInactiveThreadsDays: 14,
        removeArchivedCheckoutsDays: 7,
      });
      assert.equal(reloaded.providerInstances[instanceId]?.environment?.[1]?.value, "sk-fixture");
      assert.deepEqual(yield* unreadableSettingsBackups, []);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("loads files that older builds wrote with default policy fields stripped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { settingsPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({
          lifecycleSuggestions: { archiveInactiveThreadsDays: 14 },
          storageRetention: { automatic: true, completedWorktreeDays: 30 },
          agentControl: { enabled: true },
          providerInstances: {
            codex_work: {
              driver: "codex",
              config: {},
              environment: [{ name: "CODEX_HOME", value: "/fixture/codex-home" }],
            },
          },
        }),
      );

      const loaded = yield* (yield* ServerSettingsService).getSettings;
      assert.deepEqual(loaded.lifecycleSuggestions, {
        archiveInactiveThreadsDays: 14,
        removeArchivedCheckoutsDays: 7,
      });
      assert.deepEqual(loaded.storageRetention, {
        automatic: true,
        completedWorktreeDays: 30,
        temporaryDataDays: null,
      });
      assert.isTrue(loaded.agentControl.enabled);
      assert.deepEqual(
        loaded.providerInstances[ProviderInstanceId.make("codex_work")]?.environment,
        [{ name: "CODEX_HOME", value: "/fixture/codex-home", sensitive: false }],
      );
      assert.deepEqual(yield* unreadableSettingsBackups, []);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists a change to any single nested settings field so a fresh load reads it", () =>
    Effect.gen(function* () {
      for (const path of nestedLeafPaths(DEFAULT_SERVER_SETTINGS)) {
        const label = path.join(".");
        const key = path[0] as keyof ServerSettings;
        const intended = withLeaf(
          DEFAULT_SERVER_SETTINGS,
          path,
          changedLeaf(path),
        ) as ServerSettings;
        const patch = { [key]: intended[key] } as ServerSettingsPatch;
        const expected = Schema.decodeUnknownSync(ServerSettings)(
          applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch),
        );
        assert.notDeepEqual(leafAt(expected, path), leafAt(DEFAULT_SERVER_SETTINGS, path), label);

        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { settingsPath } = yield* ServerConfig;
          const saved = yield* (yield* ServerSettingsService).updateSettings(patch);
          assert.deepEqual(
            decodeSettingsFile(yield* fs.readFileString(settingsPath)),
            expected,
            label,
          );
          assert.deepEqual(yield* loadSettingsInFreshService(), saved, label);
        }).pipe(Effect.provide(makeServerSettingsLayer()));
      }
    }),
  );

  it.effect("keeps every valid key of a partly invalid file and backs the original up once", () => {
    const fake = syntheticSecretStore();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { settingsPath } = yield* ServerConfig;
      const instanceId = ProviderInstanceId.make("codex_work");
      const saved = yield* (yield* ServerSettingsService).updateSettings({
        enableLegacyTokenStreaming: true,
        lifecycleSuggestions: { archiveInactiveThreadsDays: 14, removeArchivedCheckoutsDays: 3 },
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: {},
            environment: [
              { name: "CODEX_HOME", value: "/fixture/codex-home", sensitive: false },
              { name: "OPENAI_API_KEY", value: "sk-fixture", sensitive: true },
            ],
          },
        },
      });
      const original = `${JSON.stringify(
        {
          ...JSON.parse(yield* fs.readFileString(settingsPath)),
          lifecycleSuggestions: { archiveInactiveThreadsDays: 0 },
        },
        null,
        2,
      )}\n`;
      yield* fs.writeFileString(settingsPath, original);

      const recovered = yield* loadSettingsInFreshService(fake.store);
      assert.deepEqual(
        recovered.lifecycleSuggestions,
        DEFAULT_SERVER_SETTINGS.lifecycleSuggestions,
      );
      assert.deepEqual({ ...recovered, lifecycleSuggestions: saved.lifecycleSuggestions }, saved);
      assert.deepEqual(yield* loadSettingsInFreshService(fake.store), recovered);
      const backups = yield* unreadableSettingsBackups;
      assert.equal(backups.length, 1);
      assert.match(path.basename(backups[0]!), /^settings\.unreadable-[0-9a-f]{8}\.json$/);
      assert.equal(yield* fs.readFileString(backups[0]!), original);
      assert.equal(yield* fs.readFileString(settingsPath), original);
    }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
  });

  it.effect("never lets recovery hand a project that opted out to automatic cleanup", () => {
    const fake = syntheticSecretStore();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { settingsPath } = yield* ServerConfig;
      const node = { automatic: true, completedWorktreeDays: 7, temporaryDataDays: null };
      const optedOut = { automatic: false, completedWorktreeDays: null, temporaryDataDays: null };
      const custom = { automatic: true, completedWorktreeDays: 14, temporaryDataDays: null };
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({
          storageRetention: node,
          projectStorageRetention: {
            "project-a": optedOut,
            // Out of range, e.g. hand-edited: it must not fall back to the node policy.
            "project-b": { automatic: false, completedWorktreeDays: 0, temporaryDataDays: null },
            "project-c": custom,
          },
        }),
      );
      const recovered = yield* loadSettingsInFreshService(fake.store);
      assert.deepEqual(recovered.storageRetention, node);
      assert.deepEqual(recovered.projectStorageRetention, {
        "project-a": optedOut,
        "project-b": optedOut,
        "project-c": custom,
      });
      for (const projectId of ["project-a", "project-b"]) {
        assert.isFalse(resolveStorageRetentionPolicy(recovered, projectId).automatic);
      }

      // With no readable overrides at all, automatic cleanup pauses for the whole node.
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({ storageRetention: node, projectStorageRetention: ["project-a"] }),
      );
      const unreadable = yield* loadSettingsInFreshService(fake.store);
      assert.deepEqual(unreadable.storageRetention, { ...node, automatic: false });
      assert.deepEqual(unreadable.projectStorageRetention, {});
    }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
  });

  it.effect("drops only the invalid entries of a hand-edited hub or instance map", () => {
    const fake = syntheticSecretStore();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { settingsPath } = yield* ServerConfig;
      const hubId = CliProxyHubId.make("home");
      const instanceId = ProviderInstanceId.make("codex_work");
      yield* (yield* ServerSettingsService).updateSettings({
        cliProxyHubs: {
          [hubId]: { url: "http://127.0.0.1:8317", managementKey: "mgmt-secret", enabled: true },
        },
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), config: {} },
        },
      });
      const saved = JSON.parse(yield* fs.readFileString(settingsPath));
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({
          ...saved,
          cliProxyHubs: {
            ...saved.cliProxyHubs,
            "office.lan": { url: "http://10.0.0.2:8317" },
            blank: { url: "" },
          },
          providerInstances: {
            ...saved.providerInstances,
            codex_bad: {
              driver: "codex",
              environment: [{ name: "MY-VAR", value: "x", sensitive: false }],
            },
          },
        }),
      );

      const recovered = yield* loadSettingsInFreshService(fake.store);
      assert.deepEqual(Object.keys(recovered.cliProxyHubs), [hubId]);
      assert.equal(recovered.cliProxyHubs[hubId]?.managementKey, "mgmt-secret");
      assert.deepEqual(Object.keys(recovered.providerInstances), [instanceId]);

      // An unrelated save keeps the valid entries in the file.
      yield* inFreshService(
        (settings) => settings.updateSettings({ enableLegacyTokenStreaming: true }),
        fake.store,
      );
      const rewritten = JSON.parse(yield* fs.readFileString(settingsPath));
      assert.deepEqual(Object.keys(rewritten.cliProxyHubs), [hubId]);
      assert.deepEqual(Object.keys(rewritten.providerInstances), [instanceId]);
      assert.equal(fake.values.size, 1);
    }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
  });

  it.effect("stores hand-edited plaintext hub secrets once a client saves its hub", () => {
    const fake = syntheticSecretStore();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { settingsPath } = yield* ServerConfig;
      const hubId = CliProxyHubId.make("home");
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({
          cliProxyHubs: {
            [hubId]: {
              url: "https://admin:pass@hub.example.com",
              managementKey: "plain-mgmt-key",
              cloudflareAccessClientId: "token.access",
              cloudflareAccessClientSecret: "plain-cf-secret",
            },
          },
        }),
      );
      const saved = yield* inFreshService(
        (settings) =>
          Effect.gen(function* () {
            const client = redactServerSettingsForClient(yield* settings.getSettings);
            const hub = client.cliProxyHubs[hubId]!;
            assert.deepEqual(hub, {
              url: "https://hub.example.com/",
              managementKey: "",
              managementKeyRedacted: true,
              enabled: true,
              cloudflareAccessClientId: "token.access",
              cloudflareAccessClientSecret: "",
              cloudflareAccessClientSecretRedacted: true,
            });
            // The client toggles the hub off, sending back the redacted entry.
            return yield* settings.updateSettings({
              cliProxyHubs: { [hubId]: { ...hub, enabled: false } },
            });
          }),
        fake.store,
      );
      assert.equal(saved.cliProxyHubs[hubId]?.managementKey, "plain-mgmt-key");
      assert.equal(saved.cliProxyHubs[hubId]?.cloudflareAccessClientSecret, "plain-cf-secret");
      assert.equal(fake.values.size, 2);
      assert.notInclude(yield* fs.readFileString(settingsPath), "plain-mgmt-key");
      assert.notInclude(yield* fs.readFileString(settingsPath), "plain-cf-secret");
    }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
  });

  it.effect("restores both hub secrets when settings.json cannot be written", () => {
    const fake = syntheticSecretStore();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { settingsPath } = yield* ServerConfig;
      const settings = yield* ServerSettingsService;
      const hubId = CliProxyHubId.make("home");
      const hub = {
        url: "http://127.0.0.1:8317",
        managementKey: "old-key",
        enabled: true,
        cloudflareAccessClientId: "token.access",
        cloudflareAccessClientSecret: "old-cf-secret",
      };
      yield* settings.updateSettings({ cliProxyHubs: { [hubId]: hub } });

      const directory = path.dirname(settingsPath);
      const failures = yield* Effect.gen(function* () {
        yield* fs.chmod(directory, 0o500);
        const removal = yield* Effect.exit(
          settings.updateSettings({ cliProxyHubs: { [hubId]: null } }),
        );
        const replacement = yield* Effect.exit(
          settings.updateSettings({
            cliProxyHubs: {
              [hubId]: {
                ...hub,
                url: "http://10.0.0.2:8317",
                managementKey: "new-key",
                cloudflareAccessClientSecret: "new-cf-secret",
              },
            },
          }),
        );
        return [removal, replacement];
      }).pipe(Effect.ensuring(fs.chmod(directory, 0o700).pipe(Effect.orDie)));
      assert.isTrue(failures.every(Exit.isFailure));

      const current = yield* settings.getSettings;
      assert.deepEqual(current.cliProxyHubs[hubId], {
        ...hub,
        managementKeyRedacted: true,
        cloudflareAccessClientSecretRedacted: true,
      });
      assert.deepEqual(
        [...fake.values.values()].map((value) => new TextDecoder().decode(value)),
        ["old-key", "old-cf-secret"],
      );
    }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
  });

  it.effect("falls back to defaults for an unparseable file and keeps its exact bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { settingsPath } = yield* ServerConfig;
      // A byte-order mark and an invalid UTF-8 byte do not survive a decode/encode round trip.
      const original = Uint8Array.from([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode('{ "enableLegacyTokenStreaming": tru'),
        0xff,
      ]);
      yield* fs.writeFile(settingsPath, original);

      assert.deepEqual(yield* (yield* ServerSettingsService).getSettings, DEFAULT_SERVER_SETTINGS);
      const backups = yield* unreadableSettingsBackups;
      assert.equal(backups.length, 1);
      assert.deepEqual(yield* fs.readFile(backups[0]!), original);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "does not present a sensitive value or management key as stored once it is gone",
    () => {
      const fake = syntheticSecretStore();
      return Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_work");
        const hubId = CliProxyHubId.make("home-hub");
        yield* settings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              config: {},
              environment: [{ name: "OPENAI_API_KEY", value: "sk-fixture", sensitive: true }],
            },
          },
          cliProxyHubs: {
            [hubId]: { url: "http://127.0.0.1:8317", managementKey: "mgmt-secret", enabled: true },
          },
        });
        fake.values.clear();

        const client = redactServerSettingsForClient(yield* settings.getSettings);
        assert.deepEqual(client.providerInstances[instanceId]?.environment, [
          { name: "OPENAI_API_KEY", value: "", sensitive: true },
        ]);
        assert.deepEqual(client.cliProxyHubs[hubId], {
          url: "http://127.0.0.1:8317",
          managementKey: "",
          enabled: true,
        });
      }).pipe(Effect.provide(makeServerSettingsLayer(fake.store)));
    },
  );
});

describe("makePersistedSettingsEncoder", () => {
  const SyntheticSettings = Schema.Struct({
    // Without per-field decoding defaults, a stored policy must list every field.
    strictPolicy: Schema.Struct({ days: Schema.Number, enabled: Schema.Boolean }).pipe(
      Schema.withDecodingDefault(Effect.succeed({ days: 7, enabled: false })),
    ),
    lenientPolicy: Schema.Struct({
      days: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(7))),
      enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    ratio: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  });
  const defaults = Schema.decodeSync(SyntheticSettings)({});
  const toPersisted = makePersistedSettingsEncoder(SyntheticSettings, defaults);
  const decodeFile = Schema.decodeUnknownSync(fromLenientJson(SyntheticSettings));

  it("writes a struct whole when its default-stripped form would not read back", () => {
    const intended = {
      ...defaults,
      strictPolicy: { days: 30, enabled: false },
      lenientPolicy: { days: 30, enabled: false },
    };
    assert.throws(() => decodeFile(JSON.stringify({ strictPolicy: { days: 30 } })));

    const { persisted, unreadableKeys } = toPersisted(intended);
    assert.deepEqual(persisted, {
      strictPolicy: { days: 30, enabled: false },
      lenientPolicy: { days: 30 },
    });
    assert.deepEqual(unreadableKeys, []);
    assert.deepEqual(decodeFile(JSON.stringify(persisted)), intended);
    assert.deepEqual(toPersisted(defaults), { persisted: {}, unreadableKeys: [] });
  });

  it("reports a key whose whole value does not survive the file either", () => {
    const { persisted, unreadableKeys } = toPersisted({ ...defaults, ratio: Number.NaN });
    assert.deepEqual(persisted, { ratio: Number.NaN });
    assert.deepEqual(unreadableKeys, ["ratio"]);
  });
});
