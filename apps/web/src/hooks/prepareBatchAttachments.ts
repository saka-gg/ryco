import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  createChatFileUploadEngine,
  buildSendTurnUploadTokenDispatchAttachment,
  type SendTurnDispatchAttachment,
} from "@ryco/client-runtime/state/composer";
import type { ComposerImageAttachment } from "../composerDraftStore";
import { webChatFileUploadTransport } from "../platform/attachmentUpload";
import { buildOutgoingTurnAttachments } from "./executeChatSendTurn";

/** Each destination owns its streamed upload tokens; the source draft keeps its tokens. */
export async function prepareBatchAttachments(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  attachments: readonly ComposerImageAttachment[];
  signal: AbortSignal;
}): Promise<readonly SendTurnDispatchAttachment[]> {
  const engine = createChatFileUploadEngine(webChatFileUploadTransport);
  try {
    return await Promise.all(
      input.attachments.map(async (attachment) => {
        if (input.signal.aborted) throw new Error("Launch cancelled.");
        if (attachment.type !== "file")
          return (await buildOutgoingTurnAttachments([attachment]))[0]!;
        if (!attachment.file)
          throw new Error(`Reattach '${attachment.name}' so each model can receive its own copy.`);
        const id = `${input.threadId}:${attachment.id}`;
        return await new Promise<SendTurnDispatchAttachment>((resolve, reject) => {
          let stop = () => {};
          const cleanup = () => {
            stop();
            input.signal.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            engine.release(id);
            reject(new Error("Launch cancelled."));
          };
          const check = () => {
            const record = engine.get(id);
            if (record?.status.kind === "uploaded") {
              cleanup();
              resolve(
                buildSendTurnUploadTokenDispatchAttachment({
                  ...attachment,
                  uploadToken: record.status.uploadToken,
                }),
              );
            } else if (
              record?.status.kind === "failed" ||
              record?.status.kind === "needsReattach"
            ) {
              cleanup();
              reject(new Error(record.status.message));
            }
          };
          stop = engine.subscribe(check);
          input.signal.addEventListener("abort", abort, { once: true });
          engine.enqueue({
            attachmentId: id,
            threadId: input.threadId,
            environmentId: input.environmentId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            readBytes: async () => new Uint8Array(await attachment.file!.arrayBuffer()),
          });
          check();
        });
      }),
    );
  } finally {
    engine.releaseAll();
  }
}
