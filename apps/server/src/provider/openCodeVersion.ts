/**
 * The one OpenCode version policy of this build.
 *
 * Ryco speaks OpenCode 1.x (`opencode-ai`). OpenCode 2.x ships as a separate package
 * (`@opencode/cli`, Homebrew `opencode-v2`) that installs the same `opencode` binary, converts
 * the shared OpenCode database in place and speaks a different server API; it stays refused until
 * `OPENCODE_V2_RUNTIME_SUPPORTED`. Every entry point — the provider probe, the pre-spawn gate, the
 * server API detection and health check, the MCP config manager and the compatibility floor —
 * classifies versions through this module so they agree on one message set.
 *
 * Pure: no SDK, process or filesystem imports, so any layer can depend on it.
 */
import { compareCliReleases, parseCliRelease } from "./cliVersion.ts";

export const MINIMUM_OPENCODE_VERSION = "1.14.19";
/** The oldest 2.x this build runs once 2.x is supported: the pinned 2.x client's version. */
export const MINIMUM_OPENCODE_V2_VERSION = "2.2.0";
/** Off until the 2.x client lands: every 2.x binary and server is refused. */
export const OPENCODE_V2_RUNTIME_SUPPORTED: boolean = false;

export type OpenCodeGeneration = "v1" | "v2";

export const OPENCODE_V2_ADVISORY_MESSAGE = "Ryco works with OpenCode 1.x; 2.x support is coming.";

export const OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE = `Unable to determine OpenCode version from \`opencode --version\` output. Ryco requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`;

/**
 * Neutral on purpose: proxies and sign-in pages in front of a 1.x server also return HTML. A 2.x
 * server identifies itself on `/api/info` before the health check (`openCodeProtocol.ts`).
 */
export const OPENCODE_NON_JSON_HEALTH_MESSAGE =
  "The OpenCode server returned a web page instead of a health response. Check the server URL and any proxy or sign-in page in front of it.";

/** Trim and strip one leading "v"/"V". */
export function normalizeOpenCodeVersion(raw: string): string {
  const trimmed = raw.trim();
  return /^[vV]/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

/** "v1" for major 1, "v2" for major 2, null otherwise (null input, unparseable, 0.x, ≥3). */
export function classifyOpenCodeGeneration(
  version: string | null | undefined,
): OpenCodeGeneration | null {
  if (version === null || version === undefined) {
    return null;
  }
  const release = parseCliRelease(version);
  if (release === null) {
    return null;
  }
  return release.major === 1 ? "v1" : release.major === 2 ? "v2" : null;
}

/**
 * The code-owned compatibility floor (`providerCompatibility.ts`): why no manifest may rate
 * `version` compatible, or undefined. Only majors ≥ 2 are floored; 1.x and unparseable versions
 * are left to the manifest. Normalises itself, so "v2.0.0" and " 2.0.0-beta.1 " are floored.
 */
export function openCodeVersionFloor(
  version: string,
  v2Supported = OPENCODE_V2_RUNTIME_SUPPORTED,
): string | undefined {
  const major = parseCliRelease(version)?.major ?? 0;
  if (major < 2) {
    return undefined;
  }
  return major === 2 && !v2Supported
    ? OPENCODE_V2_ADVISORY_MESSAGE
    : (describeUnsupportedOpenCodeVersion(version, "server", v2Supported) ?? undefined);
}

/**
 * null when this build can run `version`; otherwise the user-facing reason. Fails closed:
 * unparseable → reason, major ≥ 3 → reason, 2.x → reason unless `v2Supported` and at least
 * MINIMUM_OPENCODE_V2_VERSION, below MINIMUM (0.x included) → reason. `v2Supported` exists for
 * tests of both gate states.
 *
 * The messages state facts only (2.x converts the shared database, so they promise nothing about
 * sessions) and avoid every keyword `formatOpenCodeProbeError` rewrites (auth, network, ENOENT,
 * quarantine, corruption), so they reach the user verbatim.
 */
export function describeUnsupportedOpenCodeVersion(
  version: string,
  source: "binary" | "server",
  v2Supported = OPENCODE_V2_RUNTIME_SUPPORTED,
): string | null {
  const release = parseCliRelease(version);
  if (release === null) {
    return source === "server"
      ? `The OpenCode server reported an unrecognized version "${version.trim().slice(0, 40)}". Ryco requires OpenCode 1.x (v${MINIMUM_OPENCODE_VERSION} or newer).`
      : OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE;
  }
  const normalized = normalizeOpenCodeVersion(version);
  if (release.major >= 3) {
    return `OpenCode v${normalized} is not supported by this Ryco release.`;
  }
  const v2 = release.major === 2;
  if (v2 && !v2Supported) {
    return source === "server"
      ? `The OpenCode server reports v${normalized}. Ryco works with OpenCode 1.x servers; 2.x support is coming.`
      : `OpenCode v${normalized} is not supported yet. ${OPENCODE_V2_ADVISORY_MESSAGE} Point Binary path at an OpenCode 1.x install (npm \`opencode-ai\` or Homebrew \`anomalyco/tap/opencode\`).`;
  }
  const minimum = v2 ? MINIMUM_OPENCODE_V2_VERSION : MINIMUM_OPENCODE_VERSION;
  return compareCliReleases(release, parseCliRelease(minimum)!) < 0
    ? `OpenCode v${normalized} is too old. Upgrade ${v2 ? "OpenCode 2 " : ""}to v${minimum} or newer.`
    : null;
}
