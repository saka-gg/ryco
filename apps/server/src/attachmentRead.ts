import { open } from "node:fs/promises";
import path from "node:path";
import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  ChatAttachmentReadError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ChatAttachmentReadChunkInput,
  type ChatAttachmentReadChunkResult,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { REGULAR_FILE_READ_FLAGS } from "@ryco/shared/regularFile";
import {
  attachmentIdExtensionSegment,
  isPersistableChatAttachment,
  resolveAttachmentPath,
} from "./attachmentStore.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

/** A message attachment found by its reference: where it is stored and how large it is. */
interface ResolvedAttachment {
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
}

/**
 * Reads of one attachment come as a run of chunks, several at once: the
 * message lookup that proves the attachment belongs to its message is made
 * once per run, not per chunk. Short-lived, so a deleted or reverted message
 * stops resolving soon; its file goes with it, which ends reads at once.
 */
const RESOLVED_TTL_MS = 30_000;
const RESOLVED_MAX_ENTRIES = 256;
const resolved = new Map<string, ResolvedAttachment>();

function resolvedKey(input: ChatAttachmentReadChunkInput): string {
  return JSON.stringify([input.threadId, input.messageId, input.attachmentId]);
}

const resolveAttachment = (
  input: ChatAttachmentReadChunkInput,
  deps: {
    attachmentsDir: string;
    projections: Pick<ProjectionSnapshotQueryShape, "getThreadMessageById">;
    now: () => number;
  },
) =>
  Effect.gen(function* () {
    const key = resolvedKey(input);
    const known = resolved.get(key);
    if (known && known.expiresAt > deps.now()) return known;
    if (!deps.projections.getThreadMessageById)
      return yield* new ChatAttachmentReadError({ message: "Attachment reads are unavailable." });
    const message = Option.getOrUndefined(yield* deps.projections.getThreadMessageById(input));
    const attachment = message?.attachments?.find((entry) => entry.id === input.attachmentId);
    if (!attachment || !isPersistableChatAttachment(attachment))
      return yield* new ChatAttachmentReadError({ message: "Attachment unavailable." });
    const filePath = resolveAttachmentPath({ attachmentsDir: deps.attachmentsDir, attachment });
    if (!filePath)
      return yield* new ChatAttachmentReadError({ message: "Attachment unavailable." });
    const entry: ResolvedAttachment = {
      filePath,
      sizeBytes: attachment.sizeBytes,
      expiresAt: deps.now() + RESOLVED_TTL_MS,
    };
    if (resolved.size >= RESOLVED_MAX_ENTRIES) resolved.clear();
    resolved.set(key, entry);
    return entry;
  });

async function readFileChunk(input: {
  readonly filePath: string;
  readonly offset: number;
  /** The size the file must have; undefined for a preview, whose size the file tells. */
  readonly expectedBytes: number | undefined;
}): Promise<{ readonly totalBytes: number; readonly dataBase64: string }> {
  const file = await open(input.filePath, REGULAR_FILE_READ_FLAGS);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (input.expectedBytes !== undefined && stat.size !== input.expectedBytes) ||
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
    return { totalBytes: stat.size, dataBase64: bytes.toString("base64") };
  } finally {
    await file.close();
  }
}

/**
 * Authorization comes from the RPC principal; membership comes from persisted
 * message metadata. A read with `preview` serves the image's preview of that
 * size (made now when it does not exist yet), or the original, and says which.
 */
export const readAttachmentChunk = (
  input: ChatAttachmentReadChunkInput,
  deps: {
    attachmentsDir: string;
    projections: Pick<ProjectionSnapshotQueryShape, "getThreadMessageById">;
    now?: () => number;
  },
) =>
  Effect.gen(function* () {
    const attachment = yield* resolveAttachment(input, { ...deps, now: deps.now ?? Date.now });
    const preview =
      input.preview === undefined
        ? undefined
        : yield* Effect.promise(() =>
            import("./attachmentPreview.ts").then(({ resolveAttachmentPreview }) =>
              resolveAttachmentPreview({
                attachmentsDir: deps.attachmentsDir,
                attachmentId: input.attachmentId,
                sourcePath: attachment.filePath,
                extension: attachmentIdExtensionSegment(path.basename(attachment.filePath)),
                size: input.preview!,
              }),
            ),
          );
    const chunk = yield* Effect.tryPromise({
      try: () =>
        preview?.kind === "preview"
          ? readFileChunk({
              filePath: preview.path,
              offset: input.offset,
              expectedBytes: undefined,
            })
          : readFileChunk({
              filePath: attachment.filePath,
              offset: input.offset,
              expectedBytes: attachment.sizeBytes,
            }),
      catch: () => new ChatAttachmentReadError({ message: "Attachment unavailable or changed." }),
    });
    const result: ChatAttachmentReadChunkResult = {
      offset: input.offset,
      ...chunk,
      ...(preview === undefined ? {} : { preview: preview.kind === "preview" }),
    };
    return result;
  }).pipe(
    Effect.mapError(() => new ChatAttachmentReadError({ message: "Attachment unavailable." })),
  );

/** For tests: forget resolved attachments. */
export function resetResolvedAttachmentsForTests(): void {
  resolved.clear();
}
