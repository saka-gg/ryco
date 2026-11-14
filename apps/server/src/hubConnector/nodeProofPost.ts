/**
 * nodeProofPost - The node-proof HTTPS calls a node makes to its Hub (push signals, linked access,
 * automation hooks, thread history upload): a fresh relay authentication frame taken as the
 * identity owner, sent base64url-encoded in the JSON body as `proof`, and wiped from memory once
 * serialized, whatever happens.
 *
 * @module hubConnector/nodeProofPost
 */
import {
  RELAY_PROTOCOL_MAJOR,
  RELAY_PROTOCOL_MINOR,
  type RelayNodeAuthHandshake,
} from "@ryco/contracts/relay";

import { fetchBoundedJson } from "../hubIdentity/BoundedHttp.ts";
import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";

export type NodeProof = Pick<
  RelayNodeAuthHandshake,
  "nodeId" | "protocolMajor" | "protocolMinor" | "nonce" | "signature"
>;

export interface NodeProofSource {
  readonly hubOrigin: string;
  readonly identity: Pick<HubIdentityRuntimeShape, "createRelayAuthenticationFrame">;
  readonly connector: Pick<HubConnector, "asIdentityOwner">;
}

/**
 * A fresh proof for this Hub, taken as the identity owner. `beforeCreate` runs inside the owner's
 * turn, right before the frame is made (throw from it to give up).
 */
export function createNodeProof(
  source: NodeProofSource,
  beforeCreate?: () => void,
): Promise<RelayNodeAuthHandshake> {
  return source.connector.asIdentityOwner(() => {
    beforeCreate?.();
    return source.identity.createRelayAuthenticationFrame(source.hubOrigin, {
      protocolMajor: RELAY_PROTOCOL_MAJOR,
      protocolMinor: RELAY_PROTOCOL_MINOR,
    });
  });
}

/** Wipes the proof's nonce and signature. */
export function discardNodeProof(proof: NodeProof): void {
  proof.nonce.fill(0);
  proof.signature.fill(0);
}

/** `body` with the proof as JSON. The proof is wiped afterwards, also when serializing throws. */
export function serializeWithNodeProof(proof: NodeProof, body: Record<string, unknown>): string {
  try {
    return JSON.stringify({
      ...body,
      proof: {
        nodeId: proof.nodeId,
        protocolMajor: proof.protocolMajor,
        protocolMinor: proof.protocolMinor,
        nonce: Buffer.from(proof.nonce).toString("base64url"),
        signature: Buffer.from(proof.signature).toString("base64url"),
      },
    });
  } finally {
    discardNodeProof(proof);
  }
}

/**
 * What a node-proof POST got back: the JSON of a 2xx answer, or the HTTP status of any other
 * answer (JSON or not). Status 0: no proof, or no answer (transport failure, abort, timeout).
 */
export type NodeProofPostResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number };

class NodeProofPostFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("The node-proof request failed.");
    this.status = status;
  }
}

/** POSTs `body` with a fresh proof to `path` on the Hub. Never throws. */
export async function postWithNodeProof(
  deps: NodeProofSource & {
    readonly signal: AbortSignal;
    readonly fetch?: typeof fetch;
  },
  request: {
    readonly path: string;
    readonly body: Record<string, unknown>;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
  },
): Promise<NodeProofPostResult> {
  let proof;
  try {
    proof = await createNodeProof(deps);
  } catch {
    return { ok: false, status: 0 };
  }
  let body: string;
  try {
    body = serializeWithNodeProof(proof, request.body);
  } catch {
    return { ok: false, status: 0 };
  }
  let response;
  try {
    response = await fetchBoundedJson(
      deps.fetch ?? fetch,
      `${deps.hubOrigin}${request.path}`,
      {
        method: "POST",
        redirect: "error",
        signal: deps.signal,
        headers: { "content-type": "application/json" },
        body,
      },
      // An older Hub's 404 need not be JSON: keep the status either way.
      (failure) => {
        throw new NodeProofPostFailure(failure.kind === "invalid_response" ? failure.status : 0);
      },
      {
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.maxResponseBytes !== undefined
          ? { maxResponseBytes: request.maxResponseBytes }
          : {}),
      },
    );
  } catch (error) {
    return { ok: false, status: error instanceof NodeProofPostFailure ? error.status : 0 };
  }
  return response.ok ? { ok: true, value: response.value } : { ok: false, status: response.status };
}
