import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  rejectExcessProperties,
} from "./baseSchemas.ts";
import {
  SECRET_REQUEST_PURPOSE_MAX_CHARS,
  SECRET_REQUEST_WAIT_MS_MAX,
  SecretRequestFile,
  SecretRequestId,
  SecretRequestKey,
  SecretRequestResolution,
} from "./secretRequest.ts";

/**
 * The parts of secret requests (`secretRequest.ts`) that only the node and the card read: the
 * activity payloads and the agent tool's input. Kept out of the barrel, so the web app's boot
 * chunk, which carries the barrel's schemas, does not carry them.
 */

export const SecretRequestStatus = Schema.Literals(["pending", "provided", "declined", "expired"]);
export type SecretRequestStatus = typeof SecretRequestStatus.Type;

/** The `secret.requested` activity's payload: what the card shows. Never a value. */
export const SecretRequestedActivityPayload = Schema.Struct({
  requestId: SecretRequestId,
  key: SecretRequestKey,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(SECRET_REQUEST_PURPOSE_MAX_CHARS)),
  file: SecretRequestFile,
  expiresAt: IsoDateTime,
});
export type SecretRequestedActivityPayload = typeof SecretRequestedActivityPayload.Type;

/** The `secret.resolved` activity's payload: how the request ended. Never a value. */
export const SecretResolvedActivityPayload = Schema.Struct({
  requestId: SecretRequestId,
  status: SecretRequestResolution,
});
export type SecretResolvedActivityPayload = typeof SecretResolvedActivityPayload.Type;

/**
 * `ryco_request_secret`'s input. `requestId` is the caller's own idempotency key: calling again
 * with the same one (and the same key and file) waits on the same request instead of asking twice.
 */
export const AgentControlRequestSecretInput = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  key: SecretRequestKey,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(SECRET_REQUEST_PURPOSE_MAX_CHARS)),
  file: Schema.optional(SecretRequestFile),
  waitMs: Schema.optional(
    NonNegativeInt.check(Schema.isLessThanOrEqualTo(SECRET_REQUEST_WAIT_MS_MAX)),
  ),
}).pipe(rejectExcessProperties);
export type AgentControlRequestSecretInput = typeof AgentControlRequestSecretInput.Type;
