/**
 * What the native question card shows and does, without React or React Native: its words, what
 * can be pressed, and where an answer goes. An optional question's answer steers its turn while
 * that runs and starts the next turn as a new message once it ended, like on web
 * (`@ryco/client-runtime/state/user-input`).
 */
import type { PendingUserInput } from "@ryco/client-runtime/state/session";
import {
  optionalQuestionCardCopy,
  type OptionalAnswerRoute,
} from "@ryco/client-runtime/state/user-input";

export interface PendingUserInputCardView {
  readonly title: string;
  readonly hint: string | null;
  /** Fields and options can be changed. */
  readonly editable: boolean;
  readonly canSubmit: boolean;
  /** Only an optional question can be dismissed. */
  readonly canDismiss: boolean;
}

export function pendingUserInputCardView(input: {
  readonly userInput: Pick<PendingUserInput, "nonBlocking" | "responseState">;
  readonly route: OptionalAnswerRoute;
  readonly answers: Readonly<Record<string, string | string[]>> | null;
  readonly disabled: boolean;
  readonly submitting: boolean;
}): PendingUserInputCardView {
  const editable =
    !input.disabled &&
    !input.submitting &&
    input.userInput.responseState !== "submitting" &&
    input.userInput.responseState !== "uncertain";
  if (!input.userInput.nonBlocking) {
    return {
      title: "Input needed",
      hint: null,
      editable,
      canSubmit: editable && input.answers !== null,
      canDismiss: false,
    };
  }
  const copy = optionalQuestionCardCopy(input.route);
  return {
    title: copy.title,
    hint: copy.hint,
    editable,
    canSubmit: editable && input.answers !== null && input.route !== "wait",
    canDismiss: editable,
  };
}

/**
 * Delivers an answer: a new message for an optional question whose turn ended, otherwise a
 * response to the question (a steer of its running turn, or a blocking question's answer).
 * Rejects when either is refused; the caller keeps the draft then.
 */
export async function deliverPendingUserInputAnswer(input: {
  readonly userInput: Pick<PendingUserInput, "nonBlocking">;
  readonly route: OptionalAnswerRoute;
  readonly answers: Record<string, string | string[]>;
  readonly respond: (answers: Record<string, string | string[]>) => Promise<void>;
  readonly sendAsMessage?:
    | ((answers: Record<string, string | string[]>) => Promise<void>)
    | undefined;
}): Promise<"message" | "response"> {
  if (input.userInput.nonBlocking && input.route === "message") {
    if (!input.sendAsMessage) throw new Error("This answer cannot be sent from here.");
    await input.sendAsMessage(input.answers);
    return "message";
  }
  await input.respond(input.answers);
  return "response";
}
