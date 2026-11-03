/**
 * linkedAccessCheckHttp - Asks the node's Hub about its linked devices, with a
 * fresh node proof (`POST /api/node/linked-access/check`).
 *
 * A node-proof HTTPS call, like the push attention signal: an older Hub answers
 * 404 and nothing else changes.
 *
 * @module hubConnector/linkedAccessCheckHttp
 */
import {
  NODE_LINKED_ACCESS_CHECK_PATH,
  NodeLinkedAccessCheckResult,
  type NodeLinkedAccessSubject,
} from "@ryco/contracts/node-linked-access";
import { RELAY_PROTOCOL_MAJOR, RELAY_PROTOCOL_MINOR } from "@ryco/contracts/relay";
import { Option, Schema } from "effect";

import { fetchBoundedJson } from "../hubIdentity/BoundedHttp.ts";
import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import type { LinkedAccessAskOutcome } from "./linkedAccessCheck.ts";

const decodeResult = Schema.decodeUnknownOption(NodeLinkedAccessCheckResult);

class LinkedAccessHttpFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("The linked access check failed.");
    this.status = status;
  }
}

export function makeLinkedAccessAsker(deps: {
  readonly hubOrigin: string;
  readonly identity: HubIdentityRuntimeShape;
  readonly connector: Pick<HubConnector, "asIdentityOwner">;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
}) {
  return async (
    subjects: ReadonlyArray<NodeLinkedAccessSubject>,
  ): Promise<LinkedAccessAskOutcome> => {
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
        subjects,
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
        `${deps.hubOrigin}${NODE_LINKED_ACCESS_CHECK_PATH}`,
        {
          method: "POST",
          redirect: "error",
          signal: deps.signal,
          headers: { "content-type": "application/json" },
          body,
        },
        // An older Hub's 404 need not be JSON: keep the status either way.
        (failure) => {
          throw new LinkedAccessHttpFailure(
            failure.kind === "invalid_response" ? failure.status : 0,
          );
        },
      );
    } catch (error) {
      const status = error instanceof LinkedAccessHttpFailure ? error.status : 0;
      return status === 404 || status === 405 ? { kind: "unsupported" } : { kind: "failed" };
    }
    if (!response.ok) {
      return response.status === 404 || response.status === 405
        ? { kind: "unsupported" }
        : { kind: "failed" };
    }
    const decoded = decodeResult(response.value);
    return Option.isSome(decoded)
      ? { kind: "answered", results: decoded.value.results }
      : { kind: "failed" };
  };
}
