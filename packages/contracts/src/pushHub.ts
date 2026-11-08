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
/** Longest approval request id a sealed payload carries; a longer one is left out. */
export const PUSH_ALERT_REQUEST_ID_MAX_LENGTH = 160;

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
  /**
   * An approval alert's request: an Approve or Deny tapped on the alert answers this approval
   * only. Left out of other kinds, from older nodes, and when longer than
   * {@link PUSH_ALERT_REQUEST_ID_MAX_LENGTH}.
   */
  rq: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PUSH_ALERT_REQUEST_ID_MAX_LENGTH)),
  ),
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
  /**
   * The Hub takes Live Activity update tokens and sends `liveactivity` pushes with counts only
   * (`docs/live-activity-push.md`). Absent from Hubs without them.
   */
  liveActivities: Schema.optional(Schema.Boolean),
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
  /**
   * The update token of this device's agent Live Activity, hex, while one shows. Sent only to a
   * Hub whose capability says `liveActivities`; a registration without it drops the earlier one.
   */
  liveActivityToken: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64,512}$/u))),
});
export type NativePushRegistrationInput = typeof NativePushRegistrationInput.Type;

// --- Hub → device: Live Activity push updates (`docs/live-activity-push.md`) -----------

/**
 * The content state a Live Activity push update carries: counts only, never a title, project or
 * thread link, because the Hub cannot read thread content (`modules/ryco-widgets/ios/
 * AgentActivityContentState.swift` decodes it; `rows` and `url` stay absent).
 */
export const LiveActivityRemoteContentState = Schema.Struct({
  v: Schema.Literal(1),
  origin: Schema.Literal("remote"),
  counts: Schema.Struct({
    running: SafeCounter,
    needsYou: SafeCounter,
    failed: SafeCounter,
    done: SafeCounter,
  }),
  /** When the Hub built it, epoch ms. */
  updatedAt: SafeCounter,
});
export type LiveActivityRemoteContentState = typeof LiveActivityRemoteContentState.Type;

// --- Node → Hub: `POST /api/node/attention/activity` ----------------------------------

/**
 * The node's half of Live Activity push updates: per enrollment that registered with
 * `liveActivity`, how many of this node's threads run, need the person, or just ended. The Hub
 * sums them across the account's nodes into one {@link LiveActivityRemoteContentState}
 * (`docs/live-activity-push.md`).
 */
export const PUSH_ACTIVITY_SIGNAL_PATH = "/api/node/attention/activity";

export const PushActivityCounts = LiveActivityRemoteContentState.fields.counts;
export type PushActivityCounts = typeof PushActivityCounts.Type;

export const PushActivityEntry = Schema.Struct({
  enrollmentId: NativeE2eeEnrollmentId,
  counts: PushActivityCounts,
});
export type PushActivityEntry = typeof PushActivityEntry.Type;

export const PushActivitySignalInput = Schema.Struct({
  proof: NodeHubProof,
  /** The same sequence as the attention signal's: one counter for both. */
  sequence: SafeCounter,
  issuedAt: SafeCounter,
  activities: Schema.Array(PushActivityEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PUSH_ATTENTION_MAX_DELIVERIES),
  ),
});
export type PushActivitySignalInput = typeof PushActivitySignalInput.Type;

/**
 * What the Hub did with one entry: `accepted` (it holds these counts for the device and sends
 * the sum when it changes), `no-token` (the device shows no card that takes pushes; nothing is
 * kept), `not-authorized` (the node forgets the device), `rate-limited` (try again later).
 */
export const PushActivityEntryStatus = Schema.Literals([
  "accepted",
  "no-token",
  "not-authorized",
  "rate-limited",
]);
export type PushActivityEntryStatus = typeof PushActivityEntryStatus.Type;

export const PushActivitySignalResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  sequence: SafeCounter,
  results: Schema.Array(
    Schema.Struct({
      enrollmentId: NativeE2eeEnrollmentId,
      status: PushActivityEntryStatus,
    }),
  ).check(Schema.isMaxLength(PUSH_ATTENTION_MAX_DELIVERIES)),
});
export type PushActivitySignalResult = typeof PushActivitySignalResult.Type;
