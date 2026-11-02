/**
 * Answering a Codex optional question, on every client. While the question's turn runs, the
 * answer steers that turn (`thread.user-input.respond`, delivered by the node's process-local
 * authority). Once the turn ended, it goes as an ordinary user message through the shared send
 * engine: it starts the next turn, resuming the session, and the node records the question
 * answered in the same commit, so the card leaves every client and a second answer is refused.
 */
import type {
  AgentTokenMode,
  CommandId,
  EnvironmentApi,
  MessageId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@ryco/contracts";
import { formatOptionalQuestionAnswer } from "@ryco/shared/optionalQuestionAnswer";

import { commitSendTurnDispatch, type SendTurnDispatchAttachment } from "../composer/sendEngine.ts";
import type { PendingUserInput } from "../session/session-logic.ts";
import type { ThreadSession } from "../threads/types.ts";

/**
 * How an answer reaches the agent now: `steer` into the question's own running turn, `message`
 * as a new message once that turn ended and the thread is idle, or `wait` while another turn
 * runs (the agent's current turn did not ask it, and a turn cannot start beside it).
 */
export type OptionalAnswerRoute = "steer" | "message" | "wait";

export function resolveOptionalAnswerRoute(input: {
  readonly userInput: Pick<PendingUserInput, "turnId">;
  readonly session: Pick<ThreadSession, "orchestrationStatus" | "activeTurnId"> | null | undefined;
}): OptionalAnswerRoute {
  const status = input.session?.orchestrationStatus;
  const activeTurnId = input.session?.activeTurnId;
  if (status !== "running" && status !== "starting") return "message";
  if (
    status === "running" &&
    activeTurnId !== undefined &&
    // A question recorded without its turn: the node tells whether it still runs.
    (input.userInput.turnId === undefined || input.userInput.turnId === activeTurnId)
  ) {
    return "steer";
  }
  return "wait";
}

/** What an optional question card says, by route; web and native show the same words. */
export function optionalQuestionCardCopy(route: OptionalAnswerRoute): {
  readonly title: string;
  readonly hint: string;
} {
  switch (route) {
    case "steer":
      return {
        title: "Optional question · agent continues working",
        hint: "Answer while this turn is running. This is not an approval request.",
      };
    case "message":
      return {
        title: "Optional question · turn ended",
        hint: "Your answer is sent as a new message and starts the next turn. This is not an approval request.",
      };
    case "wait":
      return {
        title: "Optional question · turn ended",
        hint: "You can answer once the current turn ends.",
      };
  }
}

/** Whether a card may take attachments: only a message carries them (a steer cannot). */
export function optionalAnswerTakesAttachments(route: OptionalAnswerRoute): boolean {
  return route === "message";
}

/** The message text of an answer, as the node would steer it (`formatOptionalQuestionAnswer`). */
export function optionalAnswerMessageText(
  userInput: Pick<PendingUserInput, "requestId" | "itemId" | "turnId" | "questions">,
  answers: Readonly<Record<string, string | string[]>>,
): string {
  const text = formatOptionalQuestionAnswer(
    {
      itemId: userInput.itemId ?? userInput.requestId,
      turnId: userInput.turnId ?? "unknown",
      questions: userInput.questions,
    },
    answers,
  );
  if (text === undefined) throw new Error("Answer every optional question before submitting.");
  return text;
}

export interface SendOptionalAnswerAsMessageInput {
  readonly api: EnvironmentApi;
  readonly threadId: ThreadId;
  readonly userInput: PendingUserInput;
  readonly answers: Readonly<Record<string, string | string[]>>;
  /** Uploaded files, by token (`buildSendTurnUploadTokenDispatchAttachment`). */
  readonly attachments: readonly SendTurnDispatchAttachment[];
  /** The thread as it is: the answer runs on its own model and modes. */
  readonly thread: {
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly tokenMode: AgentTokenMode;
  };
  readonly providerDriver?: ProviderDriverKind | null;
  /** The hosted mutation-readiness check of the connection that showed the card. */
  readonly assertMutationReady?: () => void;
  readonly newCommandId: () => CommandId;
  readonly newMessageId: () => MessageId;
}

/**
 * Sends an answer as a new message that starts the next turn. Rejects when the node refuses it,
 * for example because another client already answered.
 */
export async function sendOptionalAnswerAsMessage(
  input: SendOptionalAnswerAsMessageInput,
): Promise<void> {
  const identity = input.userInput.userInputIdentity;
  if (!input.userInput.nonBlocking || identity === undefined) {
    throw new Error("This question cannot be answered with a message. Refresh the thread.");
  }
  const text = optionalAnswerMessageText(input.userInput, input.answers);
  input.assertMutationReady?.();
  await commitSendTurnDispatch({
    ...(input.providerDriver !== undefined ? { providerDriver: input.providerDriver } : {}),
    ...(input.assertMutationReady ? { assertMutationReady: input.assertMutationReady } : {}),
    api: input.api,
    threadId: input.threadId,
    isFirstMessage: false,
    isServerThread: true,
    title: input.thread.title,
    messageId: input.newMessageId(),
    commandId: input.newCommandId(),
    outgoingMessageText: text,
    turnAttachments: input.attachments,
    modelSelection: input.thread.modelSelection,
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    tokenMode: input.thread.tokenMode,
    bootstrap: undefined,
    sourceControlContexts: [],
    createdAt: new Date().toISOString(),
    newCommandId: input.newCommandId,
    beginLocalDispatch: () => {},
    // The thread's own modes: nothing to persist for the next turn.
    persistThreadSettingsForNextTurn: () => Promise.resolve(),
    optionalAnswer: {
      requestId: input.userInput.requestId,
      userInputIdentity: identity,
      answers: input.answers,
    },
  });
}
