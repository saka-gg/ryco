import * as Schema from "effect/Schema";

import { RelayNodeId } from "./relayNodeId.ts";

const SafeCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);

/**
 * A fresh node-identity challenge proof, sent with a node's own HTTPS calls to
 * its Hub (cloud thread history, push attention signals); the Hub verifies the
 * signature against the node's enrolled key. One proof per request.
 */
export const NodeHubProof = Schema.Struct({
  nodeId: RelayNodeId,
  protocolMajor: SafeCounter,
  protocolMinor: SafeCounter,
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)),
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{85}[AQgw]$/)),
});
export type NodeHubProof = typeof NodeHubProof.Type;
