/**
 * The one OpenCode version policy of this build.
 *
 * Ryco speaks only OpenCode 1.x (`opencode-ai`). OpenCode 2.x ships as a separate package
 * (`@opencode/cli`, Homebrew `opencode-v2`) that installs the same `opencode` binary, converts
 * the shared OpenCode database in place and speaks a different server API. Every entry point —
 * the provider probe, the pre-spawn gate, the server health check, the MCP config manager and the
 * compatibility floor — classifies versions through this module so they agree on one message set.
 *
 * Pure: no SDK, process or filesystem imports, so any layer can depend on it.
 */
import { compareCliReleases, parseCliRelease } from "./cliVersion.ts";

export const MINIMUM_OPENCODE_VERSION = "1.14.19";

export type OpenCodeGeneration = "v1" | "v2";

export const OPENCODE_V2_ADVISORY_MESSAGE = "Ryco works with OpenCode 1.x; 2.x support is coming.";

export const OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE = `Unable to determine OpenCode version from \`opencode --version\` output. Ryco requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`;

/** Neutral on purpose: proxies and sign-in pages in front of a 1.x server also return HTML. */
export const OPENCODE_NON_JSON_HEALTH_MESSAGE =
  "The OpenCode server returned a web page instead of an OpenCode 1.x health response. Check the server URL and any proxy or sign-in page in front of it. If the server runs OpenCode 2.x: Ryco does not support 2.x yet.";

const MINIMUM_OPENCODE_RELEASE = parseCliRelease(MINIMUM_OPENCODE_VERSION)!;

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

/** True for any parseable major ≥ 2. Normalises itself, so "v2.0.0" and " 2.0.0-beta.1 " are true. */
export function isUnsupportedOpenCodeMajor(version: string): boolean {
  const release = parseCliRelease(version);
  return release !== null && release.major >= 2;
}

/**
 * null when this build can run `version`; otherwise the user-facing reason. Fails closed:
 * unparseable → reason, major ≥ 2 → reason, below MINIMUM → reason.
 *
 * The messages state facts only (2.x converts the shared database, so they promise nothing about
 * sessions) and avoid every keyword `formatOpenCodeProbeError` rewrites (auth, network, ENOENT,
 * quarantine, corruption), so they reach the user verbatim.
 */
export function describeUnsupportedOpenCodeVersion(
  version: string,
  source: "binary" | "server",
): string | null {
  const release = parseCliRelease(version);
  if (release === null) {
    return source === "server"
      ? `The OpenCode server reported an unrecognized version "${version.trim().slice(0, 40)}". Ryco requires OpenCode 1.x (v${MINIMUM_OPENCODE_VERSION} or newer).`
      : OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE;
  }
  const normalized = normalizeOpenCodeVersion(version);
  if (release.major >= 2) {
    return source === "server"
      ? `The OpenCode server reports v${normalized}. Ryco works with OpenCode 1.x servers; 2.x support is coming.`
      : `OpenCode v${normalized} is not supported yet. ${OPENCODE_V2_ADVISORY_MESSAGE} Point Binary path at an OpenCode 1.x install (npm \`opencode-ai\` or Homebrew \`anomalyco/tap/opencode\`).`;
  }
  if (compareCliReleases(release, MINIMUM_OPENCODE_RELEASE) < 0) {
    return `OpenCode v${normalized} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`;
  }
  return null;
}
