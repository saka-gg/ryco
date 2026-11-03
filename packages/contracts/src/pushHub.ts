/**
 * Push alerts beyond the device's own registration (`docs/push-alerts.md`):
 * the opened payload, the node's attention signal to its Hub, and the
 * device's APNs registration with the Hub.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { NodeHubProof } from "./nodeProof.ts";
import { Base64Url, PushAlertKind } from "./push.ts";
import { NativeE2eeEnrollmentId } from "./relay.ts";

const SafeCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);

// --- The sealed payload ---------------------------------------------------------

/** Longest thread title a sealed payload carries, in UTF-16 code units. */
export const PUSH_ALERT_TITLE_MAX_LENGTH = 120;

/**
 * The opened payload. Short keys keep the sealed blob small: APNs caps the
 * whole notification at 4 KB, and the Hub adds its own fields around it.
 */
export const PushAlertPlaintext = Schema.Struct({
  v: Schema.Literal(1),
  k: PushAlertKind,
  /** Thread title, at most {@link PUSH_ALERT_TITLE_MAX_LENGTH}. */
  t: Schema.String.check(Schema.isMaxLength(PUSH_ALERT_TITLE_MAX_LENGTH)),
  /** The node's Hub environment id, the id the device knows the node by. */
  e: TrimmedNonEmptyString,
  th: TrimmedNonEmptyString,
  tu: Schema.NullOr(TrimmedNonEmptyString),
  /** The signal's sequence; also bound into the seal's associated data. */
  q: SafeCounter,
  /** When the node sealed it, epoch milliseconds. */
  at: SafeCounter,
});
export type PushAlertPlaintext = typeof PushAlertPlaintext.Type;

// --- Node → Hub: `POST /api/node/attention/signal` --------------------------------

export const PUSH_ATTENTION_SIGNAL_PATH = "/api/node/attention/signal";
export const PUSH_ATTENTION_MAX_DELIVERIES = 32;
/** base64url of 1 version byte, a 32-byte key, a 16-byte tag and some plaintext. */
export const PUSH_SEALED_MIN_LENGTH = 66;
/** base64url of a 1,024-byte blob. */
export const PUSH_SEALED_MAX_LENGTH = 1_366;

/** One device's sealed alert. The Hub routes it by enrollment and never opens it. */
export const PushAttentionDelivery = Schema.Struct({
  enrollmentId: NativeE2eeEnrollmentId,
  sealed: Base64Url.check(Schema.isBetweenLength(PUSH_SEALED_MIN_LENGTH, PUSH_SEALED_MAX_LENGTH)),
  /**
   * Opaque per (device, thread), 16 bytes in base64url: a newer alert for the
   * thread replaces the older one on the lock screen.
   */
  collapseId: Base64Url.check(Schema.isBetweenLength(22, 22)),
});
export type PushAttentionDelivery = typeof PushAttentionDelivery.Type;

/**
 * "This node needs attention, sequence N". `sequence` grows with every signal
 * the node ever sent and survives restarts; a retry repeats the same sequence
 * and deliveries, and the Hub answers it without sending again.
 */
export const PushAttentionSignalInput = Schema.Struct({
  proof: NodeHubProof,
  sequence: SafeCounter,
  issuedAt: SafeCounter,
  deliveries: Schema.Array(PushAttentionDelivery).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PUSH_ATTENTION_MAX_DELIVERIES),
  ),
});
export type PushAttentionSignalInput = typeof PushAttentionSignalInput.Type;

export const PushAttentionDeliveryStatus = Schema.Literals([
  "sent",
  "no-registration",
  "not-authorized",
  "rate-limited",
  "failed",
]);
export type PushAttentionDeliveryStatus = typeof PushAttentionDeliveryStatus.Type;

export const PushAttentionSignalResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  sequence: SafeCounter,
  results: Schema.Array(
    Schema.Struct({
      enrollmentId: NativeE2eeEnrollmentId,
      status: PushAttentionDeliveryStatus,
    }),
  ).check(Schema.isMaxLength(PUSH_ATTENTION_MAX_DELIVERIES)),
});
export type PushAttentionSignalResult = typeof PushAttentionSignalResult.Type;

// --- Device → Hub: APNs registration ------------------------------------------------

export const NATIVE_PUSH_CAPABILITY_PATH = "/api/native/push/capability";
export const NATIVE_PUSH_REGISTRATION_PATH = "/api/native/push/registration";

export const NativePushPlatform = Schema.Literals(["ios"]);
export type NativePushPlatform = typeof NativePushPlatform.Type;

export const NativePushEnvironment = Schema.Literals(["production", "sandbox"]);
export type NativePushEnvironment = typeof NativePushEnvironment.Type;

/** An iOS bundle identifier the Hub's APNs key may send to. */
export const NativePushTopic = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u),
  Schema.isMaxLength(155),
);
export type NativePushTopic = typeof NativePushTopic.Type;

/** `GET` it: a Hub without push answers 404. */
export const NativePushCapability = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  platforms: Schema.Array(NativePushPlatform),
  /** Bundle identifiers the Hub can send to; a build with another one gets no push. */
  topics: Schema.Array(NativePushTopic),
});
export type NativePushCapability = typeof NativePushCapability.Type;

/**
 * `PUT` with the native session: one registration per device enrollment, the
 * latest token wins. `DELETE` removes it.
 */
export const NativePushRegistrationInput = Schema.Struct({
  platform: NativePushPlatform,
  /** The APNs device token, hex. */
  token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64,200}$/u)),
  environment: NativePushEnvironment,
  topic: NativePushTopic,
});
export type NativePushRegistrationInput = typeof NativePushRegistrationInput.Type;
