import { randomBytes } from "node:crypto";

import {
  FileAttachmentCreateUploadUrlError,
  type FileAttachmentCreateUploadUrlInput,
  type FileAttachmentCreateUploadUrlResult,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@ryco/contracts";
import { Context, Data, Effect, Layer } from "effect";

import type { AttachmentMediaDimensions } from "./attachmentMedia.ts";
import { createFileAttachmentId } from "./attachmentStore.ts";
import { ServerConfig } from "./config.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";

const DEFAULT_UPLOAD_TTL_MS = 10 * 60 * 1000;
const UPLOAD_TOKEN_RANDOM_BYTES = 32;

type UploadState = "pending" | "uploading" | "uploaded" | "adopted";

interface UploadEntry {
  uploadToken: string;
  threadId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  expiresAtMs: number;
  state: UploadState;
  attachmentId: string | null;
  adoptedBy: string | null;
  adoptionAttempts: Set<symbol>;
  adoptionCommitted: boolean;
  mediaDimensions: AttachmentMediaDimensions | null;
}

export interface ChatAttachmentUploadLease {
  readonly uploadToken: string;
  readonly threadId: string;
  readonly attachmentId: string;
  readonly partPath: string;
  readonly finalPath: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;
}

export interface AdoptedChatAttachmentUpload {
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width?: number;
  readonly height?: number;
}

export class ChatAttachmentUploadError extends Data.TaggedError("ChatAttachmentUploadError")<{
  readonly reason:
    | "invalid-token"
    | "invalid-request"
    | "expired"
    | "already-used"
    | "attachment-id";
  readonly status: number;
  readonly message: string;
}> {}

export interface ChatAttachmentUploadsShape {
  readonly create: (
    input: FileAttachmentCreateUploadUrlInput,
  ) => Effect.Effect<FileAttachmentCreateUploadUrlResult, ChatAttachmentUploadError>;
  readonly beginUpload: (
    uploadToken: string,
  ) => Effect.Effect<ChatAttachmentUploadLease, ChatAttachmentUploadError>;
  readonly completeUpload: (
    uploadToken: string,
    mediaDimensions?: AttachmentMediaDimensions | null,
  ) => Effect.Effect<void, ChatAttachmentUploadError>;
  readonly abortUpload: (uploadToken: string) => Effect.Effect<void>;
  readonly commitAdoption: (input: {
    readonly uploadToken: string;
    readonly commandId: string;
    readonly attemptId: symbol;
  }) => Effect.Effect<void>;
  readonly releaseAdoption: (input: {
    readonly uploadToken: string;
    readonly commandId: string;
    readonly attemptId: symbol;
  }) => Effect.Effect<void>;
  readonly claimForAdoption: (input: {
    readonly uploadToken: string;
    readonly commandId: string;
    readonly attemptId?: symbol | undefined;
    readonly threadId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }) => Effect.Effect<AdoptedChatAttachmentUpload, ChatAttachmentUploadError>;
}

export class ChatAttachmentUploads extends Context.Service<
  ChatAttachmentUploads,
  ChatAttachmentUploadsShape
>()("ryco/attachments/ChatAttachmentUploads") {}

const makeUploadToken = () => randomBytes(UPLOAD_TOKEN_RANDOM_BYTES).toString("base64url");

export const makeChatAttachmentUploads = (options: {
  readonly attachmentsDir: string;
  readonly ttlMs?: number;
}) =>
  Effect.sync(() => {
    const ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;
    const entries = new Map<string, UploadEntry>();

    const pruneExpired = (nowMs: number) => {
      for (const [token, entry] of entries) {
        // In-flight uploads must survive a concurrent lazy prune; they end in
        // completeUpload or abortUpload.
        if (nowMs >= entry.expiresAtMs && entry.state !== "uploading") {
          entries.delete(token);
        }
      }
    };

    const beginUpload: ChatAttachmentUploadsShape["beginUpload"] = (uploadToken) =>
      Effect.gen(function* () {
        const nowMs = Date.now();
        pruneExpired(nowMs);
        const entry = entries.get(uploadToken);
        if (!entry) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-token",
              status: 400,
              message: "Unknown file upload token.",
            }),
          );
        }
        if (nowMs >= entry.expiresAtMs) {
          entries.delete(uploadToken);
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "expired",
              status: 410,
              message: "File upload token has expired.",
            }),
          );
        }
        if (entry.state !== "pending") {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "already-used",
              status: 409,
              message: "File upload token has already been used.",
            }),
          );
        }
        const attachmentId = createFileAttachmentId(entry.threadId, entry.name);
        if (!attachmentId) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "attachment-id",
              status: 400,
              message: "Failed to create a safe attachment id for the upload.",
            }),
          );
        }
        const finalPath = resolveAttachmentRelativePath({
          attachmentsDir: options.attachmentsDir,
          relativePath: attachmentId,
        });
        if (!finalPath) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "attachment-id",
              status: 400,
              message: "Failed to resolve a safe attachment path for the upload.",
            }),
          );
        }
        entry.state = "uploading";
        entry.attachmentId = attachmentId;
        return {
          uploadToken,
          threadId: entry.threadId,
          attachmentId,
          partPath: `${finalPath}.part`,
          finalPath,
          name: entry.name,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          maxBytes: Math.min(entry.sizeBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES),
        } satisfies ChatAttachmentUploadLease;
      });

    const completeUpload: ChatAttachmentUploadsShape["completeUpload"] = (
      uploadToken,
      mediaDimensions,
    ) =>
      Effect.gen(function* () {
        const entry = entries.get(uploadToken);
        if (!entry || entry.state !== "uploading" || entry.attachmentId === null) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-token",
              status: 409,
              message: "File upload token is not awaiting completion.",
            }),
          );
        }
        entry.state = "uploaded";
        entry.mediaDimensions = mediaDimensions ?? null;
      });

    const abortUpload: ChatAttachmentUploadsShape["abortUpload"] = (uploadToken) =>
      Effect.sync(() => {
        const entry = entries.get(uploadToken);
        if (entry && entry.state === "uploading") {
          entries.delete(uploadToken);
        }
      });

    const claimForAdoption: ChatAttachmentUploadsShape["claimForAdoption"] = (input) =>
      Effect.gen(function* () {
        const nowMs = Date.now();
        pruneExpired(nowMs);
        const entry = entries.get(input.uploadToken);
        if (!entry) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-token",
              status: 400,
              message: `Attachment '${input.name}' references an unknown or already-used file upload.`,
            }),
          );
        }
        if (nowMs >= entry.expiresAtMs) {
          entries.delete(input.uploadToken);
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "expired",
              status: 410,
              message: `Attachment '${input.name}' references an expired file upload.`,
            }),
          );
        }
        if (
          entry.state !== "uploaded" &&
          !(entry.state === "adopted" && entry.adoptedBy === input.commandId)
        ) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "already-used",
              status: 409,
              message: `Attachment '${input.name}' references a file upload that is not complete.`,
            }),
          );
        }
        if (
          entry.threadId !== input.threadId ||
          entry.name !== input.name ||
          entry.mimeType.toLowerCase() !== input.mimeType.toLowerCase() ||
          entry.sizeBytes !== input.sizeBytes
        ) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-request",
              status: 400,
              message: `Attachment '${input.name}' does not match its file upload registration.`,
            }),
          );
        }
        if (entry.attachmentId === null) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-token",
              status: 400,
              message: `Attachment '${input.name}' references a file upload without a stored file.`,
            }),
          );
        }
        if (entry.state === "uploaded") {
          entry.state = "adopted";
          entry.adoptedBy = input.commandId;
        }
        // Every overlapping replay owns a reservation until it settles. A commit
        // permanently pins ownership even if an earlier attempt later fails.
        if (input.attemptId === undefined) entry.adoptionCommitted = true;
        else entry.adoptionAttempts.add(input.attemptId);
        return {
          attachmentId: entry.attachmentId,
          name: entry.name,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          ...(entry.mediaDimensions
            ? {
                width: entry.mediaDimensions.width,
                height: entry.mediaDimensions.height,
              }
            : {}),
        } satisfies AdoptedChatAttachmentUpload;
      });

    const create: ChatAttachmentUploadsShape["create"] = (input) =>
      Effect.gen(function* () {
        const nowMs = Date.now();
        pruneExpired(nowMs);
        if (
          !Number.isSafeInteger(input.sizeBytes) ||
          input.sizeBytes <= 0 ||
          input.sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES
        ) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-request",
              status: 400,
              message: `Attachment '${input.name}' size must be between 1 and ${PROVIDER_SEND_TURN_MAX_FILE_BYTES} bytes.`,
            }),
          );
        }
        const uploadToken = makeUploadToken();
        entries.set(uploadToken, {
          uploadToken,
          threadId: input.threadId,
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          expiresAtMs: nowMs + ttlMs,
          state: "pending",
          attachmentId: null,
          adoptedBy: null,
          adoptionAttempts: new Set(),
          adoptionCommitted: false,
          mediaDimensions: null,
        });
        return {
          uploadToken,
          expiresAt: new Date(nowMs + ttlMs).toISOString(),
          maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        } satisfies FileAttachmentCreateUploadUrlResult;
      });

    return {
      create,
      beginUpload,
      completeUpload,
      abortUpload,
      claimForAdoption,
      commitAdoption: (input) =>
        Effect.sync(() => {
          const entry = entries.get(input.uploadToken);
          if (
            entry?.state === "adopted" &&
            entry.adoptedBy === input.commandId &&
            entry.adoptionAttempts.delete(input.attemptId)
          ) {
            entry.adoptionCommitted = true;
          }
        }),
      releaseAdoption: (input) =>
        Effect.sync(() => {
          const entry = entries.get(input.uploadToken);
          if (
            entry?.state === "adopted" &&
            entry.adoptedBy === input.commandId &&
            entry.adoptionAttempts.delete(input.attemptId) &&
            entry.adoptionAttempts.size === 0 &&
            !entry.adoptionCommitted
          ) {
            entry.state = "uploaded";
            entry.adoptedBy = null;
          }
        }),
    } satisfies ChatAttachmentUploadsShape;
  });

export const ChatAttachmentUploadsLive = Layer.effect(
  ChatAttachmentUploads,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeChatAttachmentUploads({ attachmentsDir: config.attachmentsDir });
  }),
);

export const toFileAttachmentCreateUploadUrlError = (error: ChatAttachmentUploadError) =>
  new FileAttachmentCreateUploadUrlError({ message: error.message });
