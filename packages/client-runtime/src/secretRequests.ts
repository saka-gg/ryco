/**
 * The private card for an agent's secret request (`ryco_request_secret`), shared by web and
 * mobile: which requests a thread shows, the answer payload, and the copy. The value lives only
 * in the card's own input until it is sent in `secrets.answerRequest`; nothing here stores,
 * logs or echoes it.
 *
 * @module secretRequests
 */
import {
  SECRET_REQUESTED_ACTIVITY_KIND,
  SecretRequestFailureReason,
  type SecretRequestAnswerInput,
  type SecretRequestId,
} from "@ryco/contracts/secret-request";
import type { ThreadId } from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import { secretRequestFailureMessage } from "@ryco/shared/secretRequests";
import {
  pendingSecretRequests,
  type SecretRequestActivity,
  type SecretRequestView,
} from "@ryco/shared/secretRequestState";
import * as Schema from "effect/Schema";

export type { SecretRequestView } from "@ryco/shared/secretRequestState";

/**
 * What happens to the value, under the field. Only what is true: the node writes it into the
 * file and the chat does not keep it, but the agent runs on the node and its code (or the agent
 * itself) can read that file.
 */
export function secretRequestPrivacyNote(file: string): string {
  return `Written to ${file} on your node, where the agent's code can read it. Not kept in the chat.`;
}

export const SECRET_REQUEST_FIELD_PLACEHOLDER = "Paste the value";

/** Cheap: whether a thread has ever asked, so a client loads the card only then. */
export function hasSecretRequestActivity(
  activities: ReadonlyArray<Pick<SecretRequestActivity, "kind">>,
): boolean {
  return activities.some((activity) => activity.kind === SECRET_REQUESTED_ACTIVITY_KIND);
}

/** The cards a thread shows: its unanswered, unexpired requests, oldest first. */
export function secretRequestCards(
  activities: ReadonlyArray<SecretRequestActivity>,
  nowMs: number,
): ReadonlyArray<SecretRequestView> {
  return pendingSecretRequests(activities, nowMs);
}

export type SecretRequestDraftAnswer =
  | { readonly type: "provide"; readonly value: string }
  | { readonly type: "decline" };

/**
 * The RPC payload for an answer. A value that is blank once trimmed returns null (the node
 * refuses it); callers keep Save disabled instead.
 */
export function secretRequestAnswerInput(
  threadId: ThreadId,
  requestId: SecretRequestId,
  answer: SecretRequestDraftAnswer,
): SecretRequestAnswerInput | null {
  if (answer.type === "decline") return { threadId, requestId, answer: { type: "decline" } };
  const value = answer.value.trim();
  if (value.length === 0) return null;
  return { threadId, requestId, answer: { type: "provide", value } };
}

const GENERIC_FAILURE = "Could not answer the request. Check the connection and try again.";

/**
 * Inline error copy for a failed answer. The node's refusal is shown in this build's own words
 * for its reason, and an authorization refusal by its message; anything else (a transport or
 * encoding failure, whose text could describe the payload) gets the generic copy, so the typed
 * value can never surface in the UI.
 */
export function secretRequestFailureText(failure: unknown): string {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) {
    return GENERIC_FAILURE;
  }
  if (failure._tag === "SecretRequestError" && "reason" in failure) {
    return Schema.is(SecretRequestFailureReason)(failure.reason)
      ? secretRequestFailureMessage(failure.reason)
      : GENERIC_FAILURE;
  }
  if (
    failure._tag === "AuthRpcError" &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return GENERIC_FAILURE;
}

export interface SecretRequestAnswerAccess {
  readonly canAnswer: boolean;
  /** Why the card is read-only, shown on it. */
  readonly reason: string | null;
}

/**
 * Whether this session may answer: the node must offer the RPC, the session's role must be the
 * owner's (`secrets.answerRequest` is owner-only), and the connection must take mutations now.
 * `role` undefined means the role is not known yet; it is not assumed to be enough.
 */
export function secretRequestAnswerAccess(input: {
  readonly nodeSupports: boolean;
  readonly role: "viewer" | "operator" | "owner" | undefined;
  readonly mutationReady: boolean;
  readonly mutationReason?: string | null;
}): SecretRequestAnswerAccess {
  if (!input.nodeSupports) {
    return { canAnswer: false, reason: "Update this node to answer secret requests." };
  }
  if (input.role === undefined || !hostedRoleAllows(input.role, WS_METHODS.secretsAnswerRequest)) {
    return { canAnswer: false, reason: "Only the node's owner can answer secret requests." };
  }
  if (!input.mutationReady) {
    return {
      canAnswer: false,
      reason: input.mutationReason ?? "Connect to the node to answer.",
    };
  }
  return { canAnswer: true, reason: null };
}

/** The line a card shows while (and right after) it is answered. */
export function secretRequestOutcomeText(
  request: Pick<SecretRequestView, "key" | "file">,
  outcome: "provided" | "declined",
): string {
  return outcome === "provided"
    ? `Saved ${request.key} to ${request.file}`
    : `Declined ${request.key}`;
}
