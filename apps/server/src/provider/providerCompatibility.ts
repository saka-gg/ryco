/**
 * Provider compatibility policy: rates a provider version against this Ryco release.
 *
 * Three layers, in order:
 * 1. Code-owned floors (`HARD_COMPATIBILITY_FLOORS`): limits of THIS build that no manifest can
 *    lift — today, OpenCode major ≥ 2.
 * 2. The current model manifest's `compatibility[]` (remote from GitHub main, then disk cache).
 * 3. The bundled manifest's `compatibility[]`, when the current manifest has no policy for the
 *    driver and this Ryco version.
 *
 * Ratings of a provider's installed version are informational; `unsupported`/`broken` ratings of
 * its latest version stop Ryco from offering or installing that version (a remote kill switch for
 * a bad provider release). Pure: the registry and the update runner own when to apply it.
 *
 * Ported from pingdotgg/t3code `providerCompatibility.ts`, slimmed down (no recommended versions)
 * and with prereleases rated by their release triple.
 */
import {
  ServerProviderCompatibilityStatus,
  TrimmedNonEmptyString,
  type ProviderDriverKind,
  type ServerProvider,
} from "@ryco/contracts";
import { Option, Schema } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { isCliVersionRange, satisfiesCliVersionRange } from "./cliVersion.ts";
import { BUNDLED_MODEL_MANIFEST, type ModelManifestData } from "./ModelManifest.ts";
import { isUnsupportedOpenCodeMajor, OPENCODE_V2_ADVISORY_MESSAGE } from "./openCodeVersion.ts";

export interface ProviderVersionRating {
  readonly status: ServerProviderCompatibilityStatus;
  readonly message: string | null;
}

const CliVersionRangeString = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.makeFilter(isCliVersionRange, { expected: "a CLI version range" }),
);

export const ProviderCompatibilityPolicy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  rycoRange: CliVersionRangeString,
  ranges: Schema.Array(
    Schema.Struct({
      range: CliVersionRangeString,
      status: ServerProviderCompatibilityStatus,
      message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
    }),
  ),
});
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

const decodePolicy = Schema.decodeUnknownOption(ProviderCompatibilityPolicy);

const DEFAULT_STATUS_MESSAGES: Readonly<Record<ServerProviderCompatibilityStatus, string | null>> =
  {
    unknown: null,
    supported: null,
    graceful: "This version works with limited compatibility in this Ryco release.",
    unsupported: "This version is outside the range this Ryco release supports.",
    broken: "This version is known to break this Ryco release.",
  };

/**
 * Code-owned limits of THIS build, consulted before any manifest policy for both the installed
 * and the latest version. A remote manifest can never rate these as compatible.
 */
const HARD_COMPATIBILITY_FLOORS: ReadonlyMap<
  string,
  (version: string) => ProviderVersionRating | undefined
> = new Map([
  [
    "opencode",
    (version: string): ProviderVersionRating | undefined =>
      isUnsupportedOpenCodeMajor(version)
        ? { status: "unsupported", message: OPENCODE_V2_ADVISORY_MESSAGE }
        : undefined,
  ],
]);

const policiesByManifest = new WeakMap<
  ModelManifestData,
  ReadonlyArray<ProviderCompatibilityPolicy>
>();

/**
 * Lenient: a non-array `compatibility` yields []; each entry decodes on its own and invalid
 * entries are dropped whole. Memoized per manifest object — the registry calls this on every
 * upsert.
 */
export function compatibilityPoliciesOf(
  manifest: ModelManifestData,
): ReadonlyArray<ProviderCompatibilityPolicy> {
  const cached = policiesByManifest.get(manifest);
  if (cached !== undefined) {
    return cached;
  }
  const raw = manifest.compatibility;
  const policies = Array.isArray(raw)
    ? raw.flatMap((entry) => Option.toArray(decodePolicy(entry)))
    : [];
  policiesByManifest.set(manifest, policies);
  return policies;
}

/**
 * First policy in the current manifest with a matching driver whose rycoRange contains
 * rycoVersion; else the first such BUNDLED policy (skipped when manifest === bundle); else
 * undefined.
 */
export function selectCompatibilityPolicy(input: {
  readonly manifest: ModelManifestData;
  readonly driver: ProviderDriverKind;
  readonly rycoVersion?: string;
}): ProviderCompatibilityPolicy | undefined {
  const rycoVersion = input.rycoVersion ?? packageJson.version;
  const applies = (policy: ProviderCompatibilityPolicy) =>
    policy.driver === input.driver && satisfiesCliVersionRange(rycoVersion, policy.rycoRange);
  const current = compatibilityPoliciesOf(input.manifest).find(applies);
  if (current !== undefined || input.manifest === BUNDLED_MODEL_MANIFEST) {
    return current;
  }
  return compatibilityPoliciesOf(BUNDLED_MODEL_MANIFEST).find(applies);
}

/** First matching range wins; unparseable version or no match → { status: "unknown", message: null }. */
export function ratePolicy(
  policy: ProviderCompatibilityPolicy,
  version: string,
): ProviderVersionRating {
  const entry = policy.ranges.find((candidate) =>
    satisfiesCliVersionRange(version, candidate.range),
  );
  if (entry === undefined) {
    return { status: "unknown", message: null };
  }
  return { status: entry.status, message: entry.message ?? DEFAULT_STATUS_MESSAGES[entry.status] };
}

/** Floor first, then policy. undefined when neither applies to the driver. */
export function rateProviderVersion(input: {
  readonly manifest: ModelManifestData;
  readonly driver: ProviderDriverKind;
  readonly version: string;
  readonly rycoVersion?: string;
}): ProviderVersionRating | undefined {
  const floor = HARD_COMPATIBILITY_FLOORS.get(input.driver)?.(input.version);
  if (floor !== undefined) {
    return floor;
  }
  const policy = selectCompatibilityPolicy(input);
  return policy === undefined ? undefined : ratePolicy(policy, input.version);
}

/**
 * Strips any previous advisory. Skips (returns stripped) disabled, not-installed, or version-less
 * snapshots. Rates `snapshot.version` and, when present, `snapshot.versionAdvisory.latestVersion`.
 * Attaches an advisory when either rating exists; a missing installed rating becomes "unknown".
 */
export function applyProviderCompatibility(
  snapshot: ServerProvider,
  manifest: ModelManifestData,
  rycoVersion?: string,
): ServerProvider {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed || snapshot.version === null) {
    return base;
  }
  const rate = (version: string) =>
    rateProviderVersion({
      manifest,
      driver: snapshot.driver,
      version,
      ...(rycoVersion !== undefined ? { rycoVersion } : {}),
    });
  const installed = rate(snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion ?? null;
  const latest = latestVersion === null ? undefined : rate(latestVersion);
  if (installed === undefined && latest === undefined) {
    return base;
  }
  return {
    ...base,
    compatibilityAdvisory: {
      status: installed?.status ?? "unknown",
      ...(latest !== undefined ? { latestVersionStatus: latest.status } : {}),
      message: installed?.message ?? null,
    },
  };
}
