/**
 * Copying Ryco's data into Ryco Nightly (port of Synara's stable-to-beta import, BETA.md).
 *
 * Ryco writes a request into Ryco Nightly's data home and opens Ryco Nightly. Before Nightly's
 * server opens its database, it copies Ryco's database (without anything that lets it act as
 * Ryco's node) and a few user files, removes the request and reports the outcome in a result
 * file beside it. Both files live in Nightly's home: nothing is ever written into Ryco's.
 *
 * The request names a source but grants none. Nightly copies only from the one home its app
 * allows (`flavorImportAllowedSourceHome`): the home Ryco handed over at launch, else `~/.ryco`.
 *
 * Schema-free: the desktop app writes the request and reads the result, the server consumes the
 * request and writes the result (apps/server/src/flavorImport/consumeFlavorImport.ts).
 */
import * as Path from "node:path";

import { rycoDesktopFlavorIdentity } from "./desktopFlavor.ts";

/** In Ryco Nightly's data home: Ryco asks for a copy. */
export const FLAVOR_IMPORT_REQUEST_FILE_NAME = "import-requested.json";
/** In Ryco Nightly's data home: how the last copy went. */
export const FLAVOR_IMPORT_RESULT_FILE_NAME = "import-result.json";
/**
 * A request older than this is dropped without copying: a request an aborted hand-off left
 * behind must never replace data Ryco Nightly gathered since.
 */
export const FLAVOR_IMPORT_REQUEST_MAX_AGE_MS = 60 * 60_000;
/** Set by Ryco when it opens Ryco Nightly: the data home to copy from, when not `~/.ryco`. */
export const RYCO_STABLE_HOME_ENV = "RYCO_STABLE_HOME";
/**
 * Set by Ryco when it opens Ryco Nightly to take a copy: a one-time value also written into the
 * request. Nightly's server takes only the request of the launch that carried it, so a request
 * written while Nightly was already open (and so never received its launch) is never taken later.
 */
export const RYCO_FLAVOR_IMPORT_TOKEN_ENV = "RYCO_FLAVOR_IMPORT_TOKEN";
/** A launch token: URL-safe, 22 to 128 characters. */
export const FLAVOR_IMPORT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;

export interface FlavorImportRequest {
  readonly version: 1;
  readonly requestedAt: string;
  /** Absolute path of Ryco's data home. */
  readonly sourceHomeDir: string;
  /** The launch this request belongs to (`RYCO_FLAVOR_IMPORT_TOKEN_ENV`). */
  readonly token: string;
}

export interface FlavorImportResult {
  readonly version: 1;
  readonly completedAt: string;
  readonly ok: boolean;
  /** Why the copy did not happen, in words for the person who asked for it. */
  readonly error?: string;
}

export const flavorImportRequestPath = (nightlyHome: string): string =>
  Path.join(nightlyHome, FLAVOR_IMPORT_REQUEST_FILE_NAME);

export const flavorImportResultPath = (nightlyHome: string): string =>
  Path.join(nightlyHome, FLAVOR_IMPORT_RESULT_FILE_NAME);

/** The request file's contents, as Ryco writes it (atomically) into Ryco Nightly's home. */
export function formatFlavorImportRequest(input: {
  readonly sourceHomeDir: string;
  readonly requestedAt: Date;
  readonly token: string;
}): string {
  const request: FlavorImportRequest = {
    version: 1,
    requestedAt: input.requestedAt.toISOString(),
    sourceHomeDir: Path.resolve(input.sourceHomeDir),
    token: input.token,
  };
  return `${JSON.stringify(request)}\n`;
}

/** A result file's contents; null when it is not one. */
export function parseFlavorImportResult(text: string): FlavorImportResult | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.completedAt !== "string" ||
    typeof record.ok !== "boolean" ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    return null;
  }
  return {
    version: 1,
    completedAt: record.completedAt,
    ok: record.ok,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

/**
 * The only data home Ryco Nightly may copy from: the absolute `RYCO_STABLE_HOME` Ryco handed
 * over when it opened Nightly, else Ryco's default home. Null when that is Nightly's own home.
 */
/**
 * Ryco Nightly's desktop app, once at start: the copy-request token its launch carried, removed
 * from `env` so nothing it starts inherits it. Null when the launch carried none (or a malformed
 * one): then no request is taken this run.
 */
export function takeFlavorImportLaunchToken(
  env: Record<string, string | undefined>,
): string | null {
  const token = env[RYCO_FLAVOR_IMPORT_TOKEN_ENV];
  delete env[RYCO_FLAVOR_IMPORT_TOKEN_ENV];
  return token !== undefined && FLAVOR_IMPORT_TOKEN_PATTERN.test(token) ? token : null;
}

export function flavorImportAllowedSourceHome(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly nightlyHome: string;
}): string | null {
  const handedOver = input.env[RYCO_STABLE_HOME_ENV]?.trim();
  const source =
    handedOver !== undefined && handedOver !== "" && Path.isAbsolute(handedOver)
      ? Path.resolve(handedOver)
      : Path.resolve(input.homeDir, rycoDesktopFlavorIdentity("stable").homeDirectoryName);
  return source === Path.resolve(input.nightlyHome) ? null : source;
}
