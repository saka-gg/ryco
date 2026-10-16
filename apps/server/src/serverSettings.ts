import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  storageLifecycleLock,
  hasStorageSettingsLease,
  acquireStorageSettingsUpdateLease,
  noteStorageSettingsChange,
} from "./storage/lifecycle.ts";
/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  type CliProxyHubConfig,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_GIT_TEXT_GENERATION_OPTIONS_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  isProviderDriverKind,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  type StorageRetentionPolicy,
} from "@ryco/contracts";
import {
  Cache,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Predicate,
  PubSub,
  Ref,
  Schema,
  SchemaAST,
  SchemaIssue,
  Scope,
  Context,
  Stream,
  Cause,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { writeFileAtomically, writeFileStringAtomically } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";
import { type DeepPartial } from "@ryco/shared/Struct";
import { formatSchemaError, fromLenientJson } from "@ryco/shared/schemaJson";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { hubKeyAddress } from "@ryco/shared/cliProxyHubUrl";
import { validateCloudflareAccessCredentials } from "@ryco/shared/cliProxyHubCredentials";
import {
  PROVIDER_SECRET_CONFIG_KEYS,
  PROVIDER_URL_CONFIG_KEYS,
  redactSettingSecret,
  redactUrlCredentials,
  resolveRedactedSettingValue,
  settingSecretAddress,
} from "@ryco/shared/settingsSecrets";

import { validateWorktreeRoot } from "./project/worktreeRoot.ts";
import { makeWorkspaceAccessPolicy } from "./workspace/Layers/WorkspaceAccessPolicy.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

const CLI_PROXY_HUB_SECRETS = [
  {
    value: "managementKey",
    redacted: "managementKeyRedacted",
    label: "management key",
    suffix: "",
  },
  {
    value: "cloudflareAccessClientSecret",
    redacted: "cloudflareAccessClientSecretRedacted",
    label: "Cloudflare Access Client Secret",
    suffix: "-cloudflare-access",
  },
] as const;

function cliProxyHubSecretName(hubId: string, suffix: string): string {
  return `cliproxy-hub-${Buffer.from(hubId, "utf8").toString("base64url")}${suffix}`;
}

function redactCliProxyHub(hub: CliProxyHubConfig): CliProxyHubConfig {
  const redacted = { ...hub };
  for (const field of CLI_PROXY_HUB_SECRETS) {
    if ((hub[field.value]?.length ?? 0) > 0 || hub[field.redacted]) {
      redacted[field.value] = "";
      redacted[field.redacted] = true;
    } else {
      delete redacted[field.redacted];
    }
  }
  return redacted;
}

/** A hub URL without a user name or password; the server never uses such a URL anyway. */
function withoutUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return raw;
  }
}

// URL fields first: a secret's binding is checked against the restored URLs.
const PROVIDER_CONFIG_SECRET_FIELDS: ReadonlyArray<{
  readonly key: string;
  readonly redact: (value: string) => string;
  readonly boundToAddress: boolean;
}> = [
  ...PROVIDER_URL_CONFIG_KEYS.map((key) => ({
    key,
    redact: redactUrlCredentials,
    boundToAddress: false,
  })),
  ...PROVIDER_SECRET_CONFIG_KEYS.map((key) => ({
    key,
    redact: redactSettingSecret,
    boundToAddress: true,
  })),
];

/** Whether every server URL of two provider configs names the same address. */
function sameProviderSecretAddress(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return PROVIDER_URL_CONFIG_KEYS.every(
    (key) => settingSecretAddress(left[key]) === settingSecretAddress(right[key]),
  );
}

const OBSERVABILITY_URL_KEYS = ["otlpTracesUrl", "otlpMetricsUrl"] as const;

function asConfigRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A provider config (legacy struct or instance `config` blob) as a client may see it. */
function redactProviderConfig<T>(config: T): T {
  const record = asConfigRecord(config);
  if (!record) return config;
  let redacted: Record<string, unknown> | undefined;
  for (const field of PROVIDER_CONFIG_SECRET_FIELDS) {
    const value = record[field.key];
    if (typeof value !== "string") continue;
    const visible = field.redact(value);
    if (visible === value) continue;
    redacted ??= { ...record };
    redacted[field.key] = visible;
  }
  return (redacted ?? record) as T;
}

/**
 * The copy of the settings every client receives (config snapshot,
 * `settingsUpdated`, `server.getSettings`/`updateSettings` results): no
 * secret leaves the server. See `@ryco/shared/settingsSecrets`.
 */
export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const redacted = instance.environment
        ? {
            ...instance,
            environment: instance.environment.map(redactProviderEnvironmentVariable),
          }
        : { ...instance };
      if (instance.config !== undefined) redacted.config = redactProviderConfig(instance.config);
      return [instanceId, redacted];
    }),
  );
  const providers = Object.fromEntries(
    Object.entries(settings.providers).map(([driver, config]) => [
      driver,
      redactProviderConfig(config),
    ]),
  ) as ServerSettings["providers"];
  const cliProxyHubs = Object.fromEntries(
    Object.entries(settings.cliProxyHubs).map(([hubId, hub]) => [
      hubId,
      { ...redactCliProxyHub(hub), url: withoutUrlCredentials(hub.url) },
    ]),
  ) as ServerSettings["cliProxyHubs"];
  const observability = {
    otlpTracesUrl: redactUrlCredentials(settings.observability.otlpTracesUrl),
    otlpMetricsUrl: redactUrlCredentials(settings.observability.otlpMetricsUrl),
  };
  return { ...settings, providers, providerInstances, cliProxyHubs, observability };
}

/**
 * `next` (current settings with a client patch applied) with every redacted
 * secret a client sent back replaced by the stored value it stands for, so
 * saving an unrelated setting never overwrites a secret with its redacted
 * form. A new default instance (id equal to its driver) resolves against the
 * legacy `providers.<driver>` struct it was synthesized from. A saved secret
 * is only kept while its config's server address is unchanged. Returns a
 * message when a redacted value stands for nothing stored.
 */
export function restoreRedactedServerSettingsSecrets(
  current: ServerSettings,
  next: ServerSettings,
  patch: ServerSettingsPatch,
): { readonly settings: ServerSettings } | { readonly error: string } {
  const unresolved: string[] = [];
  const restoreConfig = <T>(
    config: T,
    stored: ReadonlyArray<Record<string, unknown> | undefined>,
    where: string,
    /** Whether the client sent `key` itself, rather than the merge keeping it. */
    sentByClient: (key: string) => boolean,
  ): T => {
    const record = asConfigRecord(config);
    if (!record) return config;
    let restored: Record<string, unknown> | undefined;
    for (const field of PROVIDER_CONFIG_SECRET_FIELDS) {
      const incoming = record[field.key];
      if (typeof incoming !== "string") continue;
      const next = restored ?? record;
      // A saved secret (sent back redacted, or left in place by a partial
      // patch) never follows its config to another server address; the
      // client must enter it again.
      const moved =
        field.boundToAddress &&
        stored.some((entry) => {
          const saved = entry?.[field.key];
          return (
            entry !== undefined &&
            typeof saved === "string" &&
            saved.length > 0 &&
            (field.redact(saved) === incoming ||
              (incoming === saved && !sentByClient(field.key))) &&
            !sameProviderSecretAddress(entry, next)
          );
        });
      const value = moved
        ? undefined
        : resolveRedactedSettingValue(
            incoming,
            stored.map((entry) => entry?.[field.key]),
            field.redact,
          );
      if (value === undefined) {
        unresolved.push(`${field.key} of ${where}${moved ? " (its server address changed)" : ""}`);
        continue;
      }
      if (value === incoming) continue;
      restored ??= { ...record };
      restored[field.key] = value;
    }
    return (restored ?? record) as T;
  };

  const currentProviders = current.providers as Record<string, unknown>;
  const providers = Object.fromEntries(
    Object.entries(next.providers).map(([driver, config]) => [
      driver,
      restoreConfig(
        config,
        [asConfigRecord(currentProviders[driver])],
        `provider ${driver}`,
        (key) => {
          const sent = (patch.providers as Record<string, object | undefined> | undefined)?.[
            driver
          ];
          return sent !== undefined && Object.hasOwn(sent, key);
        },
      ),
    ]),
  ) as ServerSettings["providers"];

  const currentInstances = current.providerInstances as Record<string, ProviderInstanceConfig>;
  const providerInstances = Object.fromEntries(
    Object.entries(next.providerInstances).map(([instanceId, instance]) => {
      if (instance.config === undefined) return [instanceId, instance];
      const stored = currentInstances[instanceId];
      const config = restoreConfig(
        instance.config,
        [
          stored?.driver === instance.driver ? asConfigRecord(stored.config) : undefined,
          stored === undefined && instanceId === instance.driver
            ? asConfigRecord(currentProviders[instance.driver])
            : undefined,
        ],
        `provider instance ${instanceId}`,
        // The instance map is replaced whole, so every key came from the client.
        () => patch.providerInstances !== undefined,
      );
      return [instanceId, config === instance.config ? instance : { ...instance, config }];
    }),
  ) as ServerSettings["providerInstances"];

  const observability = { ...next.observability };
  for (const key of OBSERVABILITY_URL_KEYS) {
    const value = resolveRedactedSettingValue(
      next.observability[key],
      [current.observability[key]],
      redactUrlCredentials,
    );
    if (value === undefined) unresolved.push(`observability ${key}`);
    else observability[key] = value;
  }

  if (unresolved.length > 0) {
    return {
      error: `Enter these values again in full; the saved value they stood for is unavailable: ${unresolved.join(", ")}.`,
    };
  }
  return { settings: { ...next, providers, providerInstances, observability } };
}

export interface ServerSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ServerSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ServerSettingsError>;

  /** Read the current settings. */
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Serialize a short mutation admission with settings writes/reloads. */
  readonly withSettingsSnapshot: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ServerSettings>;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("ryco/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> | ServerSettingsPatch = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const currentSettingsRef = yield* Ref.make<ServerSettings>(
          applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, overrides as ServerSettingsPatch),
        );

        const writeSemaphore = yield* Semaphore.make(1);
        return {
          withSettingsSnapshot: writeSemaphore.withPermits(1),
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(currentSettingsRef),
          updateSettings: (patch) =>
            writeSemaphore.withPermits(1)(
              Ref.get(currentSettingsRef).pipe(
                Effect.flatMap((currentSettings) =>
                  Effect.try({
                    try: () => applyServerSettingsPatch(currentSettings, patch),
                    catch: (cause) =>
                      new ServerSettingsError({
                        settingsPath: "<memory>",
                        detail:
                          cause instanceof Error
                            ? cause.message
                            : "Invalid project preference patch.",
                        cause,
                      }),
                  }).pipe(
                    Effect.flatMap(Schema.decodeEffect(ServerSettings)),
                    Effect.mapError(
                      (cause) =>
                        new ServerSettingsError({
                          settingsPath: "<memory>",
                          detail: Schema.is(ServerSettingsError)(cause)
                            ? cause.detail
                            : `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
                          cause,
                        }),
                    ),
                  ),
                ),
                Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
              ),
            ),
          streamChanges: Stream.empty,
        } satisfies ServerSettingsShape;
      }),
    );
}

const decodeServerSettings = Schema.decodeUnknownExit(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownExit(fromLenientJson(ServerSettings));
const decodeLenientJson = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

/**
 * Ensure the `textGenerationModelSelection` points to an enabled provider.
 * If the selected provider is disabled, fall back to the first enabled
 * provider with its default model.  This is applied at read-time so the
 * persisted preference is preserved for when a provider is re-enabled.
 */
function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return (instanceConfig.enabled ?? true) ? settings : fallbackTextGenerationProvider(settings);
  }

  if (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled
  ) {
    return settings;
  }

  return fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallbackEntry = Object.entries(settings.providers).find(([, provider]) => provider.enabled);
  const fallback = fallbackEntry ? ProviderDriverKind.make(fallbackEntry[0]) : undefined;
  if (!fallback) {
    return settings;
  }
  const defaultOptions = DEFAULT_GIT_TEXT_GENERATION_OPTIONS_BY_PROVIDER[fallback];

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback),
      model:
        DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_GIT_TEXT_GENERATION_MODEL,
      ...(defaultOptions ? { options: defaultOptions } : {}),
    } satisfies ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "textGenerationModelSelection",
  "initialModelSelection",
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return isDeepStrictEqual(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!isDeepStrictEqual(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

/**
 * Builds the sparse form of a settings struct written to disk. A top-level key keeps its
 * default-stripped value only when the lenient loader reads that value back unchanged (a struct
 * field without a decoding default cannot be dropped); otherwise the key is written whole.
 * `unreadableKeys` lists keys whose whole value does not read back either.
 */
export function makePersistedSettingsEncoder<A extends object>(
  schema: Schema.Codec<A, unknown>,
  defaults: A,
): (settings: A) => {
  readonly persisted: Record<string, unknown>;
  readonly unreadableKeys: ReadonlyArray<string>;
} {
  const decodeJson = Schema.decodeUnknownExit(fromLenientJson(schema));
  const readsBackAs = (key: string, persisted: unknown, value: unknown) => {
    const decoded = decodeJson(JSON.stringify({ [key]: persisted }));
    return (
      Exit.isSuccess(decoded) &&
      isDeepStrictEqual((decoded.value as Record<string, unknown>)[key], value)
    );
  };
  return (settings) => {
    const sparse = stripDefaultServerSettings(settings, defaults) as
      | Record<string, unknown>
      | undefined;
    const persisted: Record<string, unknown> = {};
    const unreadableKeys: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
      const candidate = sparse?.[key];
      if (readsBackAs(key, candidate, value)) {
        if (candidate !== undefined) persisted[key] = candidate;
        continue;
      }
      persisted[key] = value;
      if (candidate === value || !readsBackAs(key, value, value)) unreadableKeys.push(key);
    }
    return { persisted, unreadableKeys };
  };
}

const toPersistedServerSettings = makePersistedSettingsEncoder(
  ServerSettings,
  DEFAULT_SERVER_SETTINGS,
);

// Keys holding a record of independent entries (per project, instance or hub). Recovery drops
// an invalid entry on its own rather than the whole record.
const RECORD_SETTINGS_KEYS: ReadonlySet<string> = new Set(
  Object.entries(ServerSettings.fields).flatMap(([key, field]) =>
    SchemaAST.isObjects(field.ast) &&
    field.ast.indexSignatures.length > 0 &&
    field.ast.propertySignatures.length === 0
      ? [key]
      : [],
  ),
);

// Retention deletes data on its own. A project override that cannot be read is recovered as
// never automatic: dropping it would hand the project to the node policy.
const UNREADABLE_PROJECT_RETENTION: StorageRetentionPolicy = {
  automatic: false,
  completedWorktreeDays: null,
  temporaryDataDays: null,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Decodes each top-level key on its own so an invalid value resets only that key, and each
 * entry of a record key on its own so an invalid entry drops only that entry. Undefined when
 * the file is not a JSON object.
 */
function recoverServerSettings(
  raw: string,
): { readonly settings: ServerSettings; readonly invalidKeys: Record<string, string> } | undefined {
  const parsed = decodeLenientJson(raw);
  if (Exit.isFailure(parsed) || !Predicate.isObject(parsed.value)) return undefined;
  const valid: Record<string, unknown> = {};
  const invalidKeys: Record<string, string> = {};
  for (const key of Object.keys(ServerSettings.fields)) {
    if (!Object.hasOwn(parsed.value, key)) continue;
    const value = parsed.value[key];
    const decoded = decodeServerSettings({ [key]: value });
    if (Exit.isSuccess(decoded)) {
      valid[key] = value;
      continue;
    }
    if (!RECORD_SETTINGS_KEYS.has(key) || !isPlainObject(value)) {
      invalidKeys[key] = formatSchemaError(decoded.cause);
      continue;
    }
    const entries: Record<string, unknown> = {};
    const issues: string[] = [];
    for (const [entryKey, entry] of Object.entries(value)) {
      const entryDecoded = decodeServerSettings({ [key]: { [entryKey]: entry } });
      if (Exit.isSuccess(entryDecoded)) {
        entries[entryKey] = entry;
        continue;
      }
      issues.push(formatSchemaError(entryDecoded.cause));
      if (key === "projectStorageRetention") entries[entryKey] = UNREADABLE_PROJECT_RETENTION;
    }
    if (Exit.isSuccess(decodeServerSettings({ [key]: entries }))) valid[key] = entries;
    invalidKeys[key] = issues.length > 0 ? issues.join("; ") : formatSchemaError(decoded.cause);
  }
  // With no readable project overrides, no project's opt-out is known: pause automatic cleanup.
  if (
    Object.hasOwn(invalidKeys, "projectStorageRetention") &&
    !Object.hasOwn(valid, "projectStorageRetention")
  ) {
    valid.storageRetention = {
      ...(isPlainObject(valid.storageRetention) ? valid.storageRetention : {}),
      automatic: false,
    };
  }
  const settings = decodeServerSettings(valid);
  return Exit.isSuccess(settings) ? { settings: settings.value, invalidKeys } : undefined;
}

export const makeServerSettings = Effect.gen(function* () {
  const { settingsPath, workspaceAccessRoot } = yield* ServerConfig;
  const worktreeAccessPolicy = yield* makeWorkspaceAccessPolicy(workspaceAccessRoot);
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to check settings file existence",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFile(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to read settings file",
          cause,
        }),
    ),
  );

  // A byte-exact copy of a file the loader could not fully read, named by its content so
  // repeated reloads of the same file keep a single copy. Returns null when it cannot be kept.
  const backupUnreadableSettings = (bytes: Uint8Array) => {
    const { dir, name, ext } = pathService.parse(settingsPath);
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    const backupPath = pathService.join(dir, `${name}.unreadable-${digest}${ext}`);
    return Effect.gen(function* () {
      if (yield* fs.exists(backupPath)) return;
      yield* writeFileAtomically({ filePath: backupPath, contents: bytes }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    }).pipe(
      Effect.as(backupPath),
      Effect.catch((cause) =>
        Effect.logWarning("failed to back up the unreadable settings file", {
          path: backupPath,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
  };

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const bytes = yield* readRawConfig;
    const raw = textDecoder.decode(bytes);
    const decoded = decodeServerSettingsJson(raw);
    if (Exit.isSuccess(decoded)) {
      return decoded.value;
    }
    // Keep the original before a later save can overwrite it with the recovered settings.
    const backupPath = yield* backupUnreadableSettings(bytes);
    const recovered = recoverServerSettings(raw);
    if (recovered === undefined) {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        backupPath,
        issues: Cause.pretty(decoded.cause),
      });
      return DEFAULT_SERVER_SETTINGS;
    }
    yield* Effect.logWarning("settings.json has invalid values, using defaults for them", {
      path: settingsPath,
      backupPath,
      invalidKeys: recovered.invalidKeys,
    });
    return recovered.settings;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const toSettingsError = (detail: string, cause: unknown) =>
    new ServerSettingsError({
      settingsPath,
      detail,
      cause,
    });

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }
          const secret = yield* secretStore
            .get(
              providerEnvironmentSecretName({
                instanceId,
                name: variable.name,
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                toSettingsError(
                  `failed to read sensitive environment variable ${variable.name}`,
                  cause,
                ),
              ),
            );
          if (secret) {
            environment.push({ ...variable, value: textDecoder.decode(secret) });
          } else {
            // Nothing is stored, so clients must ask for a value rather than show one as saved.
            const { valueRedacted: _omit, ...rest } = variable;
            environment.push({ ...rest, value: "" });
          }
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const materializeCliProxyHubSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const cliProxyHubs: Record<string, CliProxyHubConfig> = {};
      for (const [hubId, hub] of Object.entries(settings.cliProxyHubs)) {
        const materialized = { ...hub };
        for (const field of CLI_PROXY_HUB_SECRETS) {
          if (!hub[field.redacted]) continue;
          const secret = yield* secretStore
            .get(cliProxyHubSecretName(hubId, field.suffix))
            .pipe(
              Effect.mapError((cause) =>
                toSettingsError(`failed to read the ${field.label} of hub ${hubId}`, cause),
              ),
            );
          materialized[field.value] = secret ? textDecoder.decode(secret) : "";
          if (!secret) delete materialized[field.redacted];
        }
        cliProxyHubs[hubId] = materialized;
      }
      return { ...settings, cliProxyHubs: cliProxyHubs as ServerSettings["cliProxyHubs"] };
    });

  const materializeSecrets = (settings: ServerSettings) =>
    materializeProviderEnvironmentSecrets(settings).pipe(
      Effect.flatMap(materializeCliProxyHubSecrets),
    );

  /**
   * Same contract as sensitive environment variables: a redacted entry keeps the stored key, a
   * submitted value replaces it, and an empty unredacted value removes it.
   *
   * New keys are stored before settings.json is written, and `restore` puts back the keys they
   * replaced if that write fails. Keys are only removed by `removeStale`, once the written file
   * no longer refers to them: a leftover key is harmless, a missing one loses the hub's key.
   */
  const persistCliProxyHubSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<
    {
      readonly settings: ServerSettings;
      readonly restore: Effect.Effect<void>;
      readonly removeStale: Effect.Effect<void>;
    },
    ServerSettingsError
  > => {
    const replaced: Array<{ readonly name: string; readonly previous: Uint8Array | null }> = [];
    const stale: Array<{ readonly hubId: string; readonly name: string }> = [];
    const restore = Effect.suspend(() =>
      Effect.forEach(
        replaced.toReversed(),
        ({ name, previous }) =>
          (previous ? secretStore.set(name, previous) : secretStore.remove(name)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to restore a CLIProxyAPI hub secret", {
                name,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    );
    const removeStale = Effect.suspend(() =>
      Effect.forEach(
        stale,
        ({ hubId, name }) =>
          secretStore.remove(name).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to remove an unused CLIProxyAPI hub secret", {
                hubId,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    );
    const storeKey = (hubId: string, name: string, label: string, value: string) =>
      Effect.gen(function* () {
        const previous = yield* secretStore.get(name);
        yield* secretStore.set(name, textEncoder.encode(value));
        replaced.push({ name, previous });
      }).pipe(
        Effect.mapError((cause) =>
          toSettingsError(`failed to persist the ${label} of hub ${hubId}`, cause),
        ),
      );
    return Effect.gen(function* () {
      const cliProxyHubs: Record<string, CliProxyHubConfig> = {};
      for (const [hubId, entry] of Object.entries(next.cliProxyHubs)) {
        const stored = (current.cliProxyHubs as Record<string, CliProxyHubConfig>)[hubId];
        const hub = { ...entry };
        // An older client cannot edit these fields. Preserve its saved token unless the
        // patch explicitly includes Cloudflare fields (empty values remove the token).
        if (
          stored &&
          entry.cloudflareAccessClientId === undefined &&
          entry.cloudflareAccessClientSecret === undefined &&
          entry.cloudflareAccessClientSecretRedacted === undefined
        ) {
          for (const key of [
            "cloudflareAccessClientId",
            "cloudflareAccessClientSecret",
            "cloudflareAccessClientSecretRedacted",
          ] as const) {
            if (stored[key] !== undefined) Object.assign(hub, { [key]: stored[key] });
          }
        }
        const invalid = validateCloudflareAccessCredentials({
          clientId: hub.cloudflareAccessClientId,
          clientSecret: hub.cloudflareAccessClientSecret,
          hasSavedSecret: hub.cloudflareAccessClientSecretRedacted,
        });
        if (invalid) return yield* toSettingsError(invalid, undefined);

        for (const field of CLI_PROXY_HUB_SECRETS) {
          const secretName = cliProxyHubSecretName(hubId, field.suffix);
          const value = hub[field.value]?.trim() ?? "";
          if (value.length > 0) {
            yield* storeKey(hubId, secretName, field.label, value);
            hub[field.value] = "";
            hub[field.redacted] = true;
          } else if (hub[field.redacted]) {
            if (!stored || !(stored[field.value]?.length || stored[field.redacted])) {
              return yield* toSettingsError(
                `Enter the ${field.label} of hub ${hubId}: no saved value exists.`,
                undefined,
              );
            }
            // A saved secret only ever goes to the address it was entered for.
            if (hubKeyAddress(stored.url) !== hubKeyAddress(hub.url)) {
              return yield* toSettingsError(
                `Enter the ${field.label} of hub ${hubId} again: its address changed.`,
                undefined,
              );
            }
            if (
              field.value === "cloudflareAccessClientSecret" &&
              stored?.cloudflareAccessClientId?.trim() !== hub.cloudflareAccessClientId?.trim()
            ) {
              return yield* toSettingsError(
                `Enter the Cloudflare Access Client Secret of hub ${hubId} again: its Client ID changed.`,
                undefined,
              );
            }
            // Migrate a hand-edited plaintext secret before replacing it with a marker.
            const plaintext = stored && !stored[field.redacted] ? stored[field.value]?.trim() : "";
            if (plaintext) yield* storeKey(hubId, secretName, field.label, plaintext);
            hub[field.value] = "";
          } else {
            stale.push({ hubId, name: secretName });
            delete hub[field.redacted];
            if (hub[field.value] !== undefined) hub[field.value] = "";
          }
        }
        cliProxyHubs[hubId] = hub;
      }
      for (const hubId of Object.keys(current.cliProxyHubs)) {
        if (Object.hasOwn(next.cliProxyHubs, hubId)) continue;
        for (const field of CLI_PROXY_HUB_SECRETS) {
          stale.push({ hubId, name: cliProxyHubSecretName(hubId, field.suffix) });
        }
      }
      return {
        settings: { ...next, cliProxyHubs: cliProxyHubs as ServerSettings["cliProxyHubs"] },
        restore,
        removeStale,
      };
    }).pipe(Effect.onError(() => restore));
  };

  const persistProviderEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          const secretName = providerEnvironmentSecretName({
            instanceId,
            name: variable.name,
          });
          if (!variable.sensitive) {
            yield* secretStore
              .remove(secretName)
              .pipe(
                Effect.mapError((cause) =>
                  toSettingsError(`failed to remove environment secret ${variable.name}`, cause),
                ),
              );
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          if (!variable.valueRedacted) {
            if (variable.value.length > 0) {
              yield* secretStore
                .set(secretName, textEncoder.encode(variable.value))
                .pipe(
                  Effect.mapError((cause) =>
                    toSettingsError(`failed to persist environment secret ${variable.name}`, cause),
                  ),
                );
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              yield* secretStore
                .remove(secretName)
                .pipe(
                  Effect.mapError((cause) =>
                    toSettingsError(`failed to remove environment secret ${variable.name}`, cause),
                  ),
                );
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({
            instanceId,
            name: variable.name,
          });
          if (nextSecretKeys.has(secretName)) continue;
          yield* secretStore
            .remove(secretName)
            .pipe(
              Effect.mapError((cause) =>
                toSettingsError(
                  `failed to remove stale environment secret ${variable.name}`,
                  cause,
                ),
              ),
            );
        }
      }

      return {
        ...next,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const writeSettingsAtomically = (settings: ServerSettings) => {
    const { persisted, unreadableKeys } = toPersistedServerSettings(settings);
    return writeFileStringAtomically({
      filePath: settingsPath,
      contents: `${JSON.stringify(persisted, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
      Effect.tap(() =>
        unreadableKeys.length > 0
          ? Effect.logWarning("settings.json does not read back these keys as saved", {
              path: settingsPath,
              keys: unreadableKeys,
            })
          : Effect.void,
      ),
    );
  };

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      noteStorageSettingsChange();
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to prepare settings directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    withSettingsSnapshot: writeSemaphore.withPermits(1),
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const normalizedPatch = { ...patch };
          const validateRoot = (root: string, label?: string) =>
            validateWorktreeRoot(root, worktreeAccessPolicy, label).pipe(
              Effect.mapError(
                (cause) => new ServerSettingsError({ settingsPath, detail: cause.message, cause }),
              ),
            );
          // Empty roots select the managed default and need no validation.
          if (patch.worktreeRoot)
            normalizedPatch.worktreeRoot = yield* validateRoot(patch.worktreeRoot);
          if (patch.chatsRoot)
            normalizedPatch.chatsRoot = yield* validateRoot(patch.chatsRoot, "Chats folder");
          if (patch.projectWorktreeRoots !== undefined) {
            const roots: Array<[string, string | null]> = [];
            for (const [id, root] of Object.entries(patch.projectWorktreeRoots)) {
              roots.push([id, root ? yield* validateRoot(root) : null]);
            }
            normalizedPatch.projectWorktreeRoots = Object.fromEntries(roots);
          }
          const patched = yield* Effect.try({
            try: () => applyServerSettingsPatch(current, normalizedPatch),
            catch: (cause) =>
              new ServerSettingsError({
                settingsPath,
                detail:
                  cause instanceof Error ? cause.message : "Invalid project preference patch.",
                cause,
              }),
          });
          // Before any comparison: an echoed redacted secret is no change at all.
          const restored = restoreRedactedServerSettingsSecrets(current, patched, normalizedPatch);
          if ("error" in restored) {
            return yield* new ServerSettingsError({ settingsPath, detail: restored.error });
          }
          const rawNext = restored.settings;
          const validated = yield* Schema.decodeEffect(ServerSettings)(rawNext).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  detail: "Invalid server preferences.",
                  cause,
                }),
            ),
          );
          const relevantChanges = [
            "providerInstances",
            "providers",
            "storageRetention",
            "projectStorageRetention",
          ].some(
            (key) =>
              JSON.stringify(current[key as keyof ServerSettings]) !==
              JSON.stringify(rawNext[key as keyof ServerSettings]),
          );
          // Compare BEFORE redaction and BEFORE any secret set/remove. Secret values
          // can change while persisted redacted JSON stays byte-for-byte identical.
          if (relevantChanges) {
            const release = yield* storageLifecycleLock.withPermit(
              Effect.gen(function* () {
                if (hasStorageSettingsLease())
                  return yield* new ServerSettingsError({
                    settingsPath,
                    detail:
                      "Storage removal is in progress. Retry provider or retention settings after it completes.",
                  });
                const release = acquireStorageSettingsUpdateLease();
                noteStorageSettingsChange();
                return release;
              }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(release));
          }
          const withProviderSecrets =
            JSON.stringify(current.providerInstances) === JSON.stringify(rawNext.providerInstances)
              ? validated
              : yield* persistProviderEnvironmentSecrets(current, validated);
          const hubSecrets =
            JSON.stringify(current.cliProxyHubs) === JSON.stringify(rawNext.cliProxyHubs)
              ? undefined
              : yield* persistCliProxyHubSecrets(current, withProviderSecrets);
          const restoreHubSecrets = hubSecrets?.restore ?? Effect.void;
          const next = yield* Schema.decodeEffect(ServerSettings)(
            hubSecrets?.settings ?? withProviderSecrets,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
                  cause,
                }),
            ),
            Effect.onError(() => restoreHubSecrets),
          );
          yield* storageLifecycleLock.withPermit(
            Effect.gen(function* () {
              yield* writeSettingsAtomically(next).pipe(Effect.onError(() => restoreHubSecrets));
              yield* Cache.set(settingsCache, cacheKey, next);
              yield* emitChange(next);
            }),
          );
          if (hubSecrets) yield* hubSecrets.removeStale;
          const materialized = yield* materializeSecrets(next);
          return resolveTextGenerationProvider(materialized);
        }).pipe(Effect.scoped, Effect.uninterruptible),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(
        Stream.mapEffect((settings) =>
          materializeSecrets(settings).pipe(
            Effect.catch((error: ServerSettingsError) =>
              Effect.logWarning("failed to materialize settings secrets", {
                detail: error.detail,
              }).pipe(Effect.as(settings)),
            ),
          ),
        ),
        Stream.map(resolveTextGenerationProvider),
      );
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings).pipe(
  Layer.provide(ServerSecretStoreLive),
);
