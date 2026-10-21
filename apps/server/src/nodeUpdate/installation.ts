/**
 * nodeUpdate/installation - How this node's Ryco is installed, and what follows from it:
 * which release channel it tracks, whether it can install a release and restart itself,
 * and otherwise what someone at that machine can run instead.
 *
 * Detection is pure over a probe of the process (runtime mode, entry script, platform,
 * service environment), so every installation layout is testable with path fixtures;
 * {@link probeNodeInstallation} gathers that probe from the running process.
 *
 * @module nodeUpdate/installation
 */
import type {
  NodeInstallationKind,
  NodeReleaseChannel,
  NodeServiceManager,
  NodeUpdateAvailability,
} from "@ryco/contracts";
import { Duration, Effect, FileSystem, Option, Path, Schema } from "effect";

import { compareCliVersions, isParseableCliVersion } from "../provider/cliVersion.ts";
import { isEphemeralCliInstall, nodeServicePlatform } from "../service/nodeService.ts";

export const RYCO_CLI_PACKAGE = "ryco-cli";

export interface DetectedNodeInstallation {
  readonly kind: NodeInstallationKind;
  /** The service manager that restarts this process; `null` in the foreground. */
  readonly service: NodeServiceManager | null;
  /** `RYCO_SERVICE_LABEL` when `service` is set. */
  readonly serviceLabel: string | null;
  /** `npm-global`: the prefix the package is installed under. */
  readonly npmPrefix: string | null;
  /** The entry script the next start runs (as started, symlinks kept). */
  readonly entryScript: string | null;
  /**
   * `pnpm-global`: the process was started from one release's own pnpm folder rather
   * than the package link, so a newly installed release would not be what restarts.
   */
  readonly pinnedRelease: boolean;
}

export interface NodeInstallationProbe {
  readonly mode: "web" | "desktop";
  /** `process.argv[1]` made absolute, symlinks kept. */
  readonly invokedScriptPath: string | null;
  /** The same path with symlinks resolved. */
  readonly resolvedScriptPath: string | null;
  readonly platform: NodeJS.Platform;
  readonly serviceLabel: string | undefined;
  /** launchd starts its jobs itself, so a launchd service's parent is pid 1. */
  readonly parentPid: number;
  readonly temporaryDirectory: string;
  /** Whether `root` is a Git checkout of the Ryco repository. */
  readonly isRycoCheckout: (root: string) => boolean;
}

const BUN_GLOBAL_PATTERN = /\/\.bun\/install\/global\/node_modules\/ryco-cli\//u;
const PNPM_GLOBAL_PATTERN =
  /\/pnpm\/global\/[^/]+\/node_modules\/(?:\.pnpm\/ryco-cli@[^/]+\/node_modules\/)?ryco-cli\//iu;
const PNPM_RELEASE_FOLDER_PATTERN =
  /\/node_modules\/\.pnpm\/ryco-cli@[^/]+\/node_modules\/ryco-cli\//u;
const NPM_POSIX_GLOBAL_PATTERN = /^(.*)\/lib\/node_modules\/ryco-cli\//u;
const NPM_WINDOWS_GLOBAL_PATTERN = /^(.*)\/node_modules\/ryco-cli\//iu;
const SOURCE_CHECKOUT_ENTRY_PATTERN = /^(.*)\/apps\/server\/(?:dist\/bin\.mjs|src\/bin\.ts)$/u;

/** Forward slashes only; replaces one character with one, so indices still match the input. */
const toSlashes = (value: string) => value.replaceAll("\\", "/");

/** `<root>` when `scriptPath` is a Ryco checkout's server entry (`apps/server/…/bin`). */
export function sourceCheckoutRootCandidate(scriptPath: string): string | null {
  const match = SOURCE_CHECKOUT_ENTRY_PATTERN.exec(toSlashes(scriptPath));
  if (!match) return null;
  const root = scriptPath.slice(0, match[1]!.length);
  return root.length > 0 ? root : null;
}

/** The global prefix of an npm install, or `null` when `scriptPath` is not one. */
export function npmGlobalPrefix(scriptPath: string, platform: NodeJS.Platform): string | null {
  const normalized = toSlashes(scriptPath);
  const match = (platform === "win32" ? NPM_WINDOWS_GLOBAL_PATTERN : NPM_POSIX_GLOBAL_PATTERN).exec(
    normalized,
  );
  if (!match) return null;
  const prefix = match[1]!;
  // A package inside another package's node_modules is a dependency, not a global install.
  if (/(?:^|\/)node_modules(?:\/|$)/iu.test(prefix)) return null;
  if (prefix.length === 0) return platform === "win32" ? null : "/";
  return scriptPath.slice(0, prefix.length);
}

function serviceManagerFor(probe: NodeInstallationProbe): NodeServiceManager | null {
  if (!probe.serviceLabel) return null;
  const manager = nodeServicePlatform(probe.platform);
  // An inherited label alone does not make a foreground process the launchd job.
  if (manager === "launchd" && probe.parentPid !== 1) return null;
  return manager;
}

export function detectNodeInstallation(probe: NodeInstallationProbe): DetectedNodeInstallation {
  const service = probe.mode === "desktop" ? null : serviceManagerFor(probe);
  const base = {
    service,
    serviceLabel: service === null ? null : (probe.serviceLabel ?? null),
    npmPrefix: null,
    entryScript: probe.invokedScriptPath ?? probe.resolvedScriptPath,
    pinnedRelease: false,
  } satisfies Omit<DetectedNodeInstallation, "kind">;
  if (probe.mode === "desktop") {
    return { ...base, kind: "desktop-app", serviceLabel: null, entryScript: null };
  }
  const resolved = probe.resolvedScriptPath;
  if (resolved === null) return { ...base, kind: "unknown" };
  const normalized = toSlashes(resolved);
  if (isEphemeralCliInstall(normalized, probe.temporaryDirectory)) {
    return { ...base, kind: "ephemeral" };
  }
  if (BUN_GLOBAL_PATTERN.test(normalized)) return { ...base, kind: "bun-global" };
  if (PNPM_GLOBAL_PATTERN.test(normalized)) {
    const started = toSlashes(probe.invokedScriptPath ?? resolved);
    return {
      ...base,
      kind: "pnpm-global",
      pinnedRelease: PNPM_RELEASE_FOLDER_PATTERN.test(started),
    };
  }
  const npmPrefix = npmGlobalPrefix(resolved, probe.platform);
  if (npmPrefix !== null) return { ...base, kind: "npm-global", npmPrefix };
  const checkoutRoot = sourceCheckoutRootCandidate(resolved);
  if (checkoutRoot !== null && probe.isRycoCheckout(checkoutRoot)) {
    return { ...base, kind: "source-checkout" };
  }
  return { ...base, kind: "unknown" };
}

/** npm dist-tags double as release channels: a nightly build tracks `nightly`. */
export function nodeReleaseChannel(version: string): NodeReleaseChannel {
  return version.includes("-nightly.") ? "nightly" : "latest";
}

/** Whether `candidate` is a newer release than `current` (prerelease order included). */
export function isNewerNodeRelease(candidate: string, current: string): boolean {
  return (
    isParseableCliVersion(candidate) &&
    isParseableCliVersion(current) &&
    compareCliVersions(candidate, current) > 0
  );
}

/** `behind_latest` only for an older release: a newer local build (or nightly) is current. */
export function nodeUpdateAvailability(
  currentVersion: string,
  latestVersion: string | null,
): NodeUpdateAvailability {
  if (
    latestVersion === null ||
    !isParseableCliVersion(currentVersion) ||
    !isParseableCliVersion(latestVersion)
  ) {
    return "unknown";
  }
  return isNewerNodeRelease(latestVersion, currentVersion) ? "behind_latest" : "current";
}

const GLOBAL_KINDS = new Set<NodeInstallationKind>(["npm-global", "bun-global", "pnpm-global"]);

/** The command someone at the machine runs to install `spec` (a version or dist-tag). */
export function globalInstallCommandLine(kind: NodeInstallationKind, spec: string): string | null {
  const target = `${RYCO_CLI_PACKAGE}@${spec}`;
  switch (kind) {
    case "npm-global":
      return `npm install -g ${target}`;
    case "bun-global":
      return `bun add -g ${target}`;
    case "pnpm-global":
      return `pnpm add -g ${target}`;
    default:
      return null;
  }
}

export interface NodeUpdateCapability {
  readonly canUpdate: boolean;
  readonly manualReason: string | null;
  readonly manualCommand: string | null;
}

const manual = (manualReason: string, manualCommand: string | null): NodeUpdateCapability => ({
  canUpdate: false,
  manualReason,
  manualCommand,
});

export function nodeUpdateCapability(input: {
  readonly installation: DetectedNodeInstallation;
  readonly platform: NodeJS.Platform;
  readonly channel: NodeReleaseChannel;
  /** desktop-app: the app's last updater report; `null` until it sends one. */
  readonly desktop: { readonly enabled: boolean } | null;
}): NodeUpdateCapability {
  const { installation } = input;
  switch (installation.kind) {
    case "desktop-app":
      if (input.desktop === null) {
        return manual(
          "The desktop app has not reported its updater. Update it from the app.",
          null,
        );
      }
      if (!input.desktop.enabled) {
        return manual("Updates are turned off in this desktop app.", null);
      }
      return { canUpdate: true, manualReason: null, manualCommand: null };
    case "source-checkout":
      return manual(
        "This node runs from a source checkout. Run this in the checkout to update it.",
        "bun run node:update",
      );
    case "ephemeral":
      return manual(
        "This node was started through npx or bunx. Start it again to run the newest release.",
        `npx ${RYCO_CLI_PACKAGE}@${input.channel}`,
      );
    case "unknown":
      return manual("Ryco could not tell how it was installed on this node.", null);
    default:
      break;
  }
  const command = GLOBAL_KINDS.has(installation.kind)
    ? globalInstallCommandLine(installation.kind, input.channel)
    : null;
  if (input.platform === "win32") {
    return manual(
      "One-click updates are not available on Windows. Run this, then restart ryco.",
      command,
    );
  }
  if (installation.service === null || installation.serviceLabel === null) {
    return manual(
      "Ryco runs in the foreground here, so it cannot restart itself. Run this, then restart ryco.",
      command,
    );
  }
  if (installation.kind === "pnpm-global" && installation.pinnedRelease) {
    return manual(
      "The service starts one pnpm release folder. Run this, then `ryco service install` once more.",
      command,
    );
  }
  if (installation.entryScript === null) {
    return manual("Ryco could not find its own entry script on this node.", command);
  }
  if (installation.kind === "npm-global" && installation.npmPrefix === null) {
    return manual("Ryco could not find the npm prefix it is installed under.", command);
  }
  return { canUpdate: true, manualReason: null, manualCommand: null };
}

export interface NodeUpdateCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Input;
}

export const NODE_INSTALL_TIMEOUT = Duration.minutes(10);
export const NODE_VERIFY_TIMEOUT = Duration.seconds(60);

/**
 * Installs exactly `version` into the installation this process runs from: npm into its
 * own prefix (not whichever `npm` the PATH finds first), bun with the running bun.
 */
export function nodeInstallCommand(
  installation: DetectedNodeInstallation,
  version: string,
  execPath: string,
): NodeUpdateCommand | null {
  const target = `${RYCO_CLI_PACKAGE}@${version}`;
  switch (installation.kind) {
    case "npm-global":
      return installation.npmPrefix === null
        ? null
        : {
            command: "npm",
            args: ["install", "-g", "--prefix", installation.npmPrefix, target],
            timeout: NODE_INSTALL_TIMEOUT,
          };
    case "bun-global": {
      const runtime = execPath.split(/[\\/]/u).at(-1) ?? "";
      return {
        command: /^bun(?:\.exe)?$/iu.test(runtime) ? execPath : "bun",
        args: ["add", "-g", target],
        timeout: NODE_INSTALL_TIMEOUT,
      };
    }
    case "pnpm-global":
      return { command: "pnpm", args: ["add", "-g", target], timeout: NODE_INSTALL_TIMEOUT };
    default:
      return null;
  }
}

/** Runs the installed entry script once; it must report the release that was installed. */
export function nodeVerifyCommand(
  installation: DetectedNodeInstallation,
  execPath: string,
): NodeUpdateCommand | null {
  return installation.entryScript === null
    ? null
    : {
        command: execPath,
        args: [installation.entryScript, "--version"],
        timeout: NODE_VERIFY_TIMEOUT,
      };
}

const ROOT_PACKAGE_NAME = "@ryco/monorepo";
const RootPackageJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.optional(Schema.String) }),
);
const decodeRootPackageJson = Schema.decodeUnknownEffect(RootPackageJson);
const PROBE_TIMEOUT = Duration.seconds(5);

/** A Git checkout (`.git` directory, or file for a worktree) of the Ryco repository. */
const isRycoCheckoutRoot = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(path.join(root, ".git")))) return false;
    const manifest = yield* fs
      .readFileString(path.join(root, "package.json"))
      .pipe(Effect.flatMap(decodeRootPackageJson));
    return manifest.name === ROOT_PACKAGE_NAME;
  }).pipe(Effect.orElseSucceed(() => false));

/** Detects this process's installation; bounded, and `unknown` when the probe fails. */
export const probeNodeInstallation = Effect.fn("probeNodeInstallation")(function* (input: {
  readonly mode: "web" | "desktop";
  readonly argv1: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly serviceLabel: string | undefined;
  readonly parentPid: number;
  readonly temporaryDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const probe = Effect.gen(function* () {
    const invoked = input.argv1 ? path.resolve(input.argv1) : null;
    const resolved =
      invoked === null
        ? null
        : yield* fs.realPath(invoked).pipe(Effect.orElseSucceed(() => invoked));
    const checkoutRoot =
      resolved === null || input.mode === "desktop" ? null : sourceCheckoutRootCandidate(resolved);
    const checkout = checkoutRoot === null ? false : yield* isRycoCheckoutRoot(checkoutRoot);
    return detectNodeInstallation({
      mode: input.mode,
      invokedScriptPath: invoked,
      resolvedScriptPath: resolved,
      platform: input.platform,
      serviceLabel: input.serviceLabel,
      parentPid: input.parentPid,
      temporaryDirectory: input.temporaryDirectory,
      isRycoCheckout: (root) => checkout && root === checkoutRoot,
    });
  });
  const detected = yield* probe.pipe(
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => Option.none<DetectedNodeInstallation>()),
  );
  return Option.getOrElse(detected, (): DetectedNodeInstallation => ({
    kind: input.mode === "desktop" ? "desktop-app" : "unknown",
    service: null,
    serviceLabel: null,
    npmPrefix: null,
    entryScript: null,
    pinnedRelease: false,
  }));
});
