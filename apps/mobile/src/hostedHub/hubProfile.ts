import type { KVService } from "@ryco/client-runtime/platform";

import type { HubCapabilityFailureReason } from "./hubCapability";

export const HUB_PROFILE_STORAGE_KEY = "ryco.hostedHub.profile.v1";
export const HUB_PROFILE_LABEL_MAX_LENGTH = 64;

const HOSTNAME_MAX_LENGTH = 253;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const PLACEHOLDER_HOSTS = new Set(["example.com", "example.net", "example.org", "hub.example.com"]);
const COMPATIBILITY_FAILURES = new Set<HubCapabilityFailureReason>([
  "capability-not-found",
  "invalid-document",
  "invalid-relying-party",
  "unreachable",
  "unsupported-handoff",
  "unsupported-protocol",
]);

export type HubOriginFailureReason =
  | "credentials-not-allowed"
  | "https-required"
  | "invalid-host"
  | "invalid-url"
  | "origin-only"
  | "placeholder-host"
  | "required";

export type HubOriginResult =
  | { readonly ok: true; readonly origin: string; readonly hostname: string }
  | { readonly ok: false; readonly reason: HubOriginFailureReason };

export type HubProfileCompatibility =
  | { readonly status: "unchecked"; readonly checkedAt: null }
  | {
      readonly status: "compatible";
      readonly checkedAt: number;
      readonly protocolVersion: number;
      readonly handoffVersion: number;
      readonly relyingPartyId: string;
    }
  | {
      readonly status: "incompatible";
      readonly checkedAt: number;
      readonly reason: HubCapabilityFailureReason;
    };

export interface HubProfile {
  readonly origin: string;
  readonly label: string;
  readonly compatibility: HubProfileCompatibility;
}

export interface HubDomainResetPlan {
  readonly fromOrigin: string | null;
  readonly toOrigin: string | null;
  readonly confirmation: {
    readonly title: string;
    readonly message: string;
    readonly confirmText: string;
  };
  readonly orderedSteps: readonly [
    "revoke-or-clear-session",
    "disconnect-relay-and-clear-hub-state",
    "replace-profile",
  ];
  readonly preserves: readonly ["direct-connections", "direct-credentials"];
}

export interface HubDomainResetActions {
  readonly attemptRemoteSignOut: () => Promise<void>;
  readonly clearLocalHubState: () => Promise<void>;
  readonly replaceProfile: () => Promise<void>;
}

export interface HubDomainResetResult {
  readonly remoteSignOut: "completed" | "unavailable";
}

let cachedProfile: HubProfile | null | undefined;
let profileHydration: Promise<HubProfile | null> | undefined;
let profileRevision = 0;

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > HOSTNAME_MAX_LENGTH) return false;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.includes(":");
  }
  return hostname.split(".").every((label) => DNS_LABEL_PATTERN.test(label));
}

function isPlaceholderHostname(hostname: string): boolean {
  return (
    PLACEHOLDER_HOSTS.has(hostname) ||
    hostname.endsWith(".invalid") ||
    hostname.includes("your-domain") ||
    hostname.includes("your-hub") ||
    hostname.includes("replace-me")
  );
}

export function normalizeHubOrigin(
  value: unknown,
  options: { readonly allowInsecure?: boolean } = {},
): HubOriginResult {
  const raw = trimmed(value);
  if (raw === null) return { ok: false, reason: "required" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials-not-allowed" };
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return { ok: false, reason: "origin-only" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "origin-only" };
  }
  if (url.protocol !== "https:" && !(options.allowInsecure && url.protocol === "http:")) {
    return { ok: false, reason: "https-required" };
  }

  const hostname = url.hostname.toLocaleLowerCase();
  if (!isValidHostname(hostname)) return { ok: false, reason: "invalid-host" };
  if (isPlaceholderHostname(hostname)) return { ok: false, reason: "placeholder-host" };
  return { ok: true, origin: url.origin, hostname };
}

export function normalizeHubLabel(value: unknown, fallbackHostname: string): string {
  const candidate = trimmed(value)?.replace(/\s+/g, " ") ?? fallbackHostname;
  return Array.from(candidate).slice(0, HUB_PROFILE_LABEL_MAX_LENGTH).join("");
}

export function createHubProfile(input: {
  readonly origin: string;
  readonly label?: string | null;
  readonly compatibility?: HubProfileCompatibility;
  readonly allowInsecure?: boolean;
}): HubProfile | null {
  const normalized = normalizeHubOrigin(input.origin, { allowInsecure: input.allowInsecure });
  if (!normalized.ok) return null;
  return {
    origin: normalized.origin,
    label: normalizeHubLabel(input.label, normalized.hostname),
    compatibility: input.compatibility ?? { status: "unchecked", checkedAt: null },
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decodeCompatibility(
  value: unknown,
  originHostname: string,
): HubProfileCompatibility | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "unchecked" && candidate.checkedAt === null) {
    return { status: "unchecked", checkedAt: null };
  }
  if (!isTimestamp(candidate.checkedAt)) return null;
  if (
    candidate.status === "incompatible" &&
    typeof candidate.reason === "string" &&
    COMPATIBILITY_FAILURES.has(candidate.reason as HubCapabilityFailureReason)
  ) {
    return {
      status: "incompatible",
      checkedAt: candidate.checkedAt,
      reason: candidate.reason as HubCapabilityFailureReason,
    };
  }
  if (
    candidate.status === "compatible" &&
    Number.isInteger(candidate.protocolVersion) &&
    (candidate.protocolVersion as number) >= 0 &&
    (candidate.protocolVersion as number) <= 65_535 &&
    Number.isInteger(candidate.handoffVersion) &&
    (candidate.handoffVersion as number) >= 0 &&
    (candidate.handoffVersion as number) <= 65_535 &&
    typeof candidate.relyingPartyId === "string" &&
    candidate.relyingPartyId.length > 0 &&
    candidate.relyingPartyId.length <= HOSTNAME_MAX_LENGTH &&
    isValidHostname(candidate.relyingPartyId) &&
    (originHostname === candidate.relyingPartyId ||
      originHostname.endsWith(`.${candidate.relyingPartyId}`))
  ) {
    return {
      status: "compatible",
      checkedAt: candidate.checkedAt,
      protocolVersion: candidate.protocolVersion as number,
      handoffVersion: candidate.handoffVersion as number,
      relyingPartyId: candidate.relyingPartyId,
    };
  }
  return null;
}

export function serializeHubProfile(profile: HubProfile): string {
  const normalized = normalizeHubOrigin(profile.origin, { allowInsecure: true });
  if (!normalized.ok) throw new Error("Invalid Hub profile.");
  const compatibility: HubProfileCompatibility =
    profile.compatibility.status === "compatible"
      ? {
          status: "compatible",
          checkedAt: profile.compatibility.checkedAt,
          protocolVersion: profile.compatibility.protocolVersion,
          handoffVersion: profile.compatibility.handoffVersion,
          relyingPartyId: profile.compatibility.relyingPartyId,
        }
      : profile.compatibility.status === "incompatible"
        ? {
            status: "incompatible",
            checkedAt: profile.compatibility.checkedAt,
            reason: profile.compatibility.reason,
          }
        : { status: "unchecked", checkedAt: null };
  const serialized = JSON.stringify({
    version: 1,
    origin: normalized.origin,
    label: normalizeHubLabel(profile.label, normalized.hostname),
    compatibility,
  });
  if (deserializeHubProfile(serialized) === null) throw new Error("Invalid Hub profile.");
  return serialized;
}

export function deserializeHubProfile(raw: string): HubProfile | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.origin !== "string") return null;
  const normalized = normalizeHubOrigin(candidate.origin, { allowInsecure: true });
  const compatibility = normalized.ok
    ? decodeCompatibility(candidate.compatibility, normalized.hostname)
    : null;
  if (!normalized.ok || compatibility === null) return null;
  return {
    origin: normalized.origin,
    label: normalizeHubLabel(candidate.label, normalized.hostname),
    compatibility,
  };
}

export function readCachedMobileHubProfile(): HubProfile | null | undefined {
  return cachedProfile;
}

const profileListeners = new Set<() => void>();

/** Sets the cached profile and tells listeners when it changed (hydrated, saved or cleared). */
function setCachedProfile(next: HubProfile | null): void {
  const changed = JSON.stringify(next) !== JSON.stringify(cachedProfile ?? null);
  cachedProfile = next;
  if (!changed) return;
  for (const listener of Array.from(profileListeners)) listener();
}

/** Calls `listener` whenever the cached profile changes, e.g. once it is read from storage. */
export function subscribeMobileHubProfile(listener: () => void): () => void {
  profileListeners.add(listener);
  return () => {
    profileListeners.delete(listener);
  };
}

export function hydrateMobileHubProfile(
  kv: Pick<KVService, "getItem">,
): Promise<HubProfile | null> {
  profileHydration ??= (async () => {
    const revision = profileRevision;
    let hydrated: HubProfile | null;
    try {
      const raw = await kv.getItem(HUB_PROFILE_STORAGE_KEY);
      hydrated = raw === null ? null : deserializeHubProfile(raw);
    } catch {
      hydrated = null;
    }
    if (profileRevision === revision) setCachedProfile(hydrated);
    return cachedProfile ?? null;
  })();
  return profileHydration;
}

export async function saveMobileHubProfile(
  kv: Pick<KVService, "setItem">,
  profile: HubProfile,
): Promise<void> {
  const serialized = serializeHubProfile(profile);
  await kv.setItem(HUB_PROFILE_STORAGE_KEY, serialized);
  profileRevision += 1;
  const saved = deserializeHubProfile(serialized);
  setCachedProfile(saved);
  profileHydration = Promise.resolve(saved);
}

export async function clearMobileHubProfile(kv: Pick<KVService, "removeItem">): Promise<void> {
  await kv.removeItem(HUB_PROFILE_STORAGE_KEY);
  profileRevision += 1;
  setCachedProfile(null);
  profileHydration = Promise.resolve(null);
}

export function buildHubDomainResetPlan(
  fromOrigin: string | null,
  toOrigin: string | null,
): HubDomainResetPlan | null {
  if (fromOrigin === null || fromOrigin === toOrigin) return null;
  return {
    fromOrigin,
    toOrigin,
    confirmation: {
      title: "Change Hub domain?",
      message:
        "Ryco will sign out of the current Hub, disconnect its relay, and clear Hub-only account and node state. Directly paired machines stay saved.",
      confirmText: "Change Hub",
    },
    orderedSteps: [
      "revoke-or-clear-session",
      "disconnect-relay-and-clear-hub-state",
      "replace-profile",
    ],
    preserves: ["direct-connections", "direct-credentials"],
  };
}

export async function executeHubDomainResetPlan(
  _plan: HubDomainResetPlan,
  actions: HubDomainResetActions,
): Promise<HubDomainResetResult> {
  let remoteSignOut: HubDomainResetResult["remoteSignOut"] = "completed";
  try {
    await actions.attemptRemoteSignOut();
  } catch {
    remoteSignOut = "unavailable";
  }
  await actions.clearLocalHubState();
  await actions.replaceProfile();
  return { remoteSignOut };
}

export function resetMobileHubProfileCacheForTests(): void {
  cachedProfile = undefined;
  profileHydration = undefined;
  profileRevision = 0;
}
