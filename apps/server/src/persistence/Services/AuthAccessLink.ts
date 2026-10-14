import { Schema } from "effect";

/**
 * Why a direct credential exists without an owner having paired it by hand:
 * the node issued it over a trusted native Hub relay channel
 * (`docs/superpowers/specs/2026-10-14-hub-linked-direct-access-design.md`).
 *
 * It carries the channel's device identity so that revoking the device — its
 * Hub enrollment or its local client authorization — revokes the credential,
 * and the channel's effective role, which is the most the credential grants.
 */
export const AuthAccessLink = Schema.Struct({
  trustSource: Schema.Literals(["account-enrolled", "locally-verified"]),
  /** The Hub enrollment for `account-enrolled`; `null` for `locally-verified`. */
  enrollmentId: Schema.NullOr(Schema.String),
  /** Base64url `ryco.client-key.v1` fingerprint of the device's identity key. */
  clientFingerprint: Schema.String,
  role: Schema.Literals(["viewer", "operator", "owner"]),
});
export type AuthAccessLink = typeof AuthAccessLink.Type;
