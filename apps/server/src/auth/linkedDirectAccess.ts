import type {
  AdvertisedEndpoint,
  AuthLinkedDirectAccess,
  ExecutionEnvironmentDescriptor,
} from "@ryco/contracts";
import { Duration, Effect } from "effect";

import type { AuthAccessLink } from "../persistence/Services/AuthAccessLink.ts";
import type { RelayChannelAuthority } from "../ws/RpcPrincipal.ts";
import type {
  BootstrapCredentialError,
  BootstrapCredentialServiceShape,
} from "./Services/BootstrapCredentialService.ts";
import { base64UrlEncode } from "./utils.ts";

/** A linked code is redeemed straight away by the device that asked for it. */
export const LINKED_DIRECT_ACCESS_CODE_TTL = Duration.minutes(2);

const REACHABILITY_ORDER: Readonly<Record<AdvertisedEndpoint["reachability"], number>> = {
  "private-network": 0,
  lan: 1,
  public: 2,
  loopback: 3,
};

/**
 * Endpoints another device could use, most private first: a Tailscale address
 * before a LAN one, and loopback never — it names the asking device itself.
 */
export function linkedDirectAccessEndpoints(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
): ReadonlyArray<AdvertisedEndpoint> {
  return endpoints
    .filter((endpoint) => endpoint.reachability !== "loopback" && endpoint.status !== "unavailable")
    .toSorted(
      (left, right) =>
        REACHABILITY_ORDER[left.reachability] - REACHABILITY_ORDER[right.reachability] ||
        Number(right.httpBaseUrl.startsWith("https:")) -
          Number(left.httpBaseUrl.startsWith("https:")),
    );
}

/** The link a grant records for the device a relay channel authenticated. */
export function accessLinkForRelayAuthority(
  authority: Exclude<RelayChannelAuthority, { readonly trustSource: "none" }>,
): AuthAccessLink {
  return {
    trustSource: authority.trustSource,
    enrollmentId: authority.trustSource === "account-enrolled" ? authority.enrollmentId : null,
    clientFingerprint: base64UrlEncode(authority.clientIdentityFingerprint),
    role: authority.role,
  };
}

/**
 * `auth.issueLinkedDirectAccess`. The caller has already admitted the request
 * through the `relay_native` access class; the authority is re-read here so a
 * lease that ended in between issues nothing.
 */
export const issueLinkedDirectAccess = (input: {
  readonly authority: RelayChannelAuthority;
  readonly deviceLabel: string;
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly bootstrapCredentials: Pick<BootstrapCredentialServiceShape, "issueOneTimeToken">;
}): Effect.Effect<AuthLinkedDirectAccess | null, BootstrapCredentialError> =>
  Effect.gen(function* () {
    const authority = input.authority;
    if (authority.trustSource === "none") return null;
    const endpoints = linkedDirectAccessEndpoints(input.endpoints);
    if (endpoints.length === 0) {
      return { kind: "unavailable", reason: "no-direct-endpoint" } as const;
    }
    const issued = yield* input.bootstrapCredentials.issueOneTimeToken({
      ttl: LINKED_DIRECT_ACCESS_CODE_TTL,
      role: "client",
      subject: "hub-linked",
      label: `Linked through Hub · ${input.deviceLabel}`,
      link: accessLinkForRelayAuthority(authority),
    });
    return {
      kind: "issued",
      environmentId: input.environment.environmentId,
      label: input.environment.label,
      endpoints,
      credential: issued.credential,
      expiresAt: issued.expiresAt,
    } as const;
  });
