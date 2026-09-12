import {
  FileAttachmentCreateUploadUrlError,
  type FileAttachmentCreateUploadUrlInput,
  type FileAttachmentCreateUploadUrlResult,
  ThreadId,
  WS_METHODS,
} from "@ryco/contracts";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { expect } from "vite-plus/test";

import { ChatAttachmentUploadError, type ChatAttachmentUploadsShape } from "../attachmentUpload.ts";
import type { WsRpcContext } from "./context.ts";
import { makeOrchestrationHandlers } from "./orchestrationRpc.ts";

const uploadsDouble: ChatAttachmentUploadsShape = {
  create: (_input) =>
    Effect.succeed({
      uploadToken: "minted-token",
      expiresAt: "2026-01-01T00:10:00.000Z",
      maxUploadBytes: 1024,
    }),
  beginUpload: () => Effect.die("not used"),
  completeUpload: () => Effect.die("not used"),
  abortUpload: () => Effect.die("not used"),
  commitAdoption: () => Effect.void,
  releaseAdoption: () => Effect.void,
  claimForAdoption: () => Effect.die("not used"),
};

const makeContext = (uploads: ChatAttachmentUploadsShape | undefined) =>
  ({
    ownerEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
    chatAttachmentUploads: uploads === undefined ? Option.none() : Option.some(uploads),
  }) as unknown as WsRpcContext;

const sampleInput: FileAttachmentCreateUploadUrlInput = {
  threadId: ThreadId.make("upload-thread"),
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
};

it.effect("forwards createFileUpload to the attachment upload registry", () =>
  Effect.gen(function* () {
    const handlers = makeOrchestrationHandlers(makeContext(uploadsDouble));
    const handler = handlers[WS_METHODS.chatAttachmentsCreateFileUpload] as (
      input: FileAttachmentCreateUploadUrlInput,
    ) => Effect.Effect<FileAttachmentCreateUploadUrlResult, FileAttachmentCreateUploadUrlError>;

    const result = yield* handler(sampleInput);
    expect(result.uploadToken).toBe("minted-token");
    expect(result.maxUploadBytes).toBe(1024);
  }),
);

it.effect("fails createFileUpload as a typed error when uploads are unavailable", () =>
  Effect.gen(function* () {
    const handlers = makeOrchestrationHandlers(makeContext(undefined));
    const handler = handlers[WS_METHODS.chatAttachmentsCreateFileUpload] as (
      input: FileAttachmentCreateUploadUrlInput,
    ) => Effect.Effect<FileAttachmentCreateUploadUrlResult, FileAttachmentCreateUploadUrlError>;

    const error = yield* handler(sampleInput).pipe(Effect.flip);
    expect(error).toBeInstanceOf(FileAttachmentCreateUploadUrlError);
    expect(error.message).toContain("not available");
  }),
);

it.effect("maps registry failures to FileAttachmentCreateUploadUrlError", () =>
  Effect.gen(function* () {
    const failingUploads: ChatAttachmentUploadsShape = {
      ...uploadsDouble,
      create: () =>
        Effect.fail(
          new ChatAttachmentUploadError({
            reason: "invalid-request",
            status: 400,
            message: "Attachment 'notes.txt' size must be between 1 and 52428800 bytes.",
          }),
        ),
    };
    const handlers = makeOrchestrationHandlers(makeContext(failingUploads));
    const handler = handlers[WS_METHODS.chatAttachmentsCreateFileUpload] as (
      input: FileAttachmentCreateUploadUrlInput,
    ) => Effect.Effect<FileAttachmentCreateUploadUrlResult, FileAttachmentCreateUploadUrlError>;

    const error = yield* handler(sampleInput).pipe(Effect.flip);
    expect(error).toBeInstanceOf(FileAttachmentCreateUploadUrlError);
    expect(error.message).toContain("size must be between");
  }),
);
