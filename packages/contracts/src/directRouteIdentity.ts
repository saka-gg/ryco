/**
 * A Hub machine's direct address proving it is the machine before a client
 * sends it any credential (`@ryco/shared/directRouteIdentity`): the client
 * posts `{ challenge }`, a fresh 32-byte value in base64url, and the node
 * answers `{ signature }`, its node identity key's signature, in base64url.
 * Both sides check the bodies by hand, so nothing here runs at load.
 */
export const DIRECT_ROUTE_IDENTITY_PATH = "/.well-known/ryco/environment/identity";
/** One base64url challenge; a larger body is refused unread. */
export const DIRECT_ROUTE_IDENTITY_MAX_BODY_BYTES = 256;

export interface DirectRouteIdentityProofResponse {
  /** Ed25519 over `encodeDirectRouteIdentityTranscript`, base64url. */
  readonly signature: string;
}
