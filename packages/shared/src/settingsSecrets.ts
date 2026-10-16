import { hubKeyAddress } from "./cliProxyHubUrl.ts";

/**
 * Secret-bearing `ServerSettings` values and their client-visible form.
 *
 * Clients never receive these values. The server sends a redacted copy:
 *   - secret fields hold `REDACTED_SETTING_SECRET` when a value is set and
 *     `""` when not, so clients can show that a value is configured;
 *   - URL fields keep their address but replace embedded credentials (user
 *     name, password, query values, fragment) with the same marker.
 *
 * On update the redacted form means "unchanged": a value equal to the
 * redacted form of the stored value keeps the stored value. Old clients that
 * echo the copy they received back therefore never overwrite a secret. A new
 * value replaces it and `""` (or omitting a provider config key) clears it.
 * A saved provider secret is bound to its config's server address, like a
 * CLIProxyAPI hub key: it is never kept for a different address.
 * Sensitive provider environment variables and CLIProxyAPI hub keys use their
 * own secret-store contract (`valueRedacted`, `managementKeyRedacted`).
 *
 * @module settingsSecrets
 */

/** Stands in for a secret value in every settings copy a client receives. */
export const REDACTED_SETTING_SECRET = "__ryco_redacted__";

/** Provider config keys (`providers.<driver>` and `providerInstances.*.config`) holding a secret. */
export const PROVIDER_SECRET_CONFIG_KEYS: ReadonlyArray<string> = ["serverPassword"];

/** Provider config keys holding a URL whose embedded credentials are secret. */
export const PROVIDER_URL_CONFIG_KEYS: ReadonlyArray<string> = ["serverUrl", "apiEndpoint"];

const HIERARCHICAL_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/** The client-visible form of a secret value. */
export function redactSettingSecret(value: string): string {
  return value.length > 0 ? REDACTED_SETTING_SECRET : value;
}

/**
 * `raw` with its user name, password, query values and fragment replaced by
 * the marker. A URL without any of them is returned unchanged. A value that
 * is not a hierarchical URL (it does not parse, or parses as an opaque one
 * such as `host:secret@127.0.0.1`) is returned unchanged unless it could
 * still carry credentials (`@`, `?` or `#`), in which case all of it is hidden.
 */
export function redactUrlCredentials(raw: string): string {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url === undefined || !HIERARCHICAL_URL_PROTOCOLS.has(url.protocol)) {
    return /[@?#]/.test(raw) ? REDACTED_SETTING_SECRET : raw;
  }
  let changed = false;
  if (url.username) {
    url.username = REDACTED_SETTING_SECRET;
    changed = true;
  }
  if (url.password) {
    url.password = REDACTED_SETTING_SECRET;
    changed = true;
  }
  if (url.search.length > 1) {
    const params = new URLSearchParams(url.search);
    const redacted = new URLSearchParams();
    let hasValue = false;
    for (const [key, value] of params) {
      hasValue ||= value.length > 0;
      redacted.append(key, value.length > 0 ? REDACTED_SETTING_SECRET : value);
    }
    if (hasValue) {
      url.search = redacted.toString();
      changed = true;
    }
  }
  if (url.hash.length > 1) {
    url.hash = REDACTED_SETTING_SECRET;
    changed = true;
  }
  return changed ? url.toString() : raw;
}

/**
 * The address a saved provider secret is bound to: scheme, host and port of
 * the config's server URL (loopback hosts interchangeable), `""` for none.
 */
export function settingSecretAddress(url: unknown): string {
  if (typeof url !== "string" || url.trim().length === 0) return "";
  return hubKeyAddress(url) ?? url.trim();
}

/** Whether a value a client sent still holds a redaction marker. */
export function containsRedactedSettingSecret(value: string): boolean {
  return value.includes(REDACTED_SETTING_SECRET);
}

/**
 * The value to store for `incoming`, given the stored values it may stand for
 * (most specific first). An incoming value equal to the redacted form of a
 * stored value keeps that stored value. Returns `undefined` when `incoming`
 * still holds a marker no stored value accounts for: the client edited a
 * redacted value, or no value is saved, and the secret must be entered again.
 */
export function resolveRedactedSettingValue(
  incoming: string,
  stored: ReadonlyArray<unknown>,
  redact: (value: string) => string,
): string | undefined {
  for (const candidate of stored) {
    if (typeof candidate !== "string") continue;
    // A value the patch did not touch is kept as stored, whatever it holds.
    if (candidate === incoming || redact(candidate) === incoming) return candidate;
  }
  return containsRedactedSettingSecret(incoming) ? undefined : incoming;
}
