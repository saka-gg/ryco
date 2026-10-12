/**
 * The automatic native node claim error, apart from its service so the desktop
 * route can classify failures without loading node identity code.
 */
export type NodeNativeClaimErrorCode =
  | "native_node_claim_unavailable"
  | "native_node_claim_rejected"
  | "native_node_claim_conflict"
  | "native_node_claim_expired";

export class NodeNativeClaimError extends Error {
  readonly code: NodeNativeClaimErrorCode;

  constructor(code: NodeNativeClaimErrorCode) {
    super("Automatic native node claim failed.");
    this.name = "NodeNativeClaimError";
    this.code = code;
  }
}
