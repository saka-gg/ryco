import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@ryco/contracts";
import { resolveCommandPathAsync } from "@ryco/shared/shell";
import {
  Cause,
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
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { fetchNpmDistTagVersion } from "../npmRegistry.ts";
import { quoteWindowsShellArgument } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { compareCliVersions, satisfiesCliVersionRange } from "./cliVersion.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
/**
 * Lives beside the per-instance status caches. Instance ids must start with a letter, so the
 * leading underscore can never collide with `<instanceId>.json`.
 */
const LATEST_VERSION_CACHE_FILE_NAME = "_provider-latest-versions.json";
/** PATH and realpath probing for update capabilities must never hold a caller longer than this. */
const MAINTENANCE_CAPABILITIES_TIMEOUT = Duration.seconds(5);
/** One installer probe (`brew --prefix`, `pnpm --version`, `brew info`, `pnpm outdated`). */
const PROBE_TIMEOUT = Duration.seconds(10);
const PROBE_MAX_BYTES = 256 * 1_024;
/** One filesystem check during resolution (exists, stat, small reads, realpath). */
const FILE_PROBE_TIMEOUT = Duration.seconds(2);
const MISE_WRAPPER_MAX_BYTES = 16 * 1_024;
const HOMEBREW_RECEIPT_MAX_BYTES = 256 * 1_024;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * `undefined` means the installer has no channel of its own and the npm registry entry for
   * `packageName` is authoritative; `null` means the installer was asked and did not know (or must
   * not be second-guessed by npm, as with Homebrew, whose releases lag npm).
   */
  readonly latestVersion?: string | null;
  /**
   * The installer's own answer to "what would an update install" (`brew info`, `pnpm outdated`),
   * run only when update checks are enabled and cached apart from the npm entry. `null` falls
   * back to `latestVersion`, then npm.
   */
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  /**
   * The executable Ryco runs, symlinks followed, when no update command is proven for it. The
   * version advisory names it so the user knows which install to update.
   */
  readonly installPath?: string;
}

export interface ProviderMaintenanceCommandAction {
  /** Copyable command shown to the user (quoted for the platform's terminal). */
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /**
   * Variables merged over the server environment for this command. A native updater finds its
   * install through the same variables the provider runs with (e.g. `CODEX_HOME`).
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Where a configured binary was found, as the resolver sees it. */
export interface ProviderMaintenanceResolutionContext {
  readonly binaryPath: string;
  /** The PATH hit (or the configured path), symlinks not followed. */
  readonly resolvedCommandPath: string;
  /** `resolvedCommandPath` with symlinks and junctions followed. */
  readonly realCommandPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

export type ProviderMaintenanceResolverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

export interface ProviderMaintenanceCapabilitiesResolver {
  /** `null`: the binary was not found, or no path is configured. */
  readonly resolve: (
    context: ProviderMaintenanceResolutionContext | null,
  ) => Effect.Effect<ProviderMaintenanceCapabilities, never, ProviderMaintenanceResolverServices>;
}

export interface ProviderMaintenanceResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface HomebrewOwnership {
  readonly kind: "formula" | "cask";
  /** The keg's directory name under `Cellar` or `Caskroom`. */
  readonly name: string;
  /** The Homebrew prefix that holds the keg (`/opt/homebrew`, `/home/linuxbrew/.linuxbrew`). */
  readonly prefix: string;
  /** The keg's version directory. */
  readonly version: string;
}

export interface HomebrewInstall extends HomebrewOwnership {
  /** The tap a formula came from (`homebrew/core`, `anomalyco/tap`), when its receipt says. */
  readonly tap: string | null;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly nativeUpdate: {
    readonly args: ReadonlyArray<string>;
    /** Paths only the provider's own installer writes, matched on the visible and the real path. */
    readonly isCommandPath?: (commandPath: string) => boolean;
    /** Variables the native updater needs to find this install. */
    readonly env?: (context: ProviderMaintenanceResolutionContext) => NodeJS.ProcessEnv | undefined;
  } | null;
  /** Homebrew installs `brew upgrade` may update; every keg by default. */
  readonly supportsHomebrewInstall?: (install: HomebrewInstall) => boolean;
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

function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/['‘’]/g, "$&$&")}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}

function quoteUpdateExecutable(executable: string, platform: NodeJS.Platform): string {
  const quoted = quoteShellWord(executable, platform);
  // Windows terminals default to PowerShell, where a quoted executable needs `&`.
  return platform === "win32" && quoted !== executable ? `& ${quoted}` : quoted;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  /** Copyable command when it differs from the executed one (e.g. `brew` for a keg's brew). */
  readonly updateCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly latestVersion?: string | null;
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
}): ProviderMaintenanceCapabilities {
  const platform = input.platform ?? process.platform;
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command:
            input.updateCommand ??
            [
              quoteUpdateExecutable(input.updateExecutable, platform),
              ...input.updateArgs.map((arg) => quoteShellWord(arg, platform)),
            ].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(input.env ? { env: input.env } : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...("latestVersion" in input ? { latestVersion: input.latestVersion } : {}),
    ...(input.lookupLatestVersion ? { lookupLatestVersion: input.lookupLatestVersion } : {}),
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly installPath?: string;
  readonly latestVersion?: string | null;
}): ProviderMaintenanceCapabilities {
  return {
    ...makeProviderMaintenanceCapabilities({
      provider: input.provider,
      packageName: input.packageName,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
      ...("latestVersion" in input ? { latestVersion: input.latestVersion } : {}),
    }),
    ...(input.installPath ? { installPath: input.installPath } : {}),
  };
}

/**
 * The command an update installs `latestVersion` with. pnpm 11 resolves `@latest` to the newest
 * release older than `minimumReleaseAge` and exits 0, so a release the advisory advertised would
 * never install; an exact version installs it. Every other installer keeps its own command.
 */
export function resolveLatestProviderUpdateAction(
  capabilities: ProviderMaintenanceCapabilities,
  latestVersion: string | null,
): ProviderMaintenanceCommandAction | null {
  const update = capabilities.update;
  const packageName = capabilities.packageName;
  if (
    update?.lockKey !== "pnpm-global" ||
    !packageName ||
    latestVersion === null ||
    !/^\d+\.\d+\.\d+$/.test(latestVersion)
  ) {
    return update;
  }
  const latestSpec = `${packageName}@latest`;
  if (!update.args.includes(latestSpec)) return update;
  const pinnedSpec = `${packageName}@${latestVersion}`;
  const args = update.args.map((arg) => (arg === latestSpec ? pinnedSpec : arg));
  return { ...update, args, command: update.command.replace(latestSpec, pinnedSpec) };
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

/** Lower-cases ASCII only, so indexes stay valid in the original string. */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isInsideNodeModules(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/node_modules/");
}

/**
 * Vite+ shims live in `<VP_HOME>/bin`: `~/.vite-plus` by default, `~/.local/share/vite-plus` with
 * the XDG layout, and `%LOCALAPPDATA%\vite-plus` on Windows.
 */
function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return /\/(?:\.vite-plus|\.local\/share\/vite-plus|appdata\/local\/vite-plus)\/bin\//.test(
    normalizeCommandPath(commandPath),
  );
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
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

function isYarnGlobalCommandPath(commandPath: string): boolean {
  return /\/yarn\/(?:data\/)?global\/node_modules\//.test(normalizeCommandPath(commandPath));
}

/** Volta's `bin/<cmd>` links to its `volta-shim`, which picks the package at run time. */
function isVoltaShimPath(commandPath: string): boolean {
  return /\/volta-shim(?:\.exe)?$/.test(normalizeCommandPath(commandPath));
}

function isVoltaCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return /\/\.?volta\/(?:bin|tools\/image)\//.test(normalized) || isVoltaShimPath(normalized);
}

/**
 * A Volta shim proves the package is Volta's only when Volta holds the package's own image
 * (`<volta home>/tools/image/packages/<pkg>`); `volta install <pkg>` then replaces it.
 */
const isVoltaPackageInstall = Effect.fn("isVoltaPackageInstall")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  if (!isVoltaShimPath(context.realCommandPath)) {
    return false;
  }
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const voltaHome = path.dirname(path.dirname(context.resolvedCommandPath));
  const packageDir = path.join(voltaHome, "tools", "image", "packages", ...packageName.split("/"));
  return yield* boundedFileProbe(fileSystem.exists(packageDir), false);
});

/** Version-manager installs are pinned in its config, so updating them means editing that. */
function isMiseCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return normalized.includes("/mise/installs/") || normalized.includes("/mise/shims/");
}

/**
 * WinGet's install under its user root (`<drive>:\Users\<name>\AppData\Local\Microsoft\WinGet`) or
 * machine root (`<drive>:\Program Files\WinGet`): a `Links\<cmd>.exe` link or a binary in a
 * `Packages\<Publisher.Name>_…` directory. WinGet owns those files (`claude update` only reports
 * "managed by winget" and exits 0), and Ryco does not run `winget upgrade` itself.
 */
const WINGET_COMMAND_PATH =
  /^[a-z]:\/(?:users\/[^/]+\/appdata\/local\/microsoft|program files(?: \(x86\))?)\/winget\/(?:links\/[^/]+|packages\/[^/]+\/.+)$/;

function isWinGetCommandPath(commandPath: string): boolean {
  return WINGET_COMMAND_PATH.test(normalizeCommandPath(commandPath));
}

/**
 * Locations a system package manager (apt, dnf, apk, pacman, Nix, snap) owns. A provider's own
 * updater cannot write there, and replacing the file would fight the package manager anyway.
 * `/usr/local` is the admin's own prefix and stays eligible.
 */
function isSystemPackageCommandPath(commandPath: string): boolean {
  return /^\/(?:usr\/(?!local\/)|bin\/|sbin\/|nix\/store\/|snap\/|run\/current-system\/)/.test(
    normalizeCommandPath(commandPath),
  );
}

/**
 * The npm prefix that owns `packageName`, proven by `<prefix>/lib/node_modules/<pkg>/` in the real
 * path with no other `node_modules` before it (that would be a dependency of another package or a
 * project). Mise's npm backend uses the same layout inside a tool version; globals under its Node
 * installation still belong to npm.
 */
export function npmGlobalPrefixFromCommandPath(
  realCommandPath: string,
  packageName: string,
): string | null {
  const slashPath = realCommandPath.replaceAll("\\", "/");
  const normalized = asciiLowerCase(slashPath);
  const packageSegment = `/lib/node_modules/${asciiLowerCase(packageName)}/`;
  const packageIndex = normalized.lastIndexOf(packageSegment);
  if (packageIndex < 0 || normalized.slice(0, packageIndex).includes("/node_modules/")) {
    return null;
  }
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, packageIndex))?.[1];
  if (miseTool && miseTool !== "node") {
    return null;
  }
  // `\` → `/` keeps the length, so the index addresses the original spelling.
  return packageIndex === 0 ? "/" : realCommandPath.slice(0, packageIndex);
}

const HOMEBREW_KEG_PATTERN = /^(.*)\/(cellar|caskroom)\/([^/]+)\/([^/]+)\//i;

/** The keg a real executable path lives in: `<prefix>/(Cellar|Caskroom)/<name>/<version>/…`. */
export function homebrewOwnershipFromCommandPath(
  realCommandPath: string,
): HomebrewOwnership | null {
  const match = HOMEBREW_KEG_PATTERN.exec(realCommandPath.replaceAll("\\", "/"));
  if (!match) {
    return null;
  }
  return {
    kind: match[2]!.toLowerCase() === "cellar" ? "formula" : "cask",
    name: match[3]!,
    prefix: match[1]!,
    version: match[4]!,
  };
}

const HomebrewInfoResponse = Schema.Struct({
  formulae: Schema.optional(
    Schema.Array(
      Schema.Struct({
        versions: Schema.optional(Schema.Struct({ stable: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  casks: Schema.optional(Schema.Array(Schema.Struct({ version: Schema.optional(Schema.String) }))),
});
const decodeHomebrewInfo = Schema.decodeUnknownOption(Schema.fromJsonString(HomebrewInfoResponse));

/** `brew info --json=v2` → the version an upgrade installs. Cask versions may carry `,<build>`. */
export function parseHomebrewLatestVersion(
  infoJson: string,
  kind: HomebrewOwnership["kind"],
): string | null {
  const decoded = decodeHomebrewInfo(infoJson);
  if (Option.isNone(decoded)) {
    return null;
  }
  const raw =
    kind === "formula"
      ? decoded.value.formulae?.[0]?.versions?.stable
      : decoded.value.casks?.[0]?.version?.split(",", 1)[0];
  const version = nonEmptyString(raw);
  return version === "latest" ? null : version;
}

const HomebrewInstallReceipt = Schema.Struct({
  source: Schema.optional(Schema.Struct({ tap: Schema.optional(Schema.NullOr(Schema.String)) })),
});
const decodeHomebrewInstallReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(HomebrewInstallReceipt),
);

/** Bounds one filesystem check; a stall or failure reads as `fallback` ("not proven"). */
const boundedFileProbe = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: A) =>
  effect.pipe(
    Effect.timeoutOption(FILE_PROBE_TIMEOUT),
    Effect.map(Option.getOrElse(() => fallback)),
    Effect.orElseSucceed(() => fallback),
  );

/** Reads a small text file within the probe bounds; `null` when missing, larger, or stalled. */
const readSmallTextFile = Effect.fn("readSmallTextFile")(function* (
  filePath: string,
  maxBytes: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const size = yield* boundedFileProbe(
    fileSystem.stat(filePath).pipe(Effect.map((info) => Number(info.size))),
    Number.POSITIVE_INFINITY,
  );
  if (size > maxBytes) {
    return null;
  }
  return yield* boundedFileProbe(fileSystem.readFileString(filePath), null as string | null);
});

/**
 * Children for update commands and installer probes. Windows package managers (`npm`, `pnpm`,
 * `vp`, `yarn`) are `.cmd` shims, which `spawn` cannot start without `cmd.exe` (ENOENT/EINVAL).
 * Bare names and `.cmd`/`.bat` paths therefore run through the shell as one quoted command line
 * (Node only joins args given with `shell: true`, and warns about it); `.exe` paths and every
 * POSIX command spawn directly. `env` is merged over the server environment.
 */
export function makeMaintenanceChildProcess(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}) {
  const envOptions = input.env ? { env: input.env, extendEnv: true } : {};
  const platform = input.platform ?? process.platform;
  if (
    platform === "win32" &&
    (!hasPathSeparator(input.command) || /\.(?:cmd|bat)$/i.test(input.command))
  ) {
    return ChildProcess.make(
      [input.command, ...input.args].map(quoteWindowsShellArgument).join(" "),
      [],
      { ...envOptions, shell: true },
    );
  }
  return ChildProcess.make(input.command, [...input.args], envOptions);
}

/**
 * Runs an installer probe and returns its stdout, or `null` when it fails, exits outside
 * `okExitCodes`, overflows {@link PROBE_MAX_BYTES} or outlives {@link PROBE_TIMEOUT}. Never fails.
 */
const runMaintenanceProbe = Effect.fn("runMaintenanceProbe")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly okExitCodes?: ReadonlyArray<number>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const okExitCodes = input.okExitCodes ?? [0];
  const logContext = { command: input.command, subcommand: input.args[0] };
  const collect = Effect.gen(function* () {
    const child = yield* spawner.spawn(makeMaintenanceChildProcess(input));
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    // stderr is drained so a chatty tool cannot block on a full pipe.
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: PROBE_MAX_BYTES }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return okExitCodes.includes(Number(exitCode)) && !stdout.truncated ? stdout.text : null;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("Provider maintenance probe timed out", logContext).pipe(
            Effect.as(null),
          ),
        onSome: (stdout) => Effect.succeed(stdout),
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Provider maintenance probe failed", {
        ...logContext,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

const decodePnpmOutdated = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ latest: Schema.optional(Schema.String) })),
  ),
);
const decodePnpmList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        dependencies: Schema.optional(
          Schema.Record(Schema.String, Schema.Struct({ version: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
);

/** Unlike npm's `latest` tag, `pnpm outdated` respects `minimumReleaseAge` and its excludes. */
const resolvePnpmGlobalLatestVersion = Effect.fn("resolvePnpmGlobalLatestVersion")(function* (
  packageName: string,
  context: ProviderMaintenanceResolutionContext,
) {
  // Silent reporting keeps project package-manager warnings out of the JSON.
  const outdated = yield* runMaintenanceProbe({
    command: "pnpm",
    args: ["outdated", "-g", "--reporter=silent", "--format", "json", packageName],
    env: context.env,
    platform: context.platform,
    // `pnpm outdated` exits 1 when updates are available.
    okExitCodes: [0, 1],
  });
  const outdatedEntries = outdated
    ? Option.getOrUndefined(decodePnpmOutdated(outdated))
    : undefined;
  if (!outdatedEntries) return null;
  const latest = nonEmptyString(outdatedEntries[packageName]?.latest);
  if (latest) return latest;
  // An empty result means the installed version is still the eligible release.
  const listed = yield* runMaintenanceProbe({
    command: "pnpm",
    args: ["ls", "-g", "--reporter=silent", "--depth", "0", "--json", packageName],
    env: context.env,
    platform: context.platform,
  });
  const listedEntries = listed ? Option.getOrUndefined(decodePnpmList(listed)) : undefined;
  return nonEmptyString(listedEntries?.[0]?.dependencies?.[packageName]?.version);
});

const resolvePnpmGlobalProviderMaintenance = Effect.fn("resolvePnpmGlobalProviderMaintenance")(
  function* (
    definition: PackageManagedProviderMaintenanceDefinition,
    context: ProviderMaintenanceResolutionContext,
  ) {
    const packageName = definition.npmPackageName;
    // pnpm 10 skips unapproved install scripts and still exits 0, leaving a package whose
    // postinstall finishes the install broken. Global installs can only approve on the command
    // line, and pnpm before 10.4 rejects the flag as an unknown option.
    const pnpmVersion = nonEmptyString(
      yield* runMaintenanceProbe({
        command: "pnpm",
        args: ["--version"],
        env: context.env,
        platform: context.platform,
      }),
    );
    const allowBuild =
      pnpmVersion !== null && satisfiesCliVersionRange(pnpmVersion, ">=10.4.0")
        ? [`--allow-build=${packageName}`]
        : [];
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "pnpm",
      updateArgs: ["add", "-g", ...allowBuild, `${packageName}@latest`],
      updateLockKey: "pnpm-global",
      platform: context.platform,
      lookupLatestVersion: resolvePnpmGlobalLatestVersion(packageName, context).pipe(
        Effect.provideContext(services),
      ),
    });
  },
);

/**
 * `<prefix>/lib/node_modules/<pkg>/` in the real path, or on Windows (where npm's prefix has no
 * `lib`) a shim directory holding `node_modules/<pkg>/package.json`. npm writes `<cmd>.cmd` and an
 * extensionless sh script into that directory; a POSIX project checkout has the same shape, which
 * is why the shim check is Windows-only.
 */
const resolveNpmGlobalPrefix = Effect.fn("resolveNpmGlobalPrefix")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  const fromRealPath = npmGlobalPrefixFromCommandPath(context.realCommandPath, packageName);
  if (fromRealPath) {
    return fromRealPath;
  }
  if (context.platform !== "win32") {
    return null;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimDir = path.dirname(context.resolvedCommandPath);
  const manifestPath = path.join(
    shimDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  const hasManifest = yield* boundedFileProbe(fileSystem.exists(manifestPath), false);
  return hasManifest ? shimDir : null;
});

/** A small `#!` launcher that execs `mise x …` belongs to mise, wherever it sits. */
const isMiseWrapperScript = Effect.fn("isMiseWrapperScript")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const script = yield* readSmallTextFile(context.realCommandPath, MISE_WRAPPER_MAX_BYTES);
  return script !== null && script.startsWith("#!") && /\bmise\s+(?:x|exec)\b/.test(script);
});

/** The tap a formula keg was installed from, read from its `INSTALL_RECEIPT.json`. */
const readHomebrewFormulaTap = Effect.fn("readHomebrewFormulaTap")(function* (
  ownership: HomebrewOwnership,
) {
  if (ownership.kind !== "formula") {
    return null;
  }
  const path = yield* Path.Path;
  const receipt = yield* readSmallTextFile(
    path.join(
      ownership.prefix,
      "Cellar",
      ownership.name,
      ownership.version,
      "INSTALL_RECEIPT.json",
    ),
    HOMEBREW_RECEIPT_MAX_BYTES,
  );
  if (receipt === null) {
    return null;
  }
  return nonEmptyString(
    Option.getOrUndefined(decodeHomebrewInstallReceipt(receipt))?.source?.tap ?? null,
  );
});

/** A formula from a third-party tap is addressed by its full name, so core's namesake never wins. */
function homebrewUpgradeName(install: HomebrewInstall): string {
  return install.kind === "formula" && install.tap !== null && install.tap !== "homebrew/core"
    ? `${install.tap}/${install.name}`
    : install.name;
}

/**
 * `brew upgrade` capabilities once the keg's prefix is confirmed by a `brew` that reports it as its
 * own. The latest version comes from `brew info` (Homebrew's release can lag npm, and only its own
 * channel says what an upgrade installs), looked up only when update checks need it. Null when no
 * `brew` is found or it owns another prefix.
 */
export const resolveHomebrewProviderMaintenance = Effect.fn("resolveHomebrewProviderMaintenance")(
  function* (input: {
    readonly provider: ProviderDriverKind;
    readonly packageName: string | null;
    readonly install: HomebrewInstall;
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    /** `false` keeps the advisory's latest version unknown instead of asking `brew info`. */
    readonly lookupLatestVersion?: boolean;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { install } = input;
    // The keg's own brew works even when a GUI-launched server has no Homebrew on PATH; the
    // prefix check below still applies to it.
    const kegBrewPath = path.join(install.prefix, "bin", "brew");
    const brewPath = (yield* boundedFileProbe(fileSystem.exists(kegBrewPath), false))
      ? kegBrewPath
      : yield* Effect.promise(() =>
          resolveCommandPathAsync("brew", { env: input.env, platform: input.platform }),
        );
    if (!brewPath) {
      return null;
    }
    const brewPrefix = nonEmptyString(
      yield* runMaintenanceProbe({
        command: brewPath,
        args: ["--prefix"],
        env: input.env,
        platform: input.platform,
      }),
    );
    const realBrewPrefix = brewPrefix
      ? yield* boundedFileProbe(fileSystem.realPath(brewPrefix), brewPrefix)
      : null;
    if (
      !realBrewPrefix ||
      normalizeCommandPath(realBrewPrefix).replace(/\/+$/, "") !==
        normalizeCommandPath(install.prefix).replace(/\/+$/, "")
    ) {
      return null;
    }
    const name = homebrewUpgradeName(install);
    const args = install.kind === "cask" ? ["upgrade", "--cask", name] : ["upgrade", name];
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeProviderMaintenanceCapabilities({
      provider: input.provider,
      packageName: input.packageName,
      updateExecutable: brewPath,
      updateArgs: args,
      updateLockKey: "homebrew",
      updateCommand: ["brew", ...args].join(" "),
      platform: input.platform,
      latestVersion: null,
      ...(input.lookupLatestVersion === false
        ? {}
        : {
            lookupLatestVersion: runMaintenanceProbe({
              command: brewPath,
              args: ["info", "--json=v2", install.kind === "cask" ? "--cask" : "--formula", name],
              env: input.env,
              platform: input.platform,
            }).pipe(
              Effect.map((info) => (info ? parseHomebrewLatestVersion(info, install.kind) : null)),
              Effect.provideContext(services),
            ),
          }),
    });
  },
);

/** Homebrew ownership of a real path, with the formula's tap, or `null` outside a keg. */
export const resolveHomebrewInstall = Effect.fn("resolveHomebrewInstall")(function* (
  realCommandPath: string,
) {
  const ownership = homebrewOwnershipFromCommandPath(realCommandPath);
  if (!ownership) {
    return null;
  }
  return { ...ownership, tap: yield* readHomebrewFormulaTap(ownership) } satisfies HomebrewInstall;
});

/**
 * Picks the update command from where the binary really lives, and only from evidence:
 *
 * 1. WinGet-owned files stay manual.
 * 2. The provider's own install location (outside mise) uses its updater on the resolved path.
 * 3. Vite+, bun and pnpm global bins use their package manager.
 * 4. Yarn (v1) globals and Volta-held packages use their tool; other Volta paths and mise pin
 *    versions in their own config, so they stay manual.
 * 5. npm when the real path proves the global prefix that owns the package.
 * 6. Homebrew when a `brew` confirms the keg's prefix.
 * 7. Otherwise the provider's own updater, unless the path sits inside some other `node_modules`
 *    or a system package location (both manual), or the provider has none (manual).
 */
export const resolvePackageManagedProviderMaintenance = Effect.fn(
  "resolvePackageManagedProviderMaintenance",
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: ProviderMaintenanceResolutionContext | null,
): Effect.fn.Return<ProviderMaintenanceCapabilities, never, ProviderMaintenanceResolverServices> {
  const packageName = definition.npmPackageName;
  if (!context) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
    });
  }
  const manual = makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName,
    installPath: context.realCommandPath,
  });
  const commandPaths = [context.resolvedCommandPath, context.realCommandPath];
  if (context.platform === "win32" && commandPaths.some(isWinGetCommandPath)) {
    return manual;
  }

  const nativeUpdate = definition.nativeUpdate;
  const nativeEnv = nativeUpdate?.env?.(context);
  const native = nativeUpdate
    ? makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName,
        // The resolved path, so the update never reaches another CLI of the same name.
        updateExecutable: context.resolvedCommandPath,
        updateArgs: nativeUpdate.args,
        updateLockKey: `${definition.provider}-native`,
        platform: context.platform,
        ...(nativeEnv ? { env: nativeEnv } : {}),
      })
    : manual;
  // A native-looking launcher can still delegate to a mise-owned install.
  const miseOwned = commandPaths.some(isMiseCommandPath) || (yield* isMiseWrapperScript(context));
  if (nativeUpdate?.isCommandPath && commandPaths.some(nativeUpdate.isCommandPath) && !miseOwned) {
    return native;
  }
  // A `node_modules` path not proven below belongs to another package or a project, so the
  // provider's own updater could act on the wrong install.
  const fallback = commandPaths.some(
    (commandPath) =>
      isInsideNodeModules(commandPath) ||
      (context.platform !== "win32" && isSystemPackageCommandPath(commandPath)),
  )
    ? manual
    : native;

  if (commandPaths.some(isVitePlusGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "vp",
      updateArgs: ["i", "-g", packageName],
      updateLockKey: "vite-plus-global",
      platform: context.platform,
    });
  }
  if (commandPaths.some(isBunGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "bun",
      updateArgs: ["i", "-g", `${packageName}@latest`],
      updateLockKey: "bun-global",
      platform: context.platform,
    });
  }
  if (commandPaths.some(isPnpmGlobalCommandPath)) {
    return yield* resolvePnpmGlobalProviderMaintenance(definition, context);
  }
  if (commandPaths.some(isYarnGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "yarn",
      updateArgs: ["global", "add", `${packageName}@latest`],
      updateLockKey: "yarn-global",
      platform: context.platform,
    });
  }
  if (yield* isVoltaPackageInstall(context, packageName)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "volta",
      updateArgs: ["install", `${packageName}@latest`],
      updateLockKey: "volta",
      platform: context.platform,
    });
  }
  if (commandPaths.some(isVoltaCommandPath)) {
    return manual;
  }

  // npm proof names the package, so it outranks a keg the path merely passes through: a
  // Homebrew-installed Node keeps its globals under `Cellar/node/<ver>/lib/node_modules/`, and
  // that is npm's install, not brew's.
  const npmPrefix = yield* resolveNpmGlobalPrefix(context, packageName);
  if (npmPrefix) {
    // npm 12 blocks install scripts by default (empty allow-scripts allowlist) and still exits 0,
    // so a package whose postinstall finishes the install (claude copies its native binary over
    // a placeholder stub) is left broken while the update reports success. Older npm warns about
    // the unknown config and continues.
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        npmPrefix,
        `--allow-scripts=${packageName}`,
        `${packageName}@latest`,
      ],
      updateLockKey: `npm-global:${normalizeCommandPath(npmPrefix)}`,
      platform: context.platform,
    });
  }

  const homebrew = yield* resolveHomebrewInstall(context.realCommandPath);
  // Mise shims resolve to the version manager's own keg, not the provider's.
  if (miseOwned || (homebrew?.kind === "formula" && homebrew.name.toLowerCase() === "mise")) {
    return manual;
  }
  if (homebrew) {
    // Brew owns the keg, so neither npm's release nor the provider's own updater applies to it.
    const manualHomebrew = makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      installPath: context.realCommandPath,
      latestVersion: null,
    });
    if (definition.supportsHomebrewInstall && !definition.supportsHomebrewInstall(homebrew)) {
      return manualHomebrew;
    }
    return (
      (yield* resolveHomebrewProviderMaintenance({
        provider: definition.provider,
        packageName,
        install: homebrew,
        env: context.env,
        platform: context.platform,
      })) ?? manualHomebrew
    );
  }

  return fallback;
});

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (context) => resolvePackageManagedProviderMaintenance(definition, context),
  };
}

export function makeStaticProviderMaintenanceResolver(
  capabilities: ProviderMaintenanceCapabilities,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () => Effect.succeed(capabilities),
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

/** Follows symlinks and junctions within the probe bounds; `null` when that fails or stalls. */
export const resolveRealCommandPath = (commandPath: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.realPath(commandPath).pipe(
        Effect.timeoutOption(MAINTENANCE_CAPABILITIES_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      ),
    ),
  );

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: ProviderMaintenanceResolutionOptions,
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return yield* resolver.resolve(null);
  }

  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  // Async and bounded per PATH entry: a stalled mount must not block the event loop.
  const resolvedCommandPath = yield* Effect.promise(() =>
    resolveCommandPathAsync(binaryPath, { platform, env }),
  );
  if (!resolvedCommandPath) {
    return yield* resolver.resolve(null);
  }
  // Without the real path nothing about the install is proven.
  const realCommandPath = yield* resolveRealCommandPath(resolvedCommandPath);
  if (!realCommandPath) {
    return yield* resolver.resolve(null);
  }
  return yield* resolver.resolve({
    binaryPath,
    resolvedCommandPath,
    realCommandPath,
    env,
    platform,
  });
});

/**
 * Maintenance capabilities resolved on first use instead of during driver construction.
 *
 * Resolution walks PATH, realpaths the binary and may ask an installer about itself (`brew
 * --prefix`, `pnpm --version`), any of which can stall behind a saturated libuv threadpool or a
 * slow (network/File Provider) mount. It therefore runs once, in a fiber owned by the caller's
 * scope, the first time version-advisory enrichment or an update action asks for it. A caller
 * waits at most {@link MAINTENANCE_CAPABILITIES_TIMEOUT}; on timeout it gets the PATH-independent
 * resolution (manual), and later callers see the real result once it lands.
 */
export const makeLazyProviderMaintenanceCapabilities = Effect.fn(
  "makeLazyProviderMaintenanceCapabilities",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: ProviderMaintenanceResolutionOptions,
): Effect.fn.Return<
  Effect.Effect<ProviderMaintenanceCapabilities>,
  never,
  ProviderMaintenanceResolverServices | Scope.Scope
> {
  const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
  const scope = yield* Scope.Scope;
  const fallback = yield* resolver.resolve(null);
  const started = yield* Ref.make(false);
  const resolved = yield* Deferred.make<ProviderMaintenanceCapabilities>();
  const startResolution = Ref.getAndSet(started, true).pipe(
    Effect.flatMap((alreadyStarted) =>
      alreadyStarted
        ? Effect.void
        : resolveProviderMaintenanceCapabilitiesEffect(resolver, options).pipe(
            Effect.provideContext(services),
            Effect.catchCause((cause) =>
              Effect.logWarning("Provider maintenance capability resolution failed", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(fallback)),
            ),
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

/**
 * An install Ryco cannot update gets no Update button or command, so its message names the
 * version and the executable instead.
 */
function manualUpdateMessage(latestVersion: string, installPath: string | undefined): string {
  return installPath
    ? `Version ${latestVersion} is out. Ryco runs ${installPath}; update it with the app or tool that installed it.`
    : `Version ${latestVersion} is out. Update it with the app or tool that installed it.`;
}

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly capabilities: ProviderMaintenanceCapabilities;
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
      message:
        input.capabilities.update === null
          ? manualUpdateMessage(input.latestVersion, input.capabilities.installPath)
          : PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
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
    capabilities,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: resolveLatestProviderUpdateAction(capabilities, latestVersion)?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

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
    for (const [cacheKey, entry] of Object.entries(persisted?.entries ?? {})) {
      const current = latestVersionCache.get(cacheKey);
      if (entry.expiresAt > nowMs && (!current || current.expiresAt < entry.expiresAt)) {
        latestVersionCache.set(cacheKey, entry);
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

const cachedLatestVersion = Effect.fn("cachedLatestVersion")(function* <R>(
  cacheKey: string,
  lookup: Effect.Effect<string | null, never, R>,
  options?: { readonly fresh?: boolean },
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const store = yield* resolveLatestVersionCacheStore;
  if (store) {
    yield* loadPersistedLatestVersions(store, now);
  }
  const cached = latestVersionCache.get(cacheKey);
  if (options?.fresh !== true && cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* lookup;
  latestVersionCache.set(cacheKey, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  if (store) {
    yield* persistLatestVersions(store, now);
  }
  return version;
});

/**
 * The installer's own answer is cached apart from the npm registry entry, per executable and
 * update target: two Homebrew prefixes, or a formula and a cask, never share a version.
 */
export function installerLatestVersionCacheKey(
  capabilities: ProviderMaintenanceCapabilities,
): string | null {
  const update = capabilities.update;
  return capabilities.lookupLatestVersion && update
    ? ["installer", update.lockKey, update.executable, ...update.args].join("\u0000")
    : null;
}

/**
 * Latest version the provider's installer would install, cached for an hour in memory and on disk
 * (so restarts within the hour skip the registry and installer probes). The installer's own
 * channel (`brew info`, `pnpm outdated`) answers first; Homebrew installs never fall back to npm.
 * `fresh` skips the cache read (a click-time update check must rate what the update installs right
 * now) but still writes the cache, so the lookup also refreshes the hourly advisory data.
 */
export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
  options?: { readonly fresh?: boolean },
) {
  const installerKey = installerLatestVersionCacheKey(maintenanceCapabilities);
  if (installerKey && maintenanceCapabilities.lookupLatestVersion) {
    const installable = yield* cachedLatestVersion(
      installerKey,
      maintenanceCapabilities.lookupLatestVersion,
      options,
    );
    if (installable !== null) {
      return installable;
    }
  }
  if (maintenanceCapabilities.latestVersion !== undefined) {
    return maintenanceCapabilities.latestVersion;
  }
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }
  return yield* cachedLatestVersion(
    packageName,
    fetchNpmDistTagVersion(packageName, "latest"),
    options,
  );
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (snapshot: ServerProvider, maintenanceCapabilities?: ProviderMaintenanceCapabilities) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  // Honor the server-wide opt-out. When disabled we skip latest-version
  // resolution entirely (no registry or installer contact) and emit an
  // "unknown" advisory, rather than checking and then suppressing the
  // notification. Fall back to the default (enabled) if settings cannot be read.
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
