import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@ryco/contracts";
import { resolveCommandPath, resolveCommandPathAsync } from "@ryco/shared/shell";
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { compareCliVersions } from "./cliVersion.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
/**
 * Lives beside the per-instance status caches. Instance ids must start with a letter, so the
 * leading underscore can never collide with `<instanceId>.json`.
 */
const LATEST_VERSION_CACHE_FILE_NAME = "_provider-latest-versions.json";
/** PATH and realpath probing for update capabilities must never hold a caller longer than this. */
const MAINTENANCE_CAPABILITIES_TIMEOUT = Duration.seconds(5);
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /**
   * PATH resolution already performed by the caller (`null` = not found). When absent the
   * resolver walks PATH itself, synchronously.
   */
  readonly resolvedCommandPath?: string | null;
  readonly realCommandPath?: string | null;
}

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    options?: ProviderMaintenanceCapabilityResolutionOptions,
  ) => ProviderMaintenanceCapabilities;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly homebrewFormula: string | null;
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly lockKey: string;
    readonly isCommandPath: (commandPath: string) => boolean;
  } | null;
}

interface LatestVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

const latestVersionCache = new Map<string, LatestVersionCacheEntry>();
// The disk copy is merged into memory once per cache file, so a restart within the TTL does not
// re-contact the npm registry for every package-managed provider. Concurrent callers (provider
// enrichments run in parallel) wait for the one load in flight instead of missing it.
let latestVersionCacheLoad: {
  readonly filePath: string;
  readonly loaded: Deferred.Deferred<void>;
} | null = null;
const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});
const PersistedLatestVersionCache = Schema.Struct({
  entries: Schema.Record(
    Schema.String,
    Schema.Struct({
      expiresAt: Schema.Number,
      version: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodePersistedLatestVersionCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedLatestVersionCache),
);

export function clearLatestProviderVersionCacheForTests(): void {
  latestVersionCache.clear();
  latestVersionCacheLoad = null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command: [input.updateExecutable, ...input.updateArgs].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  });
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "npm",
    updateArgs: ["install", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "npm-global",
  });
}

function makeBunGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "bun",
    updateArgs: ["i", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "bun-global",
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "pnpm",
    updateArgs: ["add", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "pnpm-global",
  });
}

function makeVitePlusGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "vp",
    updateArgs: ["i", "-g", definition.npmPackageName],
    updateLockKey: "vite-plus-global",
  });
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  if (!definition.homebrewFormula) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    });
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "brew",
    updateArgs: ["upgrade", definition.homebrewFormula],
    updateLockKey: "homebrew",
  });
}

function makeNativeProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: definition.nativeUpdate.executable,
    updateArgs: definition.nativeUpdate.args,
    updateLockKey: definition.nativeUpdate.lockKey,
  });
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

function isNpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/node_modules/.bin/") ||
    normalized.includes("/lib/node_modules/") ||
    normalized.includes("/npm/node_modules/")
  );
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/homebrew/caskroom/") ||
    normalized.startsWith("/opt/homebrew/bin/")
  );
}

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition);
  }

  const resolvedCommandPath =
    (options?.resolvedCommandPath !== undefined
      ? options.resolvedCommandPath
      : resolveCommandPath(binaryPath, {
          ...(options?.platform ? { platform: options.platform } : {}),
          ...(options?.env ? { env: options.env } : {}),
        })) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);

  if (resolvedCommandPath) {
    const commandPaths = [
      resolvedCommandPath,
      ...(options?.realCommandPath ? [options.realCommandPath] : []),
    ];

    const nativeUpdate = definition.nativeUpdate;
    if (
      nativeUpdate &&
      commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))
    ) {
      return (
        makeNativeProviderMaintenanceCapabilities(definition) ??
        makeNpmGlobalProviderMaintenanceCapabilities(definition)
      );
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeVitePlusGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isBunGlobalCommandPath)) {
      return makeBunGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makePnpmGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isNpmGlobalCommandPath)) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return makeHomebrewProviderMaintenanceCapabilities(definition);
    }
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition);
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  });
}

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (options) => resolvePackageManagedProviderMaintenance(definition, options),
  };
}

export function makeStaticProviderMaintenanceResolver(
  capabilities: ProviderMaintenanceCapabilities,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () => capabilities,
  };
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

type ProviderMaintenanceResolutionInput = Omit<
  ProviderMaintenanceCapabilityResolutionOptions,
  "realCommandPath" | "resolvedCommandPath"
>;

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: ProviderMaintenanceResolutionInput,
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return resolver.resolve(options);
  }

  // Async and bounded per PATH entry: a stalled mount must not block the event loop.
  const resolvedCommandPath =
    (yield* Effect.promise(() =>
      resolveCommandPathAsync(binaryPath, {
        ...(options?.platform ? { platform: options.platform } : {}),
        ...(options?.env ? { env: options.env } : {}),
      }),
    )) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);
  if (!resolvedCommandPath) {
    return resolver.resolve({ ...options, resolvedCommandPath: null });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem.realPath(resolvedCommandPath).pipe(
    Effect.timeoutOption(MAINTENANCE_CAPABILITIES_TIMEOUT),
    Effect.map(Option.getOrElse(() => resolvedCommandPath)),
    Effect.catch(() => Effect.succeed(resolvedCommandPath)),
  );
  return resolver.resolve({
    ...options,
    resolvedCommandPath,
    realCommandPath,
  });
});

/**
 * Maintenance capabilities resolved on first use instead of during driver construction.
 *
 * Resolution walks PATH and realpaths the binary, which can stall behind a saturated libuv
 * threadpool or a slow (network/File Provider) mount. It therefore runs once, in a fiber owned by
 * the caller's scope, the first time version-advisory enrichment or an update action asks for it.
 * A caller waits at most {@link MAINTENANCE_CAPABILITIES_TIMEOUT}; on timeout it gets the
 * PATH-independent resolution, and later callers see the real result once it lands.
 */
export const makeLazyProviderMaintenanceCapabilities = Effect.fn(
  "makeLazyProviderMaintenanceCapabilities",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: ProviderMaintenanceResolutionInput,
): Effect.fn.Return<
  Effect.Effect<ProviderMaintenanceCapabilities>,
  never,
  FileSystem.FileSystem | Scope.Scope
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const fallback = resolver.resolve({ ...options, resolvedCommandPath: null });
  const started = yield* Ref.make(false);
  const resolved = yield* Deferred.make<ProviderMaintenanceCapabilities>();
  const startResolution = Ref.getAndSet(started, true).pipe(
    Effect.flatMap((alreadyStarted) =>
      alreadyStarted
        ? Effect.void
        : resolveProviderMaintenanceCapabilitiesEffect(resolver, options).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.catchCause(() => Effect.succeed(fallback)),
            Effect.flatMap((capabilities) => Deferred.succeed(resolved, capabilities)),
            Effect.forkIn(scope),
            Effect.asVoid,
          ),
    ),
  );
  return startResolution.pipe(
    Effect.andThen(Deferred.await(resolved)),
    Effect.timeoutOption(MAINTENANCE_CAPABILITIES_TIMEOUT),
    Effect.map(Option.getOrElse(() => fallback)),
  );
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareCliVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const client = yield* HttpClient.HttpClient;
  // npm registry convention: keep '@' literal in scoped names, only encode '/'.
  // encodeURIComponent percent-encodes '@', which some CDN/proxy layers reject.
  const encodedPackageName = packageName.replace(/\//g, "%2f");
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodedPackageName}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.catch(() => Effect.succeed(null)),
  );
  return payload ? nonEmptyString(payload.version) : null;
});

interface LatestVersionCacheStore {
  readonly filePath: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

// Optional services: without a server config (unit tests, CLI tools) the cache stays in memory.
const resolveLatestVersionCacheStore = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(config) || Option.isNone(fileSystem) || Option.isNone(path)) {
    return undefined;
  }
  return {
    filePath: path.value.join(config.value.providerStatusCacheDir, LATEST_VERSION_CACHE_FILE_NAME),
    fileSystem: fileSystem.value,
    path: path.value,
  } satisfies LatestVersionCacheStore;
});

const readPersistedLatestVersions = (store: LatestVersionCacheStore, nowMs: number) =>
  Effect.gen(function* () {
    const raw = yield* store.fileSystem
      .readFileString(store.filePath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) {
      return;
    }
    const persisted = yield* decodePersistedLatestVersionCache(raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    for (const [packageName, entry] of Object.entries(persisted?.entries ?? {})) {
      const current = latestVersionCache.get(packageName);
      if (entry.expiresAt > nowMs && (!current || current.expiresAt < entry.expiresAt)) {
        latestVersionCache.set(packageName, entry);
      }
    }
  });

const loadPersistedLatestVersions = (store: LatestVersionCacheStore, nowMs: number) =>
  Effect.suspend(() => {
    // Check and claim synchronously, so exactly one caller reads the file.
    if (latestVersionCacheLoad?.filePath === store.filePath) {
      return Deferred.await(latestVersionCacheLoad.loaded);
    }
    const loaded = Deferred.makeUnsafe<void>();
    latestVersionCacheLoad = { filePath: store.filePath, loaded };
    return readPersistedLatestVersions(store, nowMs).pipe(
      Effect.ensuring(Deferred.succeed(loaded, undefined)),
    );
  });

// Writes are serialized and each one snapshots the memory cache under the permit, so the file
// always ends with the newest state even when two lookups finish together.
const latestVersionCachePersistSemaphore = Semaphore.makeUnsafe(1);

const persistLatestVersions = (store: LatestVersionCacheStore, nowMs: number) =>
  latestVersionCachePersistSemaphore.withPermits(1)(
    Effect.suspend(() => {
      const entries = Object.fromEntries(
        [...latestVersionCache].filter(([, entry]) => entry.expiresAt > nowMs),
      );
      return writeFileStringAtomically({
        filePath: store.filePath,
        contents: `${JSON.stringify({ entries }, null, 2)}\n`,
      });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, store.fileSystem),
      Effect.provideService(Path.Path, store.path),
      Effect.catchCause((cause) =>
        Effect.logDebug("failed to persist provider latest-version cache", { cause }),
      ),
    ),
  );

/**
 * Latest published version of the provider's npm package, cached for an hour in memory and on
 * disk (so restarts within the hour skip the registry). `fresh` skips the cache read (a click-time
 * update check must rate what `<pkg>@latest` installs right now) but still writes the cache, so the
 * fetch also refreshes the hourly advisory data.
 */
export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
  options?: { readonly fresh?: boolean },
) {
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }

  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const store = yield* resolveLatestVersionCacheStore;
  if (store) {
    yield* loadPersistedLatestVersions(store, now);
  }
  const cached = latestVersionCache.get(packageName);
  if (options?.fresh !== true && cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* fetchNpmLatestVersion(packageName);
  latestVersionCache.set(packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  if (store) {
    yield* persistLatestVersions(store, now);
  }
  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (snapshot: ServerProvider, maintenanceCapabilities?: ProviderMaintenanceCapabilities) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  // Honor the server-wide opt-out. When disabled we skip latest-version
  // resolution entirely (no npm registry contact) and emit an "unknown"
  // advisory, rather than checking and then suppressing the notification.
  // Fall back to the default (enabled) if settings cannot be read.
  const serverSettings = yield* ServerSettingsService;
  const { enableProviderUpdateChecks } = yield* serverSettings.getSettings.pipe(
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
  );
  if (
    !enableProviderUpdateChecks ||
    !snapshot.enabled ||
    !snapshot.installed ||
    !snapshot.version
  ) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
