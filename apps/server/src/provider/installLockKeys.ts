/**
 * installLockKeys - the host-wide install lock key of a global package manager installation.
 *
 * Provider CLI updates (`providerMaintenance.ts`) and Ryco's own update (`nodeUpdate/`) take the
 * lock (`providerInstallLock.ts`) under these keys, so two installers on one machine never change
 * the same global install at once: `npm i -g` on one prefix, or bun's and pnpm's one global
 * folder each. Both sides derive the key here, never on their own.
 *
 * @module installLockKeys
 */

/** Forward slashes and lower case, so one path has one spelling on every platform. */
export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

/** bun keeps one global install per user. */
export const BUN_GLOBAL_INSTALL_LOCK_KEY = "bun-global";
/** pnpm keeps one global install per user. */
export const PNPM_GLOBAL_INSTALL_LOCK_KEY = "pnpm-global";

/** npm installs globally into a prefix; each prefix is its own install. */
export const npmGlobalInstallLockKey = (prefix: string) =>
  `npm-global:${normalizeCommandPath(prefix)}`;
