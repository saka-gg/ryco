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
import { Option, Schema } from "effect";

import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import { postWithNodeProof } from "./nodeProofPost.ts";
import type { LinkedAccessAskOutcome } from "./linkedAccessCheck.ts";

const decodeResult = Schema.decodeUnknownOption(NodeLinkedAccessCheckResult);

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
    const response = await postWithNodeProof(deps, {
      path: NODE_LINKED_ACCESS_CHECK_PATH,
      body: { subjects },
    });
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
