import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Secrets an agent asks the user for (docs/secret-requests.md).
 *
 * An agent calls `ryco_request_secret` with an environment variable name, a short purpose and a
 * dotenv file in its own thread's checkout. The thread records only the request
 * (`secret.requested`) and its outcome (`secret.resolved`); the user answers on a private card,
 * and the value travels once, in `secrets.answerRequest`, from the card to the node, which writes
 * `KEY='value'` into that file. The value is never part of an event, a projection, an activity,
 * a log line, the transcript, a response or the agent's context.
 *
 * This module is in the barrel (its answer RPC is in every client's RPC group); what only the node
 * and the card read is in `secretRequestDetails.ts` (`@ryco/contracts/secret-request-details`).
 */

export const SECRET_REQUESTED_ACTIVITY_KIND = "secret.requested";
export const SECRET_RESOLVED_ACTIVITY_KIND = "secret.resolved";
export const SECRET_REQUEST_ACTIVITY_KINDS = [
  SECRET_REQUESTED_ACTIVITY_KIND,
  SECRET_RESOLVED_ACTIVITY_KIND,
] as const;

/** The private Agent Control tool. Like the queue tools, never on the external endpoint. */
export const AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL = "ryco_request_secret";

/** A request nobody answered within this long expires, like T3 Code's secret refs. */
export const SECRET_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;
/** The most a value may hold, in UTF-8 bytes, after trimming. */
export const SECRET_REQUEST_VALUE_MAX_BYTES = 16 * 1024;
/** Unanswered requests one thread may hold at once. */
export const SECRET_REQUEST_MAX_PENDING_PER_THREAD = 5;
export const SECRET_REQUEST_DEFAULT_FILE = ".env";
export const SECRET_REQUEST_FILE_MAX_CHARS = 255;
export const SECRET_REQUEST_PURPOSE_MAX_CHARS = 300;
/** How long one tool call waits for the answer at most; the agent calls again to keep waiting. */
export const SECRET_REQUEST_WAIT_MS_MAX = 45_000;
export const SECRET_REQUEST_WAIT_MS_DEFAULT = 30_000;

/** An environment variable name, as shells and dotenv loaders accept it. */
export const SECRET_REQUEST_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** `secret-request-` and 32 hex characters, derived on the node from the thread and the caller's id. */
export const SecretRequestId = Schema.String.check(
  Schema.isPattern(/^secret-request-[0-9a-f]{32}$/),
).pipe(Schema.brand("SecretRequestId"));
export type SecretRequestId = typeof SecretRequestId.Type;

export const SecretRequestKey = Schema.String.check(Schema.isPattern(SECRET_REQUEST_KEY_PATTERN));
export type SecretRequestKey = typeof SecretRequestKey.Type;

/** A dotenv file relative to the requesting thread's checkout; the node checks where it leads. */
export const SecretRequestFile = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SECRET_REQUEST_FILE_MAX_CHARS),
);

export const SecretRequestResolution = Schema.Literals(["provided", "declined", "expired"]);
export type SecretRequestResolution = typeof SecretRequestResolution.Type;

/**
 * `secrets.answerRequest` (owner only). `value` is an unchecked string on purpose: a schema check
 * that failed would describe the value in its error, so the node checks it and answers with a
 * fixed message instead.
 */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  requestId: SecretRequestId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("provide"), value: Schema.String }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

export const SecretRequestAnswerResult = Schema.Struct({
  status: SecretRequestResolution,
  /** Where the value went, relative to the thread's checkout. */
  file: SecretRequestFile,
  key: SecretRequestKey,
});
export type SecretRequestAnswerResult = typeof SecretRequestAnswerResult.Type;

/**
 * Why answering failed. The words for each reason live with the rest of the copy
 * (`secretRequestFailureMessage` in `@ryco/shared/secretRequests`); none repeats the value.
 */
export const SecretRequestFailureReason = Schema.Literals([
  "not-found",
  "already-answered",
  "busy",
  "expired",
  "empty-value",
  "value-too-long",
  "value-characters",
  "value-quoting",
  "value-expansion",
  "no-checkout",
  "checkout-changed",
  "unsafe-path",
  "name-case",
  "not-ignored",
  "tracked",
  "other-repository",
  "not-git",
  "not-regular-file",
  "file-too-large",
  "write-failed",
  "record-failed",
  "unencrypted-connection",
]);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

/** Answering failed, for a fixed reason: the error never carries the value or a path. */
export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  { reason: SecretRequestFailureReason },
) {}
