import type { AuthClientMetadata, AuthClientMetadataDeviceType } from "@ryco/contracts";
import { Duration } from "effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Crypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SESSION_COOKIE_NAME = "ryco_session";
const LEGACY_SESSION_COOKIE_NAME = "t3_session";

/**
 * How long a browser session of a dev server lasts when its home is not the shared ~/.ryco: a
 * worktree's own home, or one set with --home-dir/RYCO_HOME (otherwise 30 days).
 * Browsers send every `localhost` cookie to every port, so each paired worktree home adds one
 * cookie (about 300 bytes) to every local request; about 50 of them exceed Node's 16 KiB header
 * limit and every local server answers 431. A short life keeps that pile small, and each dev
 * server prints a fresh pairing link when it starts.
 */
export const DEV_HOME_SESSION_COOKIE_MAX_AGE = Duration.days(7);

/**
 * Which servers share one session cookie name. Cookies are scoped by host, not port, so every
 * server on `localhost` sees the others' cookies: a name must belong to one signing key (one
 * state directory), or pairing one server signs the browser out of another.
 */
export interface SessionCookieScope {
  readonly mode: "web" | "desktop";
  readonly port: number;
  /**
   * Set for a dev server (one with a dev URL): its state directory, which holds the key its
   * sessions are signed with, and whether that is the shared default home (~/.ryco).
   */
  readonly dev?: { readonly stateDir: string; readonly defaultHome: boolean } | undefined;
}

export function resolveSessionCookieScope(config: {
  readonly mode: "web" | "desktop";
  readonly port: number;
  readonly devUrl: URL | undefined;
  readonly baseDir: string;
  readonly stateDir: string;
}): SessionCookieScope {
  if (config.devUrl === undefined) {
    return { mode: config.mode, port: config.port };
  }
  return {
    mode: config.mode,
    port: config.port,
    dev: {
      stateDir: config.stateDir,
      defaultHome: NodePath.resolve(config.baseDir) === NodePath.join(NodeOS.homedir(), ".ryco"),
    },
  };
}

/**
 * Desktop names its cookie by port, as before. A web dev server names it after its state
 * directory (stable while its port shifts, and shared only by servers that share its signing
 * key), so dev servers of several worktrees stay signed in side by side. Plain web servers keep
 * `ryco_session`.
 */
export function resolveSessionCookieName(scope: SessionCookieScope): string {
  if (scope.mode === "desktop") {
    return `${SESSION_COOKIE_NAME}_${scope.port}`;
  }
  if (scope.dev !== undefined) {
    const key = Crypto.createHash("sha256").update(scope.dev.stateDir).digest("hex").slice(0, 8);
    return `${SESSION_COOKIE_NAME}_dev_${key}`;
  }
  return SESSION_COOKIE_NAME;
}

/**
 * Names still accepted when the current one is absent. The shared default dev home keeps the
 * cookie every dev server used before they were named per home, so nobody pairs it again.
 * Another dev home never accepts it: that cookie belongs to a different signing key.
 */
export function resolveLegacySessionCookieNames(scope: SessionCookieScope): readonly string[] {
  if (scope.mode === "desktop") {
    return [`${LEGACY_SESSION_COOKIE_NAME}_${scope.port}`];
  }
  if (scope.dev !== undefined) {
    return scope.dev.defaultHome ? [SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME] : [];
  }
  return [LEGACY_SESSION_COOKIE_NAME];
}

/** The longest a browser session cookie may live, or `undefined` for the usual session TTL. */
export function resolveSessionCookieMaxAge(
  scope: SessionCookieScope,
): Duration.Duration | undefined {
  return scope.mode === "web" && scope.dev !== undefined && !scope.dev.defaultHome
    ? DEV_HOME_SESSION_COOKIE_MAX_AGE
    : undefined;
}

export function base64UrlEncode(input: string | Uint8Array): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buffer.toString("base64url");
}

export function base64UrlDecodeUtf8(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return Crypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return Crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIpAddress(value: string | null | undefined): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function inferDeviceType(userAgent: string | undefined): AuthClientMetadataDeviceType {
  if (!userAgent) {
    return "unknown";
  }

  const normalized = userAgent.toLowerCase();
  if (/bot|crawler|spider|slurp|curl|wget/.test(normalized)) {
    return "bot";
  }
  if (/ipad|tablet/.test(normalized)) {
    return "tablet";
  }
  if (/iphone|android.+mobile|mobile/.test(normalized)) {
    return "mobile";
  }
  return "desktop";
}

function inferBrowser(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/edg\//.test(normalized)) return "Edge";
  if (/opr\//.test(normalized)) return "Opera";
  if (/firefox\//.test(normalized)) return "Firefox";
  if (/electron\//.test(normalized)) return "Electron";
  if (/chrome\//.test(normalized) || /crios\//.test(normalized)) return "Chrome";
  if (/safari\//.test(normalized) && !/chrome\//.test(normalized)) return "Safari";
  return undefined;
}

function inferOs(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(normalized)) return "iOS";
  if (/android/.test(normalized)) return "Android";
  if (/mac os x|macintosh/.test(normalized)) return "macOS";
  if (/windows nt/.test(normalized)) return "Windows";
  if (/linux/.test(normalized)) return "Linux";
  return undefined;
}

function readRemoteAddressFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: {
      readonly remoteAddress?: string | null;
    };
  };

  return normalizeIpAddress(candidate.socket?.remoteAddress ?? candidate.remoteAddress);
}

export function deriveAuthClientMetadata(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly label?: string;
}): AuthClientMetadata {
  const userAgent = normalizeNonEmptyString(input.request.headers["user-agent"]);
  const ipAddress = readRemoteAddressFromSource(input.request.source);
  const os = inferOs(userAgent);
  const browser = inferBrowser(userAgent);
  return {
    ...(input.label ? { label: input.label } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
    deviceType: inferDeviceType(userAgent),
    ...(os ? { os } : {}),
    ...(browser ? { browser } : {}),
  };
}
