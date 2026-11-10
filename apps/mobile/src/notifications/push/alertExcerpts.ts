/**
 * Alert excerpts (`docs/push-alerts.md`): an approval or question alert carries, sealed, what the
 * person is asked, and the notification extension leaves the latest one per thread for the app
 * (`AlertExcerptStore.swift`). Opening that thread, by a tap on the alert or any other way, then
 * shows its card at once, before the connection is up.
 *
 * The card it builds is provisional: it stands only until the thread's live detail loads, which
 * replaces it with the real one. Answering never bypasses the connection: an approval's Allow or
 * Deny becomes the same pending action an alert's own buttons set (`pendingNotificationAction.ts`),
 * carried out by request id once the thread is live, or refused there when it was answered
 * meanwhile; a question's choices are kept in the same draft the live card reads, and are sent
 * from it.
 */
import type { PendingApproval, PendingUserInput } from "@ryco/client-runtime/state/session";
import {
  ApprovalRequestId,
  EventId,
  type EnvironmentId,
  type ThreadId,
  TurnId,
} from "@ryco/contracts";
import { PushAlertExcerpt } from "@ryco/contracts/push-hub";
import * as Schema from "effect/Schema";

/** As the extension: an alert sealed longer ago than this is stale, and so is its excerpt. */
export const ALERT_EXCERPT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const AlertExcerptRecord = Schema.Struct({
  v: Schema.Literal(1),
  e: Schema.String,
  th: Schema.String,
  tu: Schema.optionalKey(Schema.String),
  k: Schema.Literals(["approval", "input"]),
  rq: Schema.optionalKey(Schema.String),
  at: Schema.Number,
  x: PushAlertExcerpt,
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(AlertExcerptRecord));

/** The thread's waiting requests as an alert described them, shaped like the live ones. */
export interface AlertExcerptPrompts {
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly userInputs: ReadonlyArray<PendingUserInput>;
  /** Questions or options were left out to fit the alert: the card shows, answers wait. */
  readonly partial: boolean;
}

export const NO_ALERT_EXCERPT_PROMPTS: AlertExcerptPrompts = Object.freeze({
  approvals: [],
  userInputs: [],
  partial: false,
});

/**
 * The prompts a saved record describes, or null when it is not one for this thread, is too old,
 * or does not decode (a newer extension's record this app cannot read is left alone).
 */
export function alertExcerptPrompts(input: {
  readonly json: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly nowMs: number;
}): AlertExcerptPrompts | null {
  const decoded = decodeRecord(input.json);
  if (decoded._tag === "None") return null;
  const record = decoded.value;
  if (record.e !== input.environmentId || record.th !== input.threadId) return null;
  const ageMs = input.nowMs - record.at;
  if (ageMs < -60_000 || ageMs > ALERT_EXCERPT_MAX_AGE_MS) return null;
  const createdAt = new Date(record.at).toISOString();
  const turnId = record.tu === undefined ? {} : { turnId: TurnId.make(record.tu) };
  if ("a" in record.x) {
    // Only an approval the alert names can be answered from its card.
    if (record.k !== "approval" || record.rq === undefined) return null;
    const approval = record.x.a;
    return {
      approvals: [
        {
          requestId: ApprovalRequestId.make(record.rq),
          requestKind: approval.k,
          createdAt,
          ...turnId,
          ...(approval.d === undefined ? {} : { detail: approval.d }),
          ...(approval.r === undefined ? {} : { reason: approval.r }),
        },
      ],
      userInputs: [],
      partial: false,
    };
  }
  if (record.k !== "input") return null;
  const question = record.x.u;
  return {
    approvals: [],
    userInputs: [
      {
        requestId: ApprovalRequestId.make(question.rq),
        // The live card's draft key: what is picked here is still picked there.
        ...(question.ev === undefined
          ? {}
          : { userInputIdentity: { requestEventId: EventId.make(question.ev) } }),
        createdAt,
        ...turnId,
        questions: question.qs.map((item) => ({
          id: item.id,
          header: item.h ?? "",
          question: item.q,
          options: (item.o ?? []).map((label) => ({ label, description: "" })),
          multiSelect: item.m === true,
        })),
      },
    ],
    partial: question.c === true,
  };
}
