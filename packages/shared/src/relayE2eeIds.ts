import { E2EE_ACCOUNT_ID_MAX_BYTES } from "./relayE2eeConstants.ts";

// Dependency-free relay E2EE input validation — docs/relay-e2ee-protocol.md §7.1.
//
// Hub account APIs validate E2EE identifiers on every account call, long before
// (and often without ever) opening an E2EE channel. Keeping the validators here,
// away from the key, transcript, and handshake modules, lets those callers check
// an identifier without loading the curve, hash, and CBOR implementations. The
// key and transcript modules re-export these, so there is still exactly one
// error type and one validator per identifier.

/**
 * The single validation error of the E2EE key and transcript modules. It
 * carries no detail by design: §7 material includes peer-supplied bytes and Hub
 * origins, and an error that reflected its input would put them in logs and
 * crash reports. It mirrors `NodeIdentityValidationError` in shape and in that
 * intent.
 */
export class RelayE2eeValidationError extends Error {
  readonly code = "invalid_relay_e2ee_input" as const;

  constructor() {
    super("Relay E2EE input is invalid.");
    this.name = "RelayE2eeValidationError";
  }
}

export function invalidRelayE2eeInput(): never {
  throw new RelayE2eeValidationError();
}

const utf8 = new TextEncoder();

/**
 * Account id (§7.1): nonempty UTF-8 text, at most `E2EE_ACCOUNT_ID_MAX_BYTES`
 * bytes, otherwise opaque. The empty string is not an identifier — it is
 * reserved for the §8.3 absence semantics of the web tier, which is why it can
 * never be validated as one here.
 *
 * The value is Hub-issued and never client-anchored (§12.1.1), so nothing
 * downstream may treat its presence as evidence of anything.
 */
export function assertE2eeAccountId(value: string): string {
  if (typeof value !== "string" || value.length === 0) invalidRelayE2eeInput();
  const bytes = utf8.encode(value).byteLength;
  if (bytes === 0 || bytes > E2EE_ACCOUNT_ID_MAX_BYTES) invalidRelayE2eeInput();
  return value;
}
