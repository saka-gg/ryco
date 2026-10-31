/**
 * providerUpdatePinning - which install an unattended provider update may run.
 *
 * Loaded with the update runner (`providerMaintenanceRunnerRuntime.ts`), never on boot. An update
 * nobody clicked installs exactly the release Ryco rated, so a release published after the rating
 * can never land; only installers that take no version run as they are.
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
 * Installers that take no version: Homebrew upgrades a keg to its formula's version, and a
 * provider's own updater (`<provider>-native`) installs its own newest release. Lock keys that
 * name a path (`npm-global:<prefix>`) never match.
 */
export function isSelfUpdatingProviderLockKey(lockKey: string): boolean {
  return lockKey === "homebrew" || /^[\w.-]+-native$/u.test(lockKey);
}

/**
 * The command an unattended update installs `version` with, or null when it cannot name that
 * version. Every installer whose arguments carry `<package>@latest` (npm, pnpm, bun, Yarn, Volta)
 * installs exactly `<package>@<version>`, so nothing newer than the rated release can land.
 * Only self-updating installers ({@link isSelfUpdatingProviderLockKey}) run unpinned; anything
 * else (Vite+, Cursor's updater) is left to one-click updates.
 */
export function resolvePinnedProviderUpdateAction(
  capabilities: ProviderMaintenanceCapabilities,
  version: string,
): ProviderMaintenanceCommandAction | null {
  const update = capabilities.update;
  if (update === null) return null;
  if (isSelfUpdatingProviderLockKey(update.lockKey)) return update;
  const packageName = capabilities.packageName;
  if (!packageName || !PINNABLE_VERSION.test(version)) return null;
  return pinLatestPackageSpec(update, packageName, version);
}
