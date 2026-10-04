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

type CliVersionRangeOperator = ">=" | ">" | "<=" | "<" | "=";

interface CliVersionComparator {
  readonly operator: CliVersionRangeOperator;
  readonly release: CliRelease;
}

const CLI_VERSION_COMPARATOR_PATTERN = /^(>=|>|<=|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function parseCliVersionComparator(token: string): CliVersionComparator | null {
  const match = CLI_VERSION_COMPARATOR_PATTERN.exec(token);
  if (!match) {
    return null;
  }
  const [major, minor, patch] = [match[2], match[3], match[4]].map((segment) =>
    segment === undefined ? 0 : Number.parseInt(segment, 10),
  ) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }
  return {
    operator: (match[1] as CliVersionRangeOperator | undefined) ?? "=",
    release: { major, minor, patch },
  };
}

function parseCliVersionRange(
  range: string,
): ReadonlyArray<ReadonlyArray<CliVersionComparator>> | null {
  const groups: Array<ReadonlyArray<CliVersionComparator>> = [];
  for (const group of range.split("||")) {
    const trimmed = group.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const comparators: Array<CliVersionComparator> = [];
    for (const token of trimmed.split(/\s+/)) {
      const comparator = parseCliVersionComparator(token);
      if (comparator === null) {
        return null;
      }
      comparators.push(comparator);
    }
    groups.push(comparators);
  }
  return groups;
}

function satisfiesCliVersionComparator(
  release: CliRelease,
  comparator: CliVersionComparator,
): boolean {
  const comparison = compareCliReleases(release, comparator.release);
  switch (comparator.operator) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "=":
      return comparison === 0;
  }
}

/**
 * Comparator groups joined by "||"; whitespace-separated comparators inside a group are ANDed.
 * Comparator: /^(>=|>|<=|<|=)?v?\d+(\.\d+){0,2}$/ — no caret/tilde/x-ranges; missing segments
 * are 0; no operator means "=". Empty groups are invalid.
 */
export function isCliVersionRange(range: string): boolean {
  return parseCliVersionRange(range) !== null;
}

/**
 * Matches on the release triple only (parseCliRelease): "2.0.0-beta.1" satisfies ">=2.0.0",
 * "0.1.31-nightly.20260413.321" satisfies ">=0.1.30". false for an unparseable version or
 * invalid range.
 */
export function satisfiesCliVersionRange(version: string, range: string): boolean {
  const release = parseCliRelease(version);
  const groups = parseCliVersionRange(range);
  if (release === null || groups === null) {
    return false;
  }
  return groups.some((group) =>
    group.every((comparator) => satisfiesCliVersionComparator(release, comparator)),
  );
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
