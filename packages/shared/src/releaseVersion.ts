/**
 * Ordering of Ryco release versions ("0.1.44", "v0.1.44", "0.1.45-nightly.20261109.3")
 * and the release-notes window an update covers. No data here: the notes
 * themselves (`./releaseNotes`) load only when something shows them.
 */

interface ParsedReleaseVersion {
  readonly core: readonly [number, number, number];
  /** Pre-release identifiers ("nightly", "20261109", "3"); empty for a release. */
  readonly prerelease: ReadonlyArray<string>;
}

const RELEASE_VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseReleaseVersion(version: string): ParsedReleaseVersion | null {
  const match = RELEASE_VERSION_PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareParsed(left: ParsedReleaseVersion, right: ParsedReleaseVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  // A pre-release sorts before its release (semver §11).
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const difference = comparePrereleaseIdentifier(
      left.prerelease[index]!,
      right.prerelease[index]!,
    );
    if (difference !== 0) return difference;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

/**
 * Semver order of two release versions: negative when `left` is older, 0 when
 * equal, positive when newer. Null when either is not a release version.
 */
export function compareReleaseVersions(left: string, right: string): number | null {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  return compareParsed(parsedLeft, parsedRight);
}

/**
 * The releases a person has not seen yet: newer than `sinceVersion` (every one
 * up to `currentVersion` when null) and no newer than `currentVersion`, in the
 * order given. Entries whose version does not parse are left out.
 */
export function selectReleasesBetween<T extends { readonly version: string }>(
  releases: ReadonlyArray<T>,
  range: { readonly sinceVersion: string | null; readonly currentVersion: string },
): T[] {
  const current = parseReleaseVersion(range.currentVersion);
  if (!current) return [];
  const since = range.sinceVersion === null ? null : parseReleaseVersion(range.sinceVersion);
  return releases.filter((release) => {
    const version = parseReleaseVersion(release.version);
    if (!version || compareParsed(version, current) > 0) return false;
    return since === null || compareParsed(version, since) > 0;
  });
}

/** What the app does about What's new when it starts. */
export type WhatsNewLaunchDecision =
  /** Nothing: a development build, an unparseable version, or nothing new. */
  | { readonly kind: "none" }
  /** Remember this version without showing anything (a fresh install, or the setting is off). */
  | { readonly kind: "record" }
  /** Show the notes newer than `sinceVersion`, then remember this version. */
  | { readonly kind: "show"; readonly sinceVersion: string };

export function resolveWhatsNewLaunch(input: {
  readonly currentVersion: string;
  readonly lastSeenVersion: string | undefined;
  readonly showAfterUpdate: boolean;
}): WhatsNewLaunchDecision {
  const current = parseReleaseVersion(input.currentVersion);
  if (!current || current.core.every((part) => part === 0)) return { kind: "none" };
  if (input.lastSeenVersion === undefined) return { kind: "record" };
  const lastSeen = parseReleaseVersion(input.lastSeenVersion);
  // A version this build cannot read is replaced by one it can.
  if (!lastSeen) return { kind: "record" };
  const order = compareParsed(current, lastSeen);
  if (order === 0) return { kind: "none" };
  // A downgrade (or a switch back from Nightly) moves the marker back quietly.
  if (order < 0 || !input.showAfterUpdate) return { kind: "record" };
  return { kind: "show", sinceVersion: input.lastSeenVersion };
}
