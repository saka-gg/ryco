/**
 * The opened payload of a push alert (`docs/push-alerts.md`): what the node seals to one device
 * and its notification extension opens, including the excerpt of an approval or question. Only
 * the node and the phone read it; the Hub carries it sealed and the web app never loads this
 * module.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PushAlertKind } from "./push.ts";

const SafeCounter = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);

/** Longest thread title a sealed payload carries, in UTF-16 code units. */
export const PUSH_ALERT_TITLE_MAX_LENGTH = 120;
/** Longest approval request id a sealed payload carries; a longer one is left out. */
export const PUSH_ALERT_REQUEST_ID_MAX_LENGTH = 160;
/**
 * Most UTF-8 bytes the excerpt (`x`) of a sealed payload takes, as JSON: about a kilobyte of the
 * question or the approval's command. The node trims it further when the seal would not fit the
 * Hub's `sealedMaxLength` (`@ryco/contracts/push-hub`).
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
