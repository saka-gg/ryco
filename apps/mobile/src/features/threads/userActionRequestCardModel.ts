import type {
  EnvironmentApi,
  NodeSessionRole,
  ThreadId,
  UserActionAnswerResult,
  UserActionOutcome,
  UserActionRequestId,
} from "@ryco/contracts";
import {
  userActionAnswerAccess,
  userActionAnswerInput,
  userActionRequestCards,
  userActionRequestFailureText,
  type UserActionAnswerAccess,
  type UserActionRequestView,
} from "@ryco/client-runtime/userActionRequests";
import { userActionRequestHints, type UserActionHint } from "@ryco/shared/userActionHints";
import type { UserActionRequestActivity } from "@ryco/shared/userActionRequestState";

/**
 * The thread screen's user action request cards (an agent handed a browser tab or terminal to
 * the user): the unanswered requests and whether this device may answer them. Presentation lives
 * in `UserActionRequestCard.tsx`; the request rules and copy are the shared ones in
 * `@ryco/client-runtime/userActionRequests`. The phone cannot show the desktop's tab or terminal,
 * so its card says where to continue and offers Done and Won't do only.
 */
export interface MobileUserActionRequestCards {
  readonly requests: ReadonlyArray<UserActionRequestView>;
  readonly access: UserActionAnswerAccess;
  /** Sign-in links and codes a terminal printed, by request id. */
  readonly hints: ReadonlyMap<string, UserActionHint>;
}

/** Expiry is re-read this often while a card shows, so a card left open past its time closes. */
export const USER_ACTION_EXPIRY_RECHECK_MS = 15_000;

const NO_REQUESTS: ReadonlyArray<UserActionRequestView> = [];

export function mobileUserActionRequestCards(input: {
  readonly activities: ReadonlyArray<UserActionRequestActivity> | undefined;
  readonly nowMs: number;
  /** The node advertises `userActionRequests`. */
  readonly nodeSupports: boolean;
  /** The environment row's role; unknown is not assumed to be the owner's. */
  readonly role: NodeSessionRole | undefined;
  readonly mutationReady: boolean;
  /** A cached or degraded view renders the card but cannot answer it. */
  readonly promptsDisabled: boolean;
}): MobileUserActionRequestCards {
  const requests =
    input.activities === undefined
      ? NO_REQUESTS
      : userActionRequestCards(input.activities, input.nowMs);
  const access = userActionAnswerAccess({
    nodeSupports: input.nodeSupports,
    // A direct pairing that is not the node's owner is a viewer to it.
    role: input.role === "client" ? "viewer" : input.role,
    mutationReady: input.mutationReady && !input.promptsDisabled,
    mutationReason: input.promptsDisabled ? "Reconnect to answer." : null,
  });
  const hints =
    requests.length === 0 || input.activities === undefined
      ? NO_HINTS
      : userActionRequestHints(input.activities);
  return { requests, access, hints };
}

const NO_HINTS: ReadonlyMap<string, UserActionHint> = new Map();

export class UserActionRequestUnavailableError extends Error {
  constructor() {
    super("This node cannot answer this request.");
    this.name = "UserActionRequestUnavailableError";
  }
}

/**
 * Sends Done or Won't do; throws when the node offers no answer RPC. Never retried: a repeat
 * would find the request answered.
 */
export async function answerThreadUserActionRequest(input: {
  readonly api: Pick<EnvironmentApi, "threads">;
  readonly threadId: ThreadId;
  readonly requestId: UserActionRequestId;
  readonly answer: "done" | "declined";
}): Promise<UserActionAnswerResult> {
  const answer = input.api.threads?.answerUserActionRequest;
  if (answer === undefined) throw new UserActionRequestUnavailableError();
  return answer(userActionAnswerInput(input.threadId, input.requestId, input.answer));
}

export type UserActionRequestSendResult =
  | { readonly kind: "answered"; readonly outcome: UserActionOutcome }
  | { readonly kind: "failed"; readonly error: string };

/**
 * The card's Done and Won't do: sends the answer and turns every outcome into a result, so the
 * card itself holds no try/catch (the React Compiler cannot lower one with branches inside).
 * `api` is read inside, because finding it throws without a connection. A failure's text is the
 * shared copy, never the transport's.
 */
export async function sendUserActionRequestAnswer(input: {
  readonly api: () => Pick<EnvironmentApi, "threads">;
  readonly threadId: ThreadId;
  readonly requestId: UserActionRequestId;
  readonly answer: "done" | "declined";
}): Promise<UserActionRequestSendResult> {
  try {
    const result = await answerThreadUserActionRequest({ ...input, api: input.api() });
    return { kind: "answered", outcome: result.outcome };
  } catch (failure) {
    return {
      kind: "failed",
      error:
        failure instanceof UserActionRequestUnavailableError
          ? failure.message
          : userActionRequestFailureText(failure),
    };
  }
}
