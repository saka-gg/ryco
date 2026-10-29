/**
 * attentionSignalHttp - Posts one attention signal to the node's Hub, with a
 * fresh node proof, and classifies the answer for the publisher.
 *
 * A node-proof HTTPS call rather than a relay control frame on purpose: a Hub
 * closes a node's whole connector socket on a frame it does not know, and a
 * minor-version bump would touch every relay client. An older Hub answers 404
 * here and nothing else changes.
 *
 * @module push/attentionSignalHttp
 */
import { RELAY_PROTOCOL_MAJOR, RELAY_PROTOCOL_MINOR } from "@ryco/contracts/relay";
import {
  PUSH_ATTENTION_SIGNAL_PATH,
  PushAttentionSignalResult,
  type PushAttentionSignalInput,
} from "@ryco/contracts/push-hub";
import { Option, Schema } from "effect";

import { fetchBoundedJson } from "../hubIdentity/BoundedHttp.ts";
import type { HubIdentityRuntimeShape } from "../hubConnector/HubIdentityRuntime.ts";
import type { HubConnector } from "../hubConnector/HubConnector.ts";
import type { AttentionSendOutcome } from "./attentionPublisher.ts";

const decodeResult = Schema.decodeUnknownOption(PushAttentionSignalResult);

class AttentionHttpFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("The attention signal failed.");
    this.status = status;
  }
}

function classifyStatus(status: number): AttentionSendOutcome {
  if (status === 404 || status === 405) return { kind: "unsupported" };
  if (status === 401 || status === 403) return { kind: "refused" };
  return { kind: "failed" };
}

export function makeAttentionSignalSender(deps: {
  readonly hubOrigin: string;
  readonly identity: HubIdentityRuntimeShape;
  readonly connector: HubConnector;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
}) {
  return async (signal: Omit<PushAttentionSignalInput, "proof">): Promise<AttentionSendOutcome> => {
    let proof;
    try {
      proof = await deps.connector.asIdentityOwner(() =>
        deps.identity.createRelayAuthenticationFrame(deps.hubOrigin, {
          protocolMajor: RELAY_PROTOCOL_MAJOR,
          protocolMinor: RELAY_PROTOCOL_MINOR,
        }),
      );
    } catch {
      return { kind: "failed" };
    }
    let body: string;
    try {
      body = JSON.stringify({
        ...signal,
        proof: {
          nodeId: proof.nodeId,
          protocolMajor: proof.protocolMajor,
          protocolMinor: proof.protocolMinor,
          nonce: Buffer.from(proof.nonce).toString("base64url"),
          signature: Buffer.from(proof.signature).toString("base64url"),
        },
      });
    } finally {
      proof.nonce.fill(0);
      proof.signature.fill(0);
    }
    let response;
    try {
      response = await fetchBoundedJson(
        deps.fetch ?? fetch,
        `${deps.hubOrigin}${PUSH_ATTENTION_SIGNAL_PATH}`,
        {
          method: "POST",
          redirect: "error",
          signal: deps.signal,
          headers: { "content-type": "application/json" },
          body,
        },
        // An older Hub's 404 need not be JSON: keep the status either way.
        (failure) => {
          throw new AttentionHttpFailure(failure.kind === "invalid_response" ? failure.status : 0);
        },
      );
    } catch (error) {
      return classifyStatus(error instanceof AttentionHttpFailure ? error.status : 0);
    }
    if (!response.ok) return classifyStatus(response.status);
    const decoded = decodeResult(response.value);
    return Option.isSome(decoded) && decoded.value.sequence === signal.sequence
      ? { kind: "delivered", result: decoded.value }
      : { kind: "failed" };
  };
}
