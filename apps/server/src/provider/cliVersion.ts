export interface CliRelease {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const CLI_RELEASE_PATTERN = /^[vV]?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/;

/**
 * major.minor.patch of a CLI version. Ignores surrounding whitespace, one leading "v"/"V",
 * any "-prerelease"/"+build" suffix, and a missing patch ("2.1" → 2.1.0). Leading zeros are
 * numeric ("2026.04.09-f2b0fcd" → 2026.4.9). Returns null for anything else.
 */
export function parseCliRelease(version: string): CliRelease | null {
  const match = CLI_RELEASE_PATTERN.exec(version.trim());
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }
  return { major, minor, patch };
}

export function compareCliReleases(left: CliRelease, right: CliRelease): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

interface ParsedCliSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

const CLI_VERSION_NUMBER_SEGMENT = /^\d+$/;

export function normalizeCliVersion(version: string): string {
  const [main, prerelease] = version.trim().split("-", 2);
  const segments = (main ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) {
    segments.push("0");
  }

  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".");
}

function parseCliSemver(version: string): ParsedCliSemver | null {
  const normalized = normalizeCliVersion(version);
  const [main = "", prerelease] = normalized.split("-", 2);
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }
  if (
    !CLI_VERSION_NUMBER_SEGMENT.test(majorSegment) ||
    !CLI_VERSION_NUMBER_SEGMENT.test(minorSegment) ||
    !CLI_VERSION_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  const major = Number.parseInt(majorSegment, 10);
  const minor = Number.parseInt(minorSegment, 10);
  const patch = Number.parseInt(patchSegment, 10);
  if (![major, minor, patch].every(Number.isInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease:
      prerelease
        ?.split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

/** True when `version` parses as a CLI semver (`major.minor[.patch][-pre]`). */
export function isParseableCliVersion(version: string): boolean {
  return parseCliSemver(version) !== null;
}

export function compareCliVersions(left: string, right: string): number {
  const parsedLeft = parseCliSemver(left);
  const parsedRight = parseCliSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}
