import * as Schema from "effect/Schema";

/**
 * A node's identity on the relay (`node_…`). Apart from the relay's wire
 * schemas (`./relay.ts`, which re-exports it): node proofs and the thread read
 * cache name a node without speaking the relay protocol, and importing it from
 * there put every relay schema on the web app's first download.
 */
export const RelayNodeId = Schema.String.check(
  Schema.isPattern(/^node_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
).pipe(Schema.brand("RelayNodeId"));
export type RelayNodeId = typeof RelayNodeId.Type;
