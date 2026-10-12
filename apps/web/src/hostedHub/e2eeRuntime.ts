// The relay E2EE handshake as the web tier loads it: the §4.4 initiator (curves,
// hashes, cipher, CBOR transcripts) and the curve warm-up. It is reached only
// through `loadWebRelayE2ee` in `./e2eeAttempt`, which starts the load once an
// account authenticates, so none of it is on the hosted boot path.
export { makeRelayE2eeInitiator } from "@ryco/client-runtime/relay/e2ee";
export { warmE2eePrimitives } from "@ryco/shared/relayE2eeKeys";
