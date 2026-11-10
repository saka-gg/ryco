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
 * Most UTF-8 bytes the excerpt (`x`) of a sealed payload takes, as JSON: about a kilobyte of the
 * question or the approval's command. The node trims it further when the seal would not fit the
 * Hub's {@link PushAttentionSignalResult.fields.sealedMaxLength}.
 */
export const PUSH_ALERT_EXCERPT_MAX_BYTES = 1_024;

const ApprovalRequestKindLiteral = Schema.Literals(["command", "file-read", "file-change"]);

/**
 * An approval's excerpt: what the agent asks to do, as its card shows it. Text cut short ends
 * with "…".
 */
export const PushAlertApprovalExcerpt = Schema.Struct({
  /** The request kind: run a command, read a file, change a file. */
  k: ApprovalRequestKindLiteral,
  /** The command or the path (the card's detail). */
  d: Schema.optionalKey(Schema.String),
  /** The provider's own reason for asking. */
  r: Schema.optionalKey(Schema.String),
});
export type PushAlertApprovalExcerpt = typeof PushAlertApprovalExcerpt.Type;

export const PushAlertQuestionExcerpt = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The question's short header. */
  h: Schema.optionalKey(Schema.String),
  q: Schema.String,
  /** Its option labels, in order (descriptions are left out). */
  o: Schema.optionalKey(Schema.Array(Schema.String)),
  /** More than one option may be picked. */
  m: Schema.optionalKey(Schema.Literal(true)),
});
export type PushAlertQuestionExcerpt = typeof PushAlertQuestionExcerpt.Type;

/** A question's excerpt: the agent's questions, so the app can show their card at once. */
export const PushAlertInputExcerpt = Schema.Struct({
  /** The question's request id. */
  rq: TrimmedNonEmptyString,
  /** Its request event id, which keys the app's answer drafts; absent when the node has none. */
  ev: Schema.optionalKey(TrimmedNonEmptyString),
  qs: Schema.Array(PushAlertQuestionExcerpt).check(Schema.isMinLength(1)),
  /** Set when questions or options were left out to fit: the card shows, but answers wait. */
  c: Schema.optionalKey(Schema.Literal(true)),
});
export type PushAlertInputExcerpt = typeof PushAlertInputExcerpt.Type;

/**
 * The excerpt (`x`) of an approval or question alert (`docs/push-alerts.md`): sealed with the
 * rest, at most {@link PUSH_ALERT_EXCERPT_MAX_BYTES}. Older phones ignore it.
 */
export const PushAlertExcerpt = Schema.Union([
  Schema.Struct({ a: PushAlertApprovalExcerpt }),
  Schema.Struct({ u: PushAlertInputExcerpt }),
]);
export type PushAlertExcerpt = typeof PushAlertExcerpt.Type;

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
  /**
   * What the person is asked: the approval's command, or the questions. Only on approval and
   * question alerts, and only from nodes that send it; older phones ignore it.
   */
  x: Schema.optionalKey(PushAlertExcerpt),
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
/** The bytes a seal adds to its plaintext: the version byte, the ephemeral key and the tag. */
export const PUSH_SEALED_OVERHEAD_BYTES = 49;
/**
 * base64url of a 1,024-byte blob: what every Hub takes. A node seals to this until the Hub's
 * answer names a larger {@link PushAttentionSignalResult.fields.sealedMaxLength}.
 */
export const PUSH_SEALED_LEGACY_MAX_LENGTH = 1_366;
/**
 * base64url of a 2,048-byte blob: room for an excerpt. With the Hub's own fields the APNs
 * payload stays near 3 KB, well under its 4 KB limit.
 */
export const PUSH_SEALED_MAX_LENGTH = 2_731;

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
  /**
   * The longest `sealed` this Hub takes, between {@link PUSH_SEALED_LEGACY_MAX_LENGTH} and
   * {@link PUSH_SEALED_MAX_LENGTH}. Absent from older Hubs, which take the legacy length only.
   */
  sealedMaxLength: Schema.optionalKey(SafeCounter),
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
  /**
   * The Hub also takes push-to-start tokens (iOS 17.2+) and starts a card when a node asks
   * (`docs/live-activity-push.md`). Absent from Hubs without it.
   */
  liveActivityStart: Schema.optional(Schema.Boolean),
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
  /**
   * The app's push-to-start token, hex: only while the person turned on starting a card when a
   * task begins, and only to a Hub whose capability says `liveActivityStart`. A registration
   * without it drops the earlier one.
   */
  liveActivityStartToken: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{64,512}$/u)),
  ),
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
  /**
   * A turn began on this node while, as far as it knows, the device shows no card: the Hub may
   * start one with these counts when the device registered a push-to-start token. Older Hubs
   * ignore it.
   */
  start: Schema.optionalKey(Schema.Literal(true)),
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
 * the sum when it changes), `started` (it asked iOS to start a card with them, and holds them),
 * `no-token` (the device shows no card that takes pushes; nothing is kept), `not-authorized`
 * (the node forgets the device), `rate-limited` (try again later). Only an entry with `start`
 * can be answered `started`.
 */
export const PushActivityEntryStatus = Schema.Literals([
  "accepted",
  "started",
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
