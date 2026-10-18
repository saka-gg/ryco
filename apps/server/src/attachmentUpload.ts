import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

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
import { taskFileSegment } from "./tasks/taskFiles.ts";

const DEFAULT_UPLOAD_TTL_MS = 10 * 60 * 1000;
const UPLOAD_TOKEN_RANDOM_BYTES = 32;

type UploadState = "pending" | "uploading" | "uploaded" | "adopted";

/**
 * What an upload is for. A chat upload is adopted by one turn command of its thread; a task
 * upload is claimed by its task (`claimForTask`) and can never be adopted into a chat command,
 * because task files are owner-only and live outside the chat attachment store.
 */
export type ChatAttachmentUploadScope =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "task"; readonly taskId: string };

interface UploadEntry {
  uploadToken: string;
  scope: ChatAttachmentUploadScope;
  name: string;
  mimeType: string;
  sizeBytes: number;
  expiresAtMs: number;
  state: UploadState;
  attachmentId: string | null;
  /** Set once the file is in place under `attachmentId`, so an expired task upload can be deleted. */
  finalPath: string | null;
  adoptedBy: string | null;
  adoptionAttempts: Set<symbol>;
  adoptionCommitted: boolean;
  mediaDimensions: AttachmentMediaDimensions | null;
}

export interface ChatAttachmentUploadLease {
  readonly uploadToken: string;
  readonly scope: ChatAttachmentUploadScope;
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
  /** Mints a token for one task file; its bytes land in the task-file store. */
  readonly createForTask: (input: {
    readonly taskId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }) => Effect.Effect<FileAttachmentCreateUploadUrlResult, ChatAttachmentUploadError>;
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
  /**
   * Hands a completed task upload to its task. Claiming it again for the same task returns the
   * same file (a retried add); any other claim fails.
   */
  readonly claimForTask: (input: {
    readonly uploadToken: string;
    readonly taskId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }) => Effect.Effect<AdoptedChatAttachmentUpload, ChatAttachmentUploadError>;
  /**
   * Hands a task's claim back when its add failed: the upload is unclaimed again, so the same
   * token can claim it for a retry, and its file is deleted once the token expires unclaimed.
   * Only for a claim no task references; a claim of another task (or none) is left alone.
   */
  readonly releaseTaskClaim: (input: {
    readonly uploadToken: string;
    readonly taskId: string;
  }) => Effect.Effect<void>;
}

export class ChatAttachmentUploads extends Context.Service<
  ChatAttachmentUploads,
  ChatAttachmentUploadsShape
>()("ryco/attachments/ChatAttachmentUploads") {}

const makeUploadToken = () => randomBytes(UPLOAD_TOKEN_RANDOM_BYTES).toString("base64url");

export const makeChatAttachmentUploads = (options: {
  readonly attachmentsDir: string;
  /** Where task uploads land; without it task uploads are refused. */
  readonly taskFilesDir?: string;
  readonly ttlMs?: number;
}) =>
  Effect.sync(() => {
    const ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;
    const entries = new Map<string, UploadEntry>();

    // A task upload nobody claimed before its token expired is referenced by no task: delete its
    // file. A chat upload's file stays; the chat attachment store owns its cleanup.
    const forget = (token: string, entry: UploadEntry) => {
      entries.delete(token);
      return entry.scope.kind === "task" && entry.state === "uploaded" && entry.finalPath !== null
        ? [entry.finalPath]
        : [];
    };
    const deleteFiles = (paths: ReadonlyArray<string>) =>
      paths.length === 0
        ? Effect.void
        : Effect.forEach(
            paths,
            (filePath) =>
              Effect.tryPromise(() => rm(filePath, { force: true })).pipe(Effect.ignore),
            { discard: true },
          );
    const pruneExpired = (nowMs: number) => {
      const orphans: string[] = [];
      for (const [token, entry] of entries) {
        // In-flight uploads must survive a concurrent lazy prune; they end in
        // completeUpload or abortUpload.
        if (nowMs >= entry.expiresAtMs && entry.state !== "uploading") {
          orphans.push(...forget(token, entry));
        }
      }
      return deleteFiles(orphans);
    };
    const expired = (token: string, entry: UploadEntry, message: string) =>
      deleteFiles(forget(token, entry)).pipe(
        Effect.andThen(
          Effect.fail(new ChatAttachmentUploadError({ reason: "expired", status: 410, message })),
        ),
      );

    const beginUpload: ChatAttachmentUploadsShape["beginUpload"] = (uploadToken) =>
      Effect.gen(function* () {
        const nowMs = Date.now();
        yield* pruneExpired(nowMs);
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
          return yield* expired(uploadToken, entry, "File upload token has expired.");
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
        const scope = entry.scope;
        const attachmentId = createFileAttachmentId(
          scope.kind === "thread" ? scope.threadId : taskFileSegment(scope.taskId),
          entry.name,
        );
        const directory = scope.kind === "thread" ? options.attachmentsDir : options.taskFilesDir;
        if (!attachmentId || directory === undefined) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "attachment-id",
              status: 400,
              message: "Failed to create a safe attachment id for the upload.",
            }),
          );
        }
        const finalPath = resolveAttachmentRelativePath({
          attachmentsDir: directory,
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
        entry.finalPath = finalPath;
        return {
          uploadToken,
          scope,
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
        yield* pruneExpired(nowMs);
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
          return yield* expired(
            input.uploadToken,
            entry,
            `Attachment '${input.name}' references an expired file upload.`,
          );
        }
        if (entry.scope.kind !== "thread") {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-request",
              status: 400,
              message: `Attachment '${input.name}' references a task file upload, not a chat upload.`,
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
          entry.scope.threadId !== input.threadId ||
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

    const register = (
      scope: ChatAttachmentUploadScope,
      input: { readonly name: string; readonly mimeType: string; readonly sizeBytes: number },
    ) =>
      Effect.gen(function* () {
        const nowMs = Date.now();
        yield* pruneExpired(nowMs);
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
          scope,
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          expiresAtMs: nowMs + ttlMs,
          state: "pending",
          attachmentId: null,
          finalPath: null,
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

    const create: ChatAttachmentUploadsShape["create"] = (input) =>
      register({ kind: "thread", threadId: input.threadId }, input);

    const createForTask: ChatAttachmentUploadsShape["createForTask"] = (input) =>
      options.taskFilesDir === undefined
        ? Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-request",
              status: 400,
              message: "Task file uploads are not available on this server.",
            }),
          )
        : register({ kind: "task", taskId: input.taskId }, input);

    const claimForTask: ChatAttachmentUploadsShape["claimForTask"] = (input) =>
      Effect.gen(function* () {
        const nowMs = Date.now();
        yield* pruneExpired(nowMs);
        const entry = entries.get(input.uploadToken);
        if (!entry) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-token",
              status: 400,
              message: `File '${input.name}' references an unknown or expired upload.`,
            }),
          );
        }
        if (nowMs >= entry.expiresAtMs) {
          return yield* expired(
            input.uploadToken,
            entry,
            `File '${input.name}' references an expired upload.`,
          );
        }
        const claimedBy = `task:${input.taskId}`;
        if (
          entry.scope.kind !== "task" ||
          entry.scope.taskId !== input.taskId ||
          entry.name !== input.name ||
          entry.mimeType.toLowerCase() !== input.mimeType.toLowerCase() ||
          entry.sizeBytes !== input.sizeBytes
        ) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "invalid-request",
              status: 400,
              message: `File '${input.name}' does not match its upload registration.`,
            }),
          );
        }
        if (
          entry.attachmentId === null ||
          (entry.state !== "uploaded" &&
            !(entry.state === "adopted" && entry.adoptedBy === claimedBy))
        ) {
          return yield* Effect.fail(
            new ChatAttachmentUploadError({
              reason: "already-used",
              status: 409,
              message: `File '${input.name}' references an upload that is not complete.`,
            }),
          );
        }
        entry.state = "adopted";
        entry.adoptedBy = claimedBy;
        entry.adoptionCommitted = true;
        return {
          attachmentId: entry.attachmentId,
          name: entry.name,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          ...(entry.mediaDimensions
            ? { width: entry.mediaDimensions.width, height: entry.mediaDimensions.height }
            : {}),
        } satisfies AdoptedChatAttachmentUpload;
      });

    return {
      create,
      createForTask,
      beginUpload,
      completeUpload,
      abortUpload,
      claimForAdoption,
      claimForTask,
      releaseTaskClaim: (input) =>
        Effect.sync(() => {
          const entry = entries.get(input.uploadToken);
          if (entry?.state === "adopted" && entry.adoptedBy === `task:${input.taskId}`) {
            entry.state = "uploaded";
            entry.adoptedBy = null;
            entry.adoptionCommitted = false;
          }
        }),
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
    return yield* makeChatAttachmentUploads({
      attachmentsDir: config.attachmentsDir,
      taskFilesDir: config.taskFilesDir,
    });
  }),
);

export const toFileAttachmentCreateUploadUrlError = (error: ChatAttachmentUploadError) =>
  new FileAttachmentCreateUploadUrlError({ message: error.message });
