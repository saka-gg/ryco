/**
 * Rules of a fork carried to another node (`threads.forkCarried`) that the target node and every
 * client apply the same way, so what a client shows before Fork is what the node does.
 *
 * Pure module.
 */
import { defaultInstanceIdForDriver } from "@ryco/contracts/provider-instance";

export interface CarriedForkInstanceCandidate {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
}

/**
 * The provider instance a carried fork runs on: provider instance ids are machine-local, so the
 * target node picks its own instance of the source's driver. Its default instance of that driver
 * when enabled, otherwise its first enabled one by id; null when it has none.
 */
export function pickCarriedForkInstance<T extends CarriedForkInstanceCandidate>(
  instances: ReadonlyArray<T>,
  driver: string,
): T | null {
  const candidates = instances
    .filter((instance) => instance.enabled && instance.driver === driver)
    .toSorted((left, right) =>
      left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
    );
  const preferred = defaultInstanceIdForDriver(
    driver as Parameters<typeof defaultInstanceIdForDriver>[0],
  ) as string;
  return candidates.find((instance) => instance.instanceId === preferred) ?? candidates[0] ?? null;
}

/** The only remote a carried fork's branch comes from: the target fetches it from its own. */
export const CARRIED_FORK_REMOTE = "origin";

/**
 * The branch a carried fork starts from, from the source checkout's upstream (`origin/<branch>`);
 * null when the upstream is not on `origin` or the name is not a valid branch.
 */
export function carriedForkRemoteBranch(upstreamRef: string): string | null {
  const prefix = `${CARRIED_FORK_REMOTE}/`;
  if (!upstreamRef.startsWith(prefix)) return null;
  const branch = upstreamRef.slice(prefix.length);
  return isValidCarriedBranchName(branch) ? branch : null;
}

/**
 * Whether `name` is a branch name Git accepts (`git check-ref-format --branch`), and safe to put
 * in a fetch refspec: no `:`, wildcard, whitespace or control character, no `..`, `@{`, `//` or
 * `\`, no component that starts with `.` or ends with `.lock`, no leading `-` or `/`, no
 * trailing `/` or `.`, and not `@` or `HEAD`.
 */
export function isValidCarriedBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (name === "@" || name === "HEAD") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  // Control characters, space, DEL and Git's forbidden ref characters.
  // oxlint-disable-next-line no-control-regex -- the pattern rejects control characters.
  if (/[\u0000- \u007f~^:?*[\\]/u.test(name)) return false;
  return name
    .split("/")
    .every((component) => !component.startsWith(".") && !component.endsWith(".lock"));
}
