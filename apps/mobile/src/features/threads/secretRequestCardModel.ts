import type {
  EnvironmentApi,
  SecretRequestAnswerResult,
  SecretRequestId,
  ThreadId,
} from "@ryco/contracts";
import {
  secretRequestAnswerAccess,
  secretRequestAnswerInput,
  secretRequestCards,
  secretRequestFailureText,
  type SecretRequestAnswerAccess,
  type SecretRequestDraftAnswer,
  type SecretRequestView,
} from "@ryco/client-runtime/secretRequests";
import type { SecretRequestActivity } from "@ryco/shared/secretRequests";

/**
 * The thread screen's secret request cards (`ryco_request_secret`): the unanswered requests and
 * whether this device may answer them. Presentation lives in `SecretRequestCard.tsx`; the
 * request rules and copy are the shared ones in `@ryco/client-runtime/secretRequests`.
 */
export interface MobileSecretRequestCards {
  readonly requests: ReadonlyArray<SecretRequestView>;
  readonly access: SecretRequestAnswerAccess;
}

const NO_REQUESTS: ReadonlyArray<SecretRequestView> = [];

export function mobileSecretRequestCards(input: {
  readonly activities: ReadonlyArray<SecretRequestActivity> | undefined;
  readonly nowMs: number;
  /** The node advertises `secretRequests`. */
  readonly nodeSupports: boolean;
  /** The environment row's role; unknown is not assumed to be the owner's. */
  readonly role: "viewer" | "operator" | "owner" | "client" | undefined;
  readonly mutationReady: boolean;
  /** A cached or degraded view renders the card but cannot answer it. */
  readonly promptsDisabled: boolean;
}): MobileSecretRequestCards {
  const requests =
    input.activities === undefined
      ? NO_REQUESTS
      : secretRequestCards(input.activities, input.nowMs);
  const access = secretRequestAnswerAccess({
    nodeSupports: input.nodeSupports,
    // A direct pairing that is not the node's owner is a viewer to it.
    role: input.role === "client" ? "viewer" : input.role,
    mutationReady: input.mutationReady && !input.promptsDisabled,
    mutationReason: input.promptsDisabled ? "Reconnect to answer." : null,
  });
  return { requests, access };
}

export class SecretRequestUnavailableError extends Error {
  constructor() {
    super("This node cannot answer secret requests.");
    this.name = "SecretRequestUnavailableError";
  }
}

/**
 * Sends the answer. Null when there is nothing to send (a blank value); throws when the node
 * offers no answer RPC. Never retried: a repeat would find the request answered.
 */
export async function answerThreadSecretRequest(input: {
  readonly api: Pick<EnvironmentApi, "threads">;
  readonly threadId: ThreadId;
  readonly requestId: SecretRequestId;
  readonly answer: SecretRequestDraftAnswer;
}): Promise<SecretRequestAnswerResult | null> {
  const payload = secretRequestAnswerInput(input.threadId, input.requestId, input.answer);
  if (payload === null) return null;
  const answer = input.api.threads?.answerSecretRequest;
  if (answer === undefined) throw new SecretRequestUnavailableError();
  return answer(payload);
}

export type SecretRequestSendResult =
  | { readonly kind: "nothing" }
  | { readonly kind: "answered"; readonly outcome: "provided" | "declined" }
  | { readonly kind: "failed"; readonly error: string };

/**
 * The card's Save and Decline: sends the answer and turns every outcome into a result, so the
 * card itself holds no try/catch (the React Compiler cannot lower one with branches inside).
 * `api` is read inside, because finding it throws without a connection. A failure's text is the
 * shared copy, which never repeats the value.
 */
export async function sendSecretRequestAnswer(input: {
  readonly api: () => Pick<EnvironmentApi, "threads">;
  readonly threadId: ThreadId;
  readonly requestId: SecretRequestId;
  readonly answer: SecretRequestDraftAnswer;
}): Promise<SecretRequestSendResult> {
  try {
    const result = await answerThreadSecretRequest({ ...input, api: input.api() });
    if (result === null) return { kind: "nothing" };
    return { kind: "answered", outcome: result.status === "provided" ? "provided" : "declined" };
  } catch (failure) {
    return { kind: "failed", error: secretRequestFailureText(failure) };
  }
}
