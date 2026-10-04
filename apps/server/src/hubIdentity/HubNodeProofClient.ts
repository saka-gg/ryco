import {
  canonicalizeHubOrigin,
  encodeNodeAuthenticationTranscript,
} from "@ryco/shared/nodeIdentity";
import {
  RELAY_AUTHENTICATION_DEADLINE_MS,
  type RelayNodeAuthHandshake,
} from "@ryco/contracts/relay";

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

/** How long the Hub honours a node challenge from issue. */
const HUB_CHALLENGE_LIFETIME_MS = 30_000;
/** Allowance for the proof's own transit once the socket is open. */
const CHALLENGE_DELIVERY_MARGIN_MS = 2_000;
/**
 * How long a challenge may take to sign and still be worth sending.
 *
 * Whatever the challenge's lifetime leaves after signing must cover opening the
 * socket — bounded by the relay's own deadline — and the proof's transit. A
 * proof signed inside this budget therefore reaches the Hub before its
 * challenge expires; one signed outside it may not. Measured on the local clock
 * from before the request, so it overstates the challenge's age and is
 * unaffected by skew between this machine's clock and the Hub's: comparing
 * `challengeExpiresAt` with local time would refetch forever on a node whose
 * clock runs ahead. Slow signing is real — a keychain access prompt, a slow
 * custody backend, a machine suspended mid-handshake.
 */
const CHALLENGE_SIGNING_BUDGET_MS =
  HUB_CHALLENGE_LIFETIME_MS - RELAY_AUTHENTICATION_DEADLINE_MS - CHALLENGE_DELIVERY_MARGIN_MS;
/**
 * One refetch, and the second proof is sent however long it took: signing again
 * for a third challenge would cost the owner another keychain prompt for a
 * proof the Hub may well have accepted, and a late one that it refuses is
 * recognized as stale and retried once (`RelayConnectionSession`).
 */
const MAX_CHALLENGE_ATTEMPTS = 2;

/**
 * Map a proof-preflight HTTP status to the connector's retry policy.
 *
 * The Hub's challenge route never refuses a node by status: it answers 201 for
 * every well-formed request — a dummy challenge for an unknown or revoked node,
 * whose proof the relay then rejects — and 400 only when the request itself is
 * malformed. Every other client error therefore comes from something between
 * the node and the Hub: a proxy without the route mid-deploy, a WAF or CDN
 * answering 401 or 403, a timeout. Treating those as a refusal would park every
 * node behind that intermediary for an operator until a restart, so they retry
 * like a network failure. A 400 means this node and the Hub disagree about the
 * request shape — an update, not a retry, fixes that — so it is a protocol
 * failure, which retries once and then stops.
 */
function proofHttpError(status: number): never {
  if (status === 429) return proofError("rate_limited");
  if (status === 503) return proofError("server_draining");
  if (status >= 500 && status <= 599) return proofError("network");
  if (status === 400) return proofError("protocol_invalid");
  if (status >= 401 && status <= 499) return proofError("network");
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
      for (let attempt = 1; ; attempt += 1) {
        const requestedAt = now();
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
        try {
          const transcript = encodeNodeAuthenticationTranscript({
            hubOrigin,
            ...protocol,
            nodeId: active.nodeId,
            activeKeyId: selected.keyId,
            challengeExpiresAt: challenge.challengeExpiresAt,
            challenge: challenge.challenge,
          });
          let signature: Uint8Array;
          try {
            signature = await dependencies.signingIdentity.sign(selected.secretName, transcript);
          } catch {
            return proofError("identity_unavailable");
          } finally {
            transcript.fill(0);
          }
          if (
            attempt >= MAX_CHALLENGE_ATTEMPTS ||
            now() - requestedAt < CHALLENGE_SIGNING_BUDGET_MS
          ) {
            return {
              type: "auth",
              peer: "node",
              ...protocol,
              nodeId: active.nodeId as RelayNodeAuthHandshake["nodeId"],
              nonce: Uint8Array.from(challenge.challenge),
              signature,
            };
          }
          // The proof may reach the Hub after its challenge expired, and be
          // rejected as an authentication failure that looks exactly like a
          // revoked key. A fresh challenge is free.
          signature.fill(0);
        } finally {
          challenge.challenge.fill(0);
        }
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
