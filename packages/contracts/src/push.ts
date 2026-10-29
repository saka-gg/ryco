/**
 * Background push alerts for native devices (`docs/push-alerts.md`): what a
 * device registers with its node over its own relay channel.
 *
 * The node decides when a thread needs attention, seals a small payload to
 * each registered device's push key, and hands its Hub only opaque blobs. The
 * other hops (node → Hub, device → Hub, the opened payload) are in
 * `pushHub.ts`, which the node's boot path never loads.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What a thread alert is about; the same kinds the clients' local alerts use. */
export const PushAlertKind = Schema.Literals([
  "approval",
  "input",
  "plan-ready",
  "completed",
  "failed",
  "stopped",
]);
export type PushAlertKind = typeof PushAlertKind.Type;

/** Kinds that ask the reader to act; a viewer can't, so it never gets them. */
export const PUSH_ACTION_ALERT_KINDS: ReadonlySet<PushAlertKind> = new Set([
  "approval",
  "input",
  "plan-ready",
]);

export const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));

/** A device push key's id: the first 22 base64url characters of SHA-256(publicKey). */
export const PushKeyId = Base64Url.check(Schema.isBetweenLength(22, 22));
export type PushKeyId = typeof PushKeyId.Type;

/** A raw 32-byte X25519 public key, base64url without padding. */
export const PushPublicKey = Base64Url.check(Schema.isBetweenLength(43, 43));
export type PushPublicKey = typeof PushPublicKey.Type;

// --- Device ↔ node ------------------------------------------------------------

export const PushRegisterDeviceInput = Schema.Struct({
  keyId: PushKeyId,
  publicKey: PushPublicKey,
  /** The kinds this device wants; the node drops action kinds for a viewer. */
  kinds: Schema.Array(PushAlertKind).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  /** Play the alert sound. */
  sound: Schema.Boolean,
});
export type PushRegisterDeviceInput = typeof PushRegisterDeviceInput.Type;

export const PushUnregisterDeviceInput = Schema.Struct({ keyId: PushKeyId });
export type PushUnregisterDeviceInput = typeof PushUnregisterDeviceInput.Type;

/**
 * While a device says it is in front, and keeps saying so, the node does not
 * push to it: its own local alerts cover the screen.
 */
export const PushPresence = Schema.Literals(["foreground", "background"]);
export type PushPresence = typeof PushPresence.Type;

export const PushSetPresenceInput = Schema.Struct({ state: PushPresence });
export type PushSetPresenceInput = typeof PushSetPresenceInput.Type;

/**
 * - `available`: the node's Hub took its last attention signal.
 * - `unknown`: the node has not signalled its Hub since it connected.
 * - `hub-unsupported`: the node's Hub has no attention route yet.
 * - `offline`: the node is not connected to a Hub right now.
 */
export const PushHubDelivery = Schema.Literals([
  "available",
  "unknown",
  "hub-unsupported",
  "offline",
]);
export type PushHubDelivery = typeof PushHubDelivery.Type;

export const PushDeviceStatus = Schema.Struct({
  /**
   * The channel identifies an account-enrolled device. Only those can receive
   * push: the Hub addresses a device by its enrollment.
   */
  eligible: Schema.Boolean,
  registered: Schema.Boolean,
  keyId: Schema.NullOr(PushKeyId),
  /** What the node sends this device once its role is applied. */
  kinds: Schema.Array(PushAlertKind),
  hubDelivery: PushHubDelivery,
});
export type PushDeviceStatus = typeof PushDeviceStatus.Type;

export const PushUnregisterDeviceResult = Schema.Struct({ removed: Schema.Boolean });
export type PushUnregisterDeviceResult = typeof PushUnregisterDeviceResult.Type;

export class PushRpcError extends Schema.TaggedError<PushRpcError>()("PushRpcError", {
  message: TrimmedNonEmptyString,
}) {}
