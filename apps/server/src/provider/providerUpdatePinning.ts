/**
 * providerUpdatePinning - which install an unattended provider update may run.
 *
 * Loaded with the update runner (`providerMaintenanceRunnerRuntime.ts`), never on boot. An update
 * nobody clicked installs exactly the release Ryco rated wherever the installer can name it, so a
 * release published after the rating cannot land. The few installers that cannot name one run
 * only on installs Ryco identified, and the runner checks what they installed afterwards.
 *
 * @module providerUpdatePinning
 */
import {
  PINNABLE_VERSION,
  pinLatestPackageSpec,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCommandAction,
} from "./providerMaintenance.ts";

/**
 * Installers that may name no version: Homebrew upgrades a keg to its formula's version, and a
 * provider's own updater (`<provider>-native`) installs its own newest release unless it takes a
 * target ({@link NATIVE_TARGET_ARGS}). Lock keys that name a path (`npm-global:<prefix>`) never
 * match.
 */
export function isSelfUpdatingProviderLockKey(lockKey: string): boolean {
  return lockKey === "homebrew" || /^[\w.-]+-native$/u.test(lockKey);
}

/** Provider updaters that take the version to install: `opencode upgrade [target]`. */
const NATIVE_TARGET_ARGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "opencode-native": ["upgrade"],
};

/** `update` with `version` after its arguments, or null when they are not the expected ones. */
function withTarget(
  update: ProviderMaintenanceCommandAction,
  version: string,
): ProviderMaintenanceCommandAction | null {
  const expected = NATIVE_TARGET_ARGS[update.lockKey];
  if (expected === undefined) return update;
  if (expected.join("\u0000") !== update.args.join("\u0000")) return null;
  return { ...update, args: [...update.args, version], command: `${update.command} ${version}` };
}

/**
 * The command an unattended update installs `version` with, or null when it may not run one.
 * Every installer whose arguments carry `<package>@latest` (npm, pnpm, bun, Yarn, Volta)
 * installs exactly `<package>@<version>`, and OpenCode's updater takes the version too.
 * Homebrew runs with `HOMEBREW_NO_AUTO_UPDATE=1`, so it installs the formula version `brew info`
 * reported, not one a tap update fetched meanwhile. A provider's own updater runs only on an
 * install a path proved to be its own (`installProven`), never on one Ryco merely assumed.
 * Anything else (Vite+, Cursor's updater) is left to one-click updates.
 */
export function resolvePinnedProviderUpdateAction(
  capabilities: ProviderMaintenanceCapabilities,
  version: string,
): ProviderMaintenanceCommandAction | null {
  const update = capabilities.update;
  if (update === null || !PINNABLE_VERSION.test(version)) return null;
  if (update.lockKey === "homebrew") {
    return { ...update, env: { ...update.env, HOMEBREW_NO_AUTO_UPDATE: "1" } };
  }
  if (isSelfUpdatingProviderLockKey(update.lockKey)) {
    return update.installProven === true ? withTarget(update, version) : null;
  }
  const packageName = capabilities.packageName;
  if (!packageName) return null;
  return pinLatestPackageSpec(update, packageName, version);
}
