import { Cause, Context, Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import {
  type ClientOrchestrationCommand,
  DEFAULT_PROJECT_METADATA_DIR,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectMetadataDir,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatAttachment,
  type UploadChatFileAttachment,
  type UploadChatImageAttachment,
} from "@ryco/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { probeAttachmentMediaDimensions } from "../attachmentMedia.ts";
import { ChatAttachmentUploads } from "../attachmentUpload.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";

// A replay must not release a reservation acquired by an earlier accepted or
// still-running attempt with the same command ID.
class AttachmentAdoptionAttempt extends Context.Service<
  AttachmentAdoptionAttempt,
  { readonly id: symbol }
>()("ryco/attachments/AdoptionAttempt") {}

function isKnownUploadAttachment(
  attachment: UploadChatAttachment,
): attachment is UploadChatImageAttachment | UploadChatFileAttachment {
  return attachment.type === "image" || attachment.type === "file";
}

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;
    const workspacePaths = yield* WorkspacePaths;
    // Optional so deployments without the streaming-upload service keep
    // rejecting upload references instead of crashing on context resolution.
    const chatAttachmentUploads = Option.getOrUndefined(
      yield* Effect.serviceOption(ChatAttachmentUploads),
    );

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspaceAccessPolicy
        .assertExistingPath({
          path: workspaceRoot,
          operation: "project workspace",
        })
        .pipe(
          Effect.flatMap((authorizedRoot) => workspacePaths.normalizeWorkspaceRoot(authorizedRoot)),
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspaceAccessPolicy
        .assertPath({
          path: workspaceRoot,
          operation: "project creation",
        })
        .pipe(
          Effect.flatMap((authorizedRoot) =>
            workspacePaths.normalizeWorkspaceRoot(authorizedRoot, {
              createIfMissing: createIfMissing === true,
            }),
          ),
          Effect.flatMap((normalizedRoot) =>
            workspaceAccessPolicy.assertExistingPath({
              path: normalizedRoot,
              operation: "project creation",
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    const normalizeProjectMetadataDir = (projectMetadataDir: string | undefined) =>
      Effect.try({
        try: () =>
          Schema.decodeUnknownSync(ProjectMetadataDir)(
            (projectMetadataDir ?? DEFAULT_PROJECT_METADATA_DIR).trim(),
          ),
        catch: () =>
          new OrchestrationDispatchCommandError({
            message: "Project metadata directory must be a relative path inside the project root.",
          }),
      });

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing,
        ),
        projectMetadataDir: yield* normalizeProjectMetadataDir(command.projectMetadataDir),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update") {
      return {
        ...command,
        ...(command.workspaceRoot !== undefined
          ? { workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot) }
          : {}),
        ...(command.projectMetadataDir !== undefined
          ? { projectMetadataDir: yield* normalizeProjectMetadataDir(command.projectMetadataDir) }
          : {}),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start" && command.type !== "thread.turn.steer") {
      return command as OrchestrationCommand;
    }

    const adoptionAttempt = Option.getOrUndefined(
      yield* Effect.serviceOption(AttachmentAdoptionAttempt),
    );
    const preparedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!isKnownUploadAttachment(attachment)) {
            return { kind: "passthrough" as const, attachment };
          }
          if (attachment.type === "file" && attachment.uploadToken !== undefined) {
            if (!chatAttachmentUploads) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' uses an upload reference, which this server does not support.`,
              });
            }
            const adopted = yield* chatAttachmentUploads
              .claimForAdoption({
                uploadToken: attachment.uploadToken,
                commandId: command.commandId,
                attemptId: adoptionAttempt?.id,
                threadId: command.threadId,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationDispatchCommandError({
                      message: cause.message,
                    }),
                ),
              );
            const persistedAttachment = {
              type: "file" as const,
              id: adopted.attachmentId,
              name: attachment.name,
              mimeType: attachment.mimeType.toLowerCase(),
              sizeBytes: attachment.sizeBytes,
              ...(adopted.width !== undefined ? { width: adopted.width } : {}),
              ...(adopted.height !== undefined ? { height: adopted.height } : {}),
            };
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: persistedAttachment,
            });
            if (!attachmentPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Failed to resolve persisted path for '${attachment.name}'.`,
              });
            }
            const fileInfo = yield* fileSystem
              .stat(attachmentPath)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (
              !fileInfo ||
              fileInfo.type !== "File" ||
              fileInfo.size !== BigInt(attachment.sizeBytes)
            ) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' is missing or incomplete on the server; attach it again.`,
              });
            }
            return {
              kind: "adopted" as const,
              attachment: persistedAttachment,
              attachmentPath,
              byteCount: attachment.sizeBytes,
            };
          }
          const dataUrl = attachment.dataUrl;
          if (dataUrl === undefined) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' must include inline attachment data.`,
            });
          }
          const parsed = parseBase64DataUrl(dataUrl);
          if (!parsed) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' must use a valid base64 data URL.`,
            });
          }

          const normalizedMimeType = parsed.mimeType.toLowerCase();
          if (normalizedMimeType !== attachment.mimeType.toLowerCase()) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' declares '${attachment.mimeType}' but its payload is '${parsed.mimeType}'.`,
            });
          }
          if (attachment.type === "image" && !normalizedMimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' must use an image MIME type.`,
            });
          }

          const normalizedBase64 = parsed.base64.replace(/\s+/g, "");
          const bytes = Buffer.from(normalizedBase64, "base64");
          if (
            bytes.byteLength === 0 ||
            bytes.toString("base64") !== normalizedBase64 ||
            bytes.byteLength !== attachment.sizeBytes
          ) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' has invalid base64 data or mismatched size metadata.`,
            });
          }
          const attachmentLimit =
            attachment.type === "image"
              ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
              : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
          if (bytes.byteLength > attachmentLimit) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is ${bytes.byteLength} bytes; limit is ${attachmentLimit} bytes.`,
            });
          }

          const attachmentId = createAttachmentId(command.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: attachment.type,
            id: attachmentId,
            name: attachment.name,
            mimeType: normalizedMimeType,
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          return {
            kind: "prepared" as const,
            attachment: persistedAttachment,
            attachmentPath,
            bytes,
          };
        }),
      { concurrency: 1 },
    );

    const totalAttachmentBytes = preparedAttachments.reduce(
      (total, prepared) =>
        total +
        (prepared.kind === "prepared"
          ? prepared.bytes.byteLength
          : prepared.kind === "adopted"
            ? prepared.byteCount
            : 0),
      0,
    );
    if (totalAttachmentBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
      return yield* new OrchestrationDispatchCommandError({
        message: `Attachments total ${totalAttachmentBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
      });
    }

    yield* Effect.forEach(
      preparedAttachments,
      (prepared) =>
        prepared.kind === "prepared"
          ? fileSystem
              .makeDirectory(path.dirname(prepared.attachmentPath), { recursive: true })
              .pipe(
                Effect.mapError(
                  () =>
                    new OrchestrationDispatchCommandError({
                      message: `Failed to create attachment directory for '${prepared.attachment.name}'.`,
                    }),
                ),
                Effect.andThen(
                  fileSystem.writeFile(prepared.attachmentPath, prepared.bytes).pipe(
                    Effect.mapError(
                      () =>
                        new OrchestrationDispatchCommandError({
                          message: `Failed to persist attachment '${prepared.attachment.name}'.`,
                        }),
                    ),
                  ),
                ),
              )
          : Effect.void,
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.onError(() =>
        Effect.forEach(
          preparedAttachments,
          (prepared) =>
            prepared.kind === "prepared"
              ? fileSystem.remove(prepared.attachmentPath).pipe(Effect.ignore)
              : Effect.void,
          { concurrency: 1, discard: true },
        ),
      ),
    );

    const normalizedAttachments = yield* Effect.forEach(
      preparedAttachments,
      (prepared) =>
        prepared.kind === "prepared"
          ? probeAttachmentMediaDimensions(
              prepared.attachmentPath,
              prepared.attachment.mimeType,
            ).pipe(
              Effect.map((dimensions) =>
                dimensions
                  ? {
                      ...prepared.attachment,
                      width: dimensions.width,
                      height: dimensions.height,
                    }
                  : prepared.attachment,
              ),
            )
          : Effect.succeed(prepared.attachment),
      { concurrency: 1 },
    );

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

/** Keep streamed upload reservations until dispatch has a definitive result.
 * This wraps both normalization and dispatch: a later invalid attachment or a
 * rejected command must release earlier claims, while a committed command keeps
 * them. An identical command can replay its claims before receipt deduplication.
 * Interrupted callers retain claims: the engine may still commit their command.
 * Do not make dispatch uninterruptible; shutdown must remain able to stop callers.
 */
export function withChatAttachmentAdoption<A, E, R>(
  command: ClientOrchestrationCommand,
  dispatch: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const tokens =
    command.type === "thread.turn.start" || command.type === "thread.turn.steer"
      ? command.message.attachments.flatMap((attachment) =>
          isKnownUploadAttachment(attachment) &&
          attachment.type === "file" &&
          attachment.uploadToken !== undefined
            ? [attachment.uploadToken]
            : [],
        )
      : [];
  if (tokens.length === 0) return dispatch;
  return Effect.gen(function* () {
    const uploads = Option.getOrUndefined(yield* Effect.serviceOption(ChatAttachmentUploads));
    if (!uploads) return yield* dispatch;
    const attemptId = Symbol("attachment-adoption");
    return yield* dispatch.pipe(
      Effect.provideService(AttachmentAdoptionAttempt, { id: attemptId }),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
          ? Effect.void
          : Effect.forEach(
              tokens,
              (uploadToken) =>
                (Exit.isSuccess(exit) ? uploads.commitAdoption : uploads.releaseAdoption)({
                  uploadToken,
                  commandId: command.commandId,
                  attemptId,
                }),
              { discard: true },
            ),
      ),
    );
  });
}
