// Local mobile config/env loader. Replaces the repo-root
// `scripts/lib/{brand-assets,public-config}` imports the upstream scaffold
// relied on: those carried the upstream vendor's proprietary brand assets and
// the hosted-auth/managed-cloud/telemetry env namespaces, none of which belong
// in the Ryco public scaffold.
//
// Reads optional `.env` / `.env.local` from the monorepo root before an Effect
// runtime exists (build bootstrap), and exposes only the bounded set of
// public env the Ryco mobile app config needs.
//
// @effect-diagnostics nodeBuiltinImport:off - build bootstrap runs before Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export type AppVariant = "development" | "preview" | "production";

export function resolveMobileRepoRoot(moduleUrl: string): string {
  return NodePath.dirname(
    NodePath.dirname(NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(moduleUrl)))),
  );
}

const REPO_ROOT = resolveMobileRepoRoot(import.meta.url);
const MOBILE_PROJECT_ROOT = NodePath.join(REPO_ROOT, "apps", "mobile");

type Environment = Readonly<Record<string, string | undefined>>;

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}

/**
 * Merge the repo-root env files under the ambient process env. Later sources
 * win, matching the layered-env convention (process env overrides files).
 */
export function loadMobileEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  return { ...rootEnv, ...localEnv, ...baseEnv };
}

export function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const EAS_PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The `keyid` and algorithm `eas update --private-key-path` signs with (expo-updates code signing). */
export const MOBILE_UPDATE_CODE_SIGNING_METADATA = {
  keyid: "main",
  alg: "rsa-v1_5-sha256",
} as const;

export type MobileUpdates =
  | {
      readonly updates: {
        readonly enabled: true;
        readonly url: string;
        readonly checkAutomatically: "NEVER";
        readonly fallbackToCacheTimeout: 0;
        readonly codeSigningCertificate?: string;
        readonly codeSigningMetadata?: typeof MOBILE_UPDATE_CODE_SIGNING_METADATA;
      };
      readonly projectId: string;
      /** True only when the binary verifies every update against the configured certificate. */
      readonly signed: boolean;
    }
  | {
      readonly updates: { readonly enabled: false };
      readonly projectId: null;
      readonly signed: false;
    };

/**
 * Over-the-air updates come from the Ryco EAS project named by
 * `RYCO_EAS_PROJECT_ID`; without one they stay off and the app runs only the
 * JavaScript its binary shipped with.
 *
 * An update is code the app runs next to its E2EE keys, so the binary only ever
 * fetches one it can verify: `RYCO_EAS_UPDATE_CERTIFICATE` names the public
 * certificate (`certificatePath`; on EAS a secret file variable, locally a file
 * outside the repo) whose private key signs updates on the publisher's machine
 * (`eas update --private-key-path`). The key itself never enters the repo, CI or
 * EAS. Native checks are always `NEVER`: without a certificate nothing ever
 * checks, and with one the app decides when to check. The controller stays on
 * either way so expo-updates' error recovery keeps its startup-crash log, which
 * fetches nothing remotely when checks are `NEVER`.
 *
 * Signing needs the fingerprint `runtimeVersion` (`runtimePolicy`), which keeps
 * an update from reaching a binary whose native project differs; the build
 * profile's channel (eas.json) picks which branch a build follows.
 */
export function resolveMobileUpdates(input: {
  readonly projectId: string | undefined;
  readonly certificatePath?: string | undefined;
  readonly runtimePolicy: string;
  /** apps/mobile: expo-updates resolves `codeSigningCertificate` relative to it. */
  readonly projectRoot?: string;
  readonly readFile?: (path: string) => string;
}): MobileUpdates {
  const id = input.projectId?.trim();
  if (!id) return { updates: { enabled: false }, projectId: null, signed: false };
  if (!EAS_PROJECT_ID_PATTERN.test(id)) {
    throw new Error(
      `RYCO_EAS_PROJECT_ID must be an EAS project id (a UUID), not ${JSON.stringify(id)}.`,
    );
  }
  const base = {
    enabled: true,
    url: `https://u.expo.dev/${id}`,
    checkAutomatically: "NEVER",
    // Launch on the update already on the device; never wait for the network.
    fallbackToCacheTimeout: 0,
  } as const;
  const certificatePath = input.certificatePath?.trim();
  if (!certificatePath) return { updates: base, projectId: id, signed: false };
  if (input.runtimePolicy !== "fingerprint") {
    throw new Error(
      `Signed over-the-air updates need the fingerprint runtime version, not ${JSON.stringify(input.runtimePolicy)}.`,
    );
  }
  const projectRoot = input.projectRoot ?? MOBILE_PROJECT_ROOT;
  const absolutePath = NodePath.resolve(projectRoot, certificatePath);
  let pem: string;
  try {
    pem = (input.readFile ?? ((path) => NodeFS.readFileSync(path, "utf8")))(absolutePath);
  } catch {
    throw new Error(`RYCO_EAS_UPDATE_CERTIFICATE names no readable file: ${absolutePath}`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(pem)) {
    throw new Error(
      "RYCO_EAS_UPDATE_CERTIFICATE must be the public certificate, never the private key.",
    );
  }
  try {
    if (!/-----BEGIN CERTIFICATE-----/u.test(pem)) throw new Error("not a certificate");
    new NodeCrypto.X509Certificate(pem);
  } catch {
    throw new Error(
      `RYCO_EAS_UPDATE_CERTIFICATE must be a PEM certificate (BEGIN CERTIFICATE): ${absolutePath}`,
    );
  }
  return {
    updates: {
      ...base,
      // expo-updates joins this onto the project root, so an absolute path would not resolve.
      codeSigningCertificate: NodePath.relative(projectRoot, absolutePath),
      codeSigningMetadata: MOBILE_UPDATE_CODE_SIGNING_METADATA,
    },
    projectId: id,
    signed: true,
  };
}
