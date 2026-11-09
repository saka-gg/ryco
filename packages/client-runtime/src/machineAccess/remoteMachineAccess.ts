/**
 * The owner's pairing calls against a node reached directly, authorized with
 * the saved pairing's bearer.
 *
 * The same node routes the web calls on its own origin (`primaryAuth.ts`
 * `createServerPairingCredential` and friends), here addressed at a saved
 * environment's `httpBaseUrl`. The node enforces the owner role on every one of
 * them; nothing here decides who may call. Listing goes through the node's
 * `subscribeAuthAccess` stream instead, which is live.
 *
 * The bearer is passed per call and never kept: a renewal may have superseded
 * the one read a moment ago, and the node revokes a pairing that presents a
 * superseded bearer, so callers read it from the store for each request.
 */
import type {
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionId,
} from "@ryco/contracts";

import { fetchRemoteJson } from "../connection/remoteApi.ts";
import type { HttpClientService } from "../platform/index.ts";

export interface RemoteMachineAccessTarget {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}

export interface RemoteMachineAccessApi {
  /** Mints one client-role, one-time pairing code with the node's default lifetime. */
  readonly createPairingCredential: (
    target: RemoteMachineAccessTarget,
    label: string | null,
  ) => Promise<AuthPairingCredentialResult>;
  readonly revokePairingLink: (target: RemoteMachineAccessTarget, id: string) => Promise<void>;
  readonly revokeClientSession: (
    target: RemoteMachineAccessTarget,
    sessionId: AuthSessionId,
  ) => Promise<void>;
  /** Revokes every client session but the caller's own; resolves with how many. */
  readonly revokeOtherClientSessions: (target: RemoteMachineAccessTarget) => Promise<number>;
}

export function createRemoteMachineAccessApi(
  httpClient: HttpClientService,
): RemoteMachineAccessApi {
  return {
    createPairingCredential: (target, label) => {
      const trimmed = label?.trim() ?? "";
      return fetchRemoteJson<AuthPairingCredentialResult>(httpClient, {
        httpBaseUrl: target.httpBaseUrl,
        pathname: "/api/auth/pairing-token",
        method: "POST",
        bearerToken: target.bearerToken,
        body: trimmed ? ({ label: trimmed } satisfies AuthCreatePairingCredentialInput) : {},
      });
    },
    revokePairingLink: async (target, id) => {
      await fetchRemoteJson<unknown>(httpClient, {
        httpBaseUrl: target.httpBaseUrl,
        pathname: "/api/auth/pairing-links/revoke",
        method: "POST",
        bearerToken: target.bearerToken,
        body: { id } satisfies AuthRevokePairingLinkInput,
      });
    },
    revokeClientSession: async (target, sessionId) => {
      await fetchRemoteJson<unknown>(httpClient, {
        httpBaseUrl: target.httpBaseUrl,
        pathname: "/api/auth/clients/revoke",
        method: "POST",
        bearerToken: target.bearerToken,
        body: { sessionId } satisfies AuthRevokeClientSessionInput,
      });
    },
    revokeOtherClientSessions: async (target) => {
      const result = await fetchRemoteJson<{ readonly revokedCount?: number }>(httpClient, {
        httpBaseUrl: target.httpBaseUrl,
        pathname: "/api/auth/clients/revoke-others",
        method: "POST",
        bearerToken: target.bearerToken,
      });
      return result.revokedCount ?? 0;
    },
  };
}
