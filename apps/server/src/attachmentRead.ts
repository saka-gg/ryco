import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  ChatAttachmentReadError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ChatAttachmentReadChunkInput,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { isPersistableChatAttachment, resolveAttachmentPath } from "./attachmentStore.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

/** Authorization comes from the RPC principal; membership comes from persisted message metadata. */
export const readAttachmentChunk = (
  input: ChatAttachmentReadChunkInput,
  deps: {
    attachmentsDir: string;
    projections: Pick<ProjectionSnapshotQueryShape, "getThreadMessageById">;
  },
) =>
  Effect.gen(function* () {
    if (!deps.projections.getThreadMessageById)
      return yield* new ChatAttachmentReadError({ message: "Attachment reads are unavailable." });
    const message = Option.getOrUndefined(yield* deps.projections.getThreadMessageById(input));
    const attachment = message?.attachments?.find((entry) => entry.id === input.attachmentId);
    if (!attachment || !isPersistableChatAttachment(attachment))
      return yield* new ChatAttachmentReadError({ message: "Attachment unavailable." });
    const filePath = resolveAttachmentPath({ attachmentsDir: deps.attachmentsDir, attachment });
    if (!filePath)
      return yield* new ChatAttachmentReadError({ message: "Attachment unavailable." });
    return yield* Effect.tryPromise({
      try: async () => {
        const file = await open(
          filePath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.size !== attachment.sizeBytes ||
            stat.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
            input.offset < 0 ||
            input.offset >= stat.size
          )
            throw new Error();
          const bytes = Buffer.alloc(
            Math.min(CHAT_ATTACHMENT_READ_CHUNK_BYTES, stat.size - input.offset),
          );
          const { bytesRead } = await file.read(bytes, 0, bytes.length, input.offset);
          if (bytesRead !== bytes.length) throw new Error();
          return {
            offset: input.offset,
            totalBytes: stat.size,
            dataBase64: bytes.toString("base64"),
          };
        } finally {
          await file.close();
        }
      },
      catch: () => new ChatAttachmentReadError({ message: "Attachment unavailable or changed." }),
    });
  }).pipe(
    Effect.mapError(() => new ChatAttachmentReadError({ message: "Attachment unavailable." })),
  );
