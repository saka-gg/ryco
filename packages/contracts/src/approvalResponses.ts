import { Schema } from "effect";
import { EventId, RuntimeSessionId } from "./baseSchemas.ts";

/** Identifies the callback the user actually saw, rather than only its provider-local id. */
export const ApprovalResponseIdentity = Schema.Struct({
  requestEventId: EventId,
  runtimeSessionId: Schema.optional(RuntimeSessionId),
});
export type ApprovalResponseIdentity = typeof ApprovalResponseIdentity.Type;

export const ApprovalResponseState = Schema.Literals([
  "submitting",
  "retryable",
  "uncertain",
  "settled",
  "invalidated",
]);
export type ApprovalResponseState = typeof ApprovalResponseState.Type;
