import {
  captureReviewedSendReadiness,
  type SendTurnDispatchAttachment,
} from "@ryco/client-runtime/state/composer";
import type { PendingUserInput } from "@ryco/client-runtime/state/session";
import type { Thread } from "@ryco/client-runtime/state/threads";
import { sendOptionalAnswerAsMessage } from "@ryco/client-runtime/state/user-input";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type ThreadId,
} from "@ryco/contracts";

import {
  composerFileUploadEngine,
  enqueueComposerFileUpload,
  getUsableComposerFileUploadToken,
} from "../../composerFileUpload";
import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { newCommandId, newMessageId } from "../../lib/utils";
import type { OptionalQuestionUploads } from "./OptionalQuestionCard";

/** An answer's files go through the composer's upload queue, under this thread. */
export function composerOptionalQuestionUploads(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly maxBytes: number;
}): OptionalQuestionUploads {
  return {
    maxBytes: Math.min(input.maxBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES),
    subscribe: composerFileUploadEngine.subscribe,
    snapshot: composerFileUploadEngine.snapshot,
    enqueue: (attachmentId, file) =>
      enqueueComposerFileUpload({
        attachmentId,
        threadId: input.threadId,
        environmentId: input.environmentId,
        file,
      }),
    release: (attachmentId) => composerFileUploadEngine.release(attachmentId),
    usableToken: (attachmentId) =>
      getUsableComposerFileUploadToken(attachmentId)?.uploadToken ?? null,
  };
}

/**
 * Sends an answer to an optional question whose turn ended as a new message on the thread's
 * own model and modes, through the shared send engine. Rejects when the node refuses it.
 */
export async function sendOptionalAnswerFromWeb(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Thread;
  readonly userInput: PendingUserInput;
  readonly answers: Record<string, string | string[]>;
  readonly attachments: readonly SendTurnDispatchAttachment[];
}): Promise<void> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) throw new Error("This environment is not connected.");
  const { thread } = input;
  await sendOptionalAnswerAsMessage({
    api,
    threadId: thread.id,
    userInput: input.userInput,
    answers: input.answers,
    attachments: input.attachments,
    thread: {
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      tokenMode: thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    },
    providerDriver: thread.session?.provider ?? null,
    assertMutationReady: captureReviewedSendReadiness(
      input.environmentId,
      () => readEnvironmentConnection(input.environmentId),
      "The connection changed. Reconnect and send the answer again; your draft is kept.",
    ),
    newCommandId,
    newMessageId,
  });
}
