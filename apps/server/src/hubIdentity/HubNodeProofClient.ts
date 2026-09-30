import {
  canonicalizeHubOrigin,
  encodeNodeAuthenticationTranscript,
} from "@ryco/shared/nodeIdentity";
import type { RelayNodeAuthHandshake } from "@ryco/contracts/relay";

import { fetchBoundedJson, type BoundedJsonFailure } from "./BoundedHttp.ts";
import type { LocalHubIdentityStateStore } from "./LocalHubIdentityState.ts";
import type { NodeSigningIdentity } from "./NodeSigningIdentity.ts";

export interface HubNodeChallenge {
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly challenge: Uint8Array;
  readonly challengeExpiresAt: number;
}

export interface HubNodeChallengeTransport {
  readonly request: (input: {
    readonly hubOrigin: string;
    readonly nodeId: string;
    readonly activeKeyId: string;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
  }) => Promise<HubNodeChallenge>;
}

export interface NodeAuthenticationKeySelector {
  readonly authenticationKey: (hubOrigin: string) => Promise<{
    readonly keyId: string;
    readonly secretName: string;
  }>;
}

export type NodeRelayAuthenticationFrame = RelayNodeAuthHandshake;

export type HubNodeProofFailure =
  | "network"
  | "rate_limited"
  | "server_draining"
  | "authentication_failed"
  | "protocol_invalid"
  | "identity_unavailable";

export class HubNodeProofClientError extends Error {
  readonly code = "node_proof_failed" as const;
  readonly failure: HubNodeProofFailure;

  constructor(failure: HubNodeProofFailure) {
    super("Hub node proof operation failed.");
    this.name = "HubNodeProofClientError";
    this.failure = failure;
  }
}

export interface HubNodeProofClient {
  readonly createRelayAuthenticationFrame: (
    hubOrigin: string,
    protocol: { readonly protocolMajor: number; readonly protocolMinor: number },
  ) => Promise<NodeRelayAuthenticationFrame>;
}

function proofError(failure: HubNodeProofFailure): never {
  throw new HubNodeProofClientError(failure);
}

/**
 * Client errors a reverse proxy or load balancer answers with while a Hub
 * deploys or restarts — a missing route, a timeout, a conflict, a misdirected
 * or too-early request. The Hub's own challenge route answers none of them for
 * a node it refuses, so they are retried rather than parking the node for an
 * operator; a genuine refusal (400, 401, 403) still stops.
 */
const TRANSIENT_PROOF_STATUSES = new Set([404, 405, 408, 409, 421, 425]);

function proofHttpError(status: number): never {
  if (status === 429) return proofError("rate_limited");
  if (status === 503) return proofError("server_draining");
  if (status >= 500 && status <= 599) return proofError("network");
  if (TRANSIENT_PROOF_STATUSES.has(status)) return proofError("network");
  if (status >= 400 && status <= 499) return proofError("authentication_failed");
  return proofError("protocol_invalid");
}

function proofTransportError(failure: BoundedJsonFailure): never {
  if (failure.kind === "transport") return proofError("network");
  return proofHttpError(failure.status);
}

function validateChallenge(
  value: HubNodeChallenge,
  requested: { readonly protocolMajor: number; readonly protocolMinor: number },
  now: number,
): HubNodeChallenge {
  if (
    value.protocolMajor !== requested.protocolMajor ||
    value.protocolMinor !== requested.protocolMinor ||
    !(value.challenge instanceof Uint8Array) ||
    value.challenge.byteLength !== 32 ||
    !Number.isSafeInteger(value.challengeExpiresAt) ||
    value.challengeExpiresAt <= now ||
    value.challengeExpiresAt > now + 60_000
  ) {
    return proofError("protocol_invalid");
  }
  return { ...value, challenge: Uint8Array.from(value.challenge) };
}

export function makeHubNodeProofClient(dependencies: {
  readonly transport: HubNodeChallengeTransport;
  readonly stateStore: LocalHubIdentityStateStore;
  readonly signingIdentity: NodeSigningIdentity;
  readonly keySelector: NodeAuthenticationKeySelector;
  readonly now?: () => number;
}): HubNodeProofClient {
  const now = dependencies.now ?? Date.now;
  return {
    createRelayAuthenticationFrame: async (rawHubOrigin, protocol) => {
      let hubOrigin: string;
      try {
        hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
      } catch {
        return proofError("identity_unavailable");
      }
      if (
        !Number.isSafeInteger(protocol.protocolMajor) ||
        protocol.protocolMajor < 0 ||
        protocol.protocolMajor > 65_535 ||
        !Number.isSafeInteger(protocol.protocolMinor) ||
        protocol.protocolMinor < 0 ||
        protocol.protocolMinor > 65_535
      ) {
        return proofError("protocol_invalid");
      }
      let active;
      let selected;
      try {
        const state = await dependencies.stateStore.readOrCreate();
        active = state.activeNode;
        if (active === null || active.hubOrigin !== hubOrigin) {
          return proofError("identity_unavailable");
        }
        selected = await dependencies.keySelector.authenticationKey(hubOrigin);
      } catch (error) {
        if (error instanceof HubNodeProofClientError) throw error;
        return proofError("identity_unavailable");
      }
      let challenge: HubNodeChallenge;
      try {
        challenge = validateChallenge(
          await dependencies.transport.request({
            hubOrigin,
            nodeId: active.nodeId,
            activeKeyId: selected.keyId,
            ...protocol,
          }),
          protocol,
          now(),
        );
      } catch (error) {
        if (error instanceof HubNodeProofClientError) throw error;
        return proofError("network");
      }
      const transcript = encodeNodeAuthenticationTranscript({
        hubOrigin,
        ...protocol,
        nodeId: active.nodeId,
        activeKeyId: selected.keyId,
        challengeExpiresAt: challenge.challengeExpiresAt,
        challenge: challenge.challenge,
      });
      try {
        const signature = await dependencies.signingIdentity.sign(selected.secretName, transcript);
        return {
          type: "auth",
          peer: "node",
          ...protocol,
          nodeId: active.nodeId as RelayNodeAuthHandshake["nodeId"],
          nonce: Uint8Array.from(challenge.challenge),
          signature,
        };
      } catch {
        return proofError("identity_unavailable");
      } finally {
        challenge.challenge.fill(0);
        transcript.fill(0);
      }
    },
  };
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function makeHubNodeChallengeHttpTransport(
  fetchImplementation: FetchLike = fetch,
  options: { readonly timeoutMs?: number } = {},
): HubNodeChallengeTransport {
  return {
    request: async (input) => {
      const response = await fetchBoundedJson(
        fetchImplementation,
        `${canonicalizeHubOrigin(input.hubOrigin)}/api/node/auth/challenges`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            nodeId: input.nodeId,
            activeKeyId: input.activeKeyId,
            protocolMajor: input.protocolMajor,
            protocolMinor: input.protocolMinor,
          }),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        },
        proofTransportError,
        options,
      );
      if (!response.ok) return proofHttpError(response.status);
      const value = response.value;
      if (typeof value !== "object" || value === null) return proofError("protocol_invalid");
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.protocolMajor !== "number" ||
        typeof candidate.protocolMinor !== "number" ||
        typeof candidate.challengeExpiresAt !== "number" ||
        typeof candidate.challenge !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(candidate.challenge)
      ) {
        return proofError("protocol_invalid");
      }
      const challenge = Buffer.from(candidate.challenge, "base64url");
      if (challenge.byteLength !== 32 || challenge.toString("base64url") !== candidate.challenge) {
        return proofError("protocol_invalid");
      }
      return {
        protocolMajor: candidate.protocolMajor,
        protocolMinor: candidate.protocolMinor,
        challenge: Uint8Array.from(challenge),
        challengeExpiresAt: candidate.challengeExpiresAt,
      };
    },
  };
}
