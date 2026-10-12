import type { HttpClientService } from "@ryco/client-runtime/platform";
import {
  NATIVE_HANDOFF_CAPABILITY_PATH,
  NATIVE_HANDOFF_MAX_CAPABILITY_BYTES,
  NATIVE_HANDOFF_MODE,
  NATIVE_HANDOFF_PROTOCOL_VERSION,
  NATIVE_HANDOFF_VERSION,
  NativeHandoffCapability,
} from "@ryco/contracts/native-handoff";
import * as Schema from "effect/Schema";

export const HUB_CAPABILITY_PATH = NATIVE_HANDOFF_CAPABILITY_PATH;
export const SUPPORTED_HUB_PROTOCOL_VERSION = NATIVE_HANDOFF_PROTOCOL_VERSION;
export const SUPPORTED_HUB_HANDOFF_VERSION = NATIVE_HANDOFF_VERSION;
export const HUB_CAPABILITY_CHECK_TIMEOUT_MS = 10_000;

const MAX_CAPABILITY_BODY_LENGTH = NATIVE_HANDOFF_MAX_CAPABILITY_BYTES;

export type HubCapabilityFailureReason =
  | "capability-not-found"
  | "invalid-document"
  | "invalid-relying-party"
  | "unreachable"
  | "unsupported-handoff"
  | "unsupported-protocol";

export interface HubCapability {
  readonly protocolVersion: number;
  readonly nativeHandoff: {
    readonly mode: string;
    readonly version: number;
  };
  readonly relyingParty: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly nativeIdentity?: typeof NativeHandoffCapability.Type.nativeIdentity;
}

export type HubCapabilityCheck =
  | {
      readonly status: "compatible";
      readonly checkedAt: number;
      readonly capability: HubCapability;
    }
  | {
      readonly status: "incompatible";
      readonly checkedAt: number;
      readonly reason: HubCapabilityFailureReason;
    };

export interface HubCapabilityClient {
  readonly check: (origin: string, signal?: AbortSignal) => Promise<HubCapabilityCheck>;
}

type CapabilityDecodeResult =
  | { readonly ok: true; readonly capability: HubCapability }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-document"
        | "invalid-relying-party"
        | "unsupported-handoff"
        | "unsupported-protocol";
    };

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function relyingPartyMatchesOrigin(relyingPartyId: string, origin: string): boolean {
  const hostname = new URL(origin).hostname.toLocaleLowerCase();
  const candidate = relyingPartyId.toLocaleLowerCase();
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

export function decodeHubCapability(value: unknown, origin: string): CapabilityDecodeResult {
  const document = objectValue(value);
  const nativeHandoff = objectValue(document?.nativeHandoff);
  if (document?.service !== "ryco-hub" || !Number.isInteger(document.protocolVersion)) {
    return { ok: false, reason: "invalid-document" };
  }
  if (document.protocolVersion !== SUPPORTED_HUB_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported-protocol" };
  }
  if (
    !nativeHandoff ||
    typeof nativeHandoff.mode !== "string" ||
    !Number.isInteger(nativeHandoff.version)
  ) {
    return { ok: false, reason: "invalid-document" };
  }
  if (
    nativeHandoff.mode !== NATIVE_HANDOFF_MODE ||
    nativeHandoff.version !== SUPPORTED_HUB_HANDOFF_VERSION
  ) {
    return { ok: false, reason: "unsupported-handoff" };
  }

  let capability: typeof NativeHandoffCapability.Type;
  try {
    capability = Schema.decodeUnknownSync(NativeHandoffCapability)(value, {
      onExcessProperty: "error",
    });
  } catch {
    return { ok: false, reason: "invalid-document" };
  }
  if (!relyingPartyMatchesOrigin(capability.relyingParty.id, origin)) {
    return { ok: false, reason: "invalid-relying-party" };
  }
  return {
    ok: true,
    capability: {
      protocolVersion: capability.protocolVersion,
      nativeHandoff: capability.nativeHandoff,
      relyingParty: {
        id: capability.relyingParty.id.toLocaleLowerCase(),
        displayName: capability.relyingParty.displayName,
      },
      ...(capability.nativeIdentity === undefined
        ? {}
        : { nativeIdentity: capability.nativeIdentity }),
    },
  };
}

export function createHubCapabilityClient(
  httpClient: HttpClientService,
  now: () => number = Date.now,
): HubCapabilityClient {
  return {
    check: async (origin, signal) => {
      const checkedAt = now();
      let response: Awaited<ReturnType<HttpClientService["fetch"]>>;
      try {
        response = await httpClient.fetch(new URL(HUB_CAPABILITY_PATH, origin).toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "omit",
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
      } catch {
        return { status: "incompatible", checkedAt, reason: "unreachable" };
      }
      if (!response.ok) {
        return {
          status: "incompatible",
          checkedAt,
          reason: response.status === 404 ? "capability-not-found" : "unreachable",
        };
      }

      let body: string;
      try {
        body = await response.text();
      } catch {
        return { status: "incompatible", checkedAt, reason: "invalid-document" };
      }
      if (body.length === 0 || body.length > MAX_CAPABILITY_BODY_LENGTH) {
        return { status: "incompatible", checkedAt, reason: "invalid-document" };
      }

      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return { status: "incompatible", checkedAt, reason: "invalid-document" };
      }
      const decoded = decodeHubCapability(value, origin);
      if (!decoded.ok) {
        return { status: "incompatible", checkedAt, reason: decoded.reason };
      }
      return { status: "compatible", checkedAt, capability: decoded.capability };
    },
  };
}

/**
 * Bound an owner-triggered compatibility probe even when a platform fetch
 * implementation ignores AbortSignal. Aborting still releases conforming
 * transports, while the race guarantees that every UI leaves its checking
 * state and can offer a retry.
 */
export async function checkHubCapabilityWithTimeout(
  client: HubCapabilityClient,
  origin: string,
  options: {
    readonly timeoutMs?: number;
    readonly now?: () => number;
  } = {},
): Promise<HubCapabilityCheck> {
  const timeoutMs = options.timeoutMs ?? HUB_CAPABILITY_CHECK_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.check(origin, controller.signal),
      new Promise<HubCapabilityCheck>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: "incompatible", checkedAt: now(), reason: "unreachable" });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function hubCapabilityFailureText(reason: HubCapabilityFailureReason): string {
  switch (reason) {
    case "capability-not-found":
      return "This server does not advertise Ryco Hub mobile support.";
    case "invalid-document":
      return "The Hub returned an invalid compatibility document.";
    case "invalid-relying-party":
      return "The Hub advertised a relying party that does not match its domain.";
    case "unreachable":
      return "Ryco could not reach the Hub compatibility endpoint.";
    case "unsupported-handoff":
      return "This Hub does not support the required system-browser handoff.";
    case "unsupported-protocol":
      return "This Hub uses an unsupported mobile protocol version.";
  }
}
