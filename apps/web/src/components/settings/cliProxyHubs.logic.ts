import {
  CLI_PROXY_HUB_ID_MAX_CHARS,
  CLI_PROXY_HUB_LABEL_MAX_CHARS,
  CliProxyHubId,
  type CliProxyHubConfig,
} from "@ryco/contracts";
import { hubKeyAddress } from "@ryco/shared/cliProxyHubUrl";
import { validateCloudflareAccessCredentials } from "@ryco/shared/cliProxyHubCredentials";

export interface CliProxyHubDraft {
  readonly url: string;
  readonly label: string;
  /** Empty keeps the saved key when one exists. */
  readonly managementKey: string;
  readonly cloudflareAccessClientId?: string;
  /** Empty keeps the saved secret when the address and Client ID are unchanged. */
  readonly cloudflareAccessClientSecret?: string;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function validateCliProxyHubDraft(
  draft: CliProxyHubDraft,
  options: {
    readonly hasSavedKey: boolean;
    readonly hasSavedCloudflareSecret?: boolean | undefined;
  },
): string | null {
  const url = parseHttpUrl(draft.url);
  if (!url) return "Enter the hub URL, for example http://127.0.0.1:8317.";
  // The node refuses such a URL, and settings are visible to every session of the node.
  if (url.username || url.password) {
    return "Remove the user name and password from the hub URL. The management key authenticates Ryco.";
  }
  if (draft.label.trim().length > CLI_PROXY_HUB_LABEL_MAX_CHARS) {
    return `Keep the label under ${CLI_PROXY_HUB_LABEL_MAX_CHARS} characters.`;
  }
  if (draft.managementKey.trim().length === 0 && !options.hasSavedKey) {
    return "Enter the hub's management key.";
  }
  return validateCloudflareAccessCredentials({
    clientId: draft.cloudflareAccessClientId,
    clientSecret: draft.cloudflareAccessClientSecret,
    hasSavedSecret: options.hasSavedCloudflareSecret,
  });
}

/** A stable id derived from the hub host, unique among `existing`. */
export function makeCliProxyHubId(url: string, existing: Iterable<string>): CliProxyHubId {
  const taken = new Set(existing);
  let host = "hub";
  try {
    host = new URL(url.trim()).host || host;
  } catch {
    // Validation rejects the URL before saving; any id works until then.
  }
  const slug =
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "hub";
  const base = `cliproxy-${slug}`.slice(0, CLI_PROXY_HUB_ID_MAX_CHARS - 4);
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return CliProxyHubId.make(candidate);
}

/** Whether the hub's saved key can be kept: it only ever goes to the address it was entered for. */
export function savedKeyApplies(url: string, existing: CliProxyHubConfig | undefined): boolean {
  if (existing?.managementKeyRedacted !== true) return false;
  const address = hubKeyAddress(url);
  return address !== null && address === hubKeyAddress(existing.url);
}

export function savedCloudflareSecretApplies(
  draft: CliProxyHubDraft,
  existing: CliProxyHubConfig | undefined,
): boolean {
  if (existing?.cloudflareAccessClientSecretRedacted !== true) return false;
  const clientId = draft.cloudflareAccessClientId?.trim();
  const address = hubKeyAddress(draft.url);
  return Boolean(
    clientId &&
    clientId === existing.cloudflareAccessClientId?.trim() &&
    address !== null &&
    address === hubKeyAddress(existing.url),
  );
}

/**
 * The settings entry for a saved draft. An empty key field on a hub whose saved key still
 * applies sends the redacted marker so the server keeps the stored key.
 */
export function buildCliProxyHubEntry(
  draft: CliProxyHubDraft,
  existing: CliProxyHubConfig | undefined,
): CliProxyHubConfig {
  const label = draft.label.trim();
  const managementKey = draft.managementKey.trim();
  const keepSavedKey = managementKey.length === 0 && savedKeyApplies(draft.url, existing);
  const cloudflareAccessClientSecret = draft.cloudflareAccessClientSecret?.trim() ?? "";
  const cloudflareFields =
    draft.cloudflareAccessClientId !== undefined || draft.cloudflareAccessClientSecret !== undefined
      ? {
          cloudflareAccessClientId: draft.cloudflareAccessClientId?.trim() ?? "",
          cloudflareAccessClientSecret,
          ...(cloudflareAccessClientSecret.length === 0 &&
          savedCloudflareSecretApplies(draft, existing)
            ? { cloudflareAccessClientSecretRedacted: true }
            : {}),
        }
      : {};
  return {
    url: draft.url.trim(),
    ...(label.length > 0 ? { label } : {}),
    managementKey: keepSavedKey ? "" : managementKey,
    ...(keepSavedKey ? { managementKeyRedacted: true } : {}),
    ...cloudflareFields,
    enabled: existing?.enabled ?? true,
  };
}
