/**
 * Hub-linked direct access, kept in step with the Hub (`docs/hub-linked-access-check.md`).
 *
 * A node holds direct sessions it issued to Hub devices over the relay
 * (`auth.issueLinkedDirectAccess`). When a member loses their grant on the node,
 * changes role, or their account, device or Hub session ends, the node asks its
 * Hub which of those devices still reach it, and at what role. The Hub nudges a
 * node that asked for it with the relay frame `node.linked-access.changed`.
 */
import * as Schema from "effect/Schema";

import { NodeHubProof } from "./nodeProof.ts";
import { NativeE2eeEnrollmentId, RelayEffectiveRole } from "./relay.ts";

/** The relay node feature that asks the Hub for `node.linked-access.changed` frames. */
export const NODE_LINKED_ACCESS_CHECK_FEATURE = "linked-access-check";

// --- Node → Hub: `POST /api/node/linked-access/check` ------------------------------

export const NODE_LINKED_ACCESS_CHECK_PATH = "/api/node/linked-access/check";
export const NODE_LINKED_ACCESS_MAX_SUBJECTS = 64;

/** A Hub account id as a relay grant names it: nonempty, at most 256 UTF-8 bytes. */
const HubAccountId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).byteLength <= 256 ? undefined : "account id is too long",
  ),
);

/** Unpadded base64url of a 32-byte `ryco.client-key.v1` fingerprint. */
const ClientKeyFingerprint = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));

/**
 * One device holding linked sessions on the node: an account-enrolled Hub device.
 * `accountId` is absent only for a link issued before nodes recorded it.
 */
export const NodeLinkedAccessSubject = Schema.Struct({
  accountId: Schema.optionalKey(HubAccountId),
  enrollmentId: NativeE2eeEnrollmentId,
  clientFingerprint: ClientKeyFingerprint,
});
export type NodeLinkedAccessSubject = typeof NodeLinkedAccessSubject.Type;

export const NodeLinkedAccessCheckInput = Schema.Struct({
  proof: NodeHubProof,
  subjects: Schema.Array(NodeLinkedAccessSubject).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(NODE_LINKED_ACCESS_MAX_SUBJECTS),
  ),
});
export type NodeLinkedAccessCheckInput = typeof NodeLinkedAccessCheckInput.Type;

/**
 * - `active`: a relay channel from this device would be admitted now, at `role`.
 * - `withdrawn`: it would be refused (grant, membership, account, enrollment or
 *   Hub session gone, or the key replaced).
 * - `unknown`: the Hub cannot tell (an older link it cannot tie to one account).
 */
export const NodeLinkedAccessStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("active"), role: RelayEffectiveRole }),
  Schema.Struct({ status: Schema.Literal("withdrawn") }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
]);
export type NodeLinkedAccessStatus = typeof NodeLinkedAccessStatus.Type;

/** One result per subject, in the request's order. */
export const NodeLinkedAccessCheckResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  results: Schema.Array(NodeLinkedAccessStatus).check(
    Schema.isMaxLength(NODE_LINKED_ACCESS_MAX_SUBJECTS),
  ),
});
export type NodeLinkedAccessCheckResult = typeof NodeLinkedAccessCheckResult.Type;
