import { Cause, Context, Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import {
  type ClientOrchestrationCommand,
  DEFAULT_PROJECT_METADATA_DIR,
  type MessageId,
  type ThreadId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectMetadataDir,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  SERVER_MINTED_MESSAGE_ID_PREFIXES,
  type UploadChatAttachment,
  type UploadChatFileAttachment,
  type UploadChatImageAttachment,
} from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";

import {
  createAttachmentId,
  decodeUploadAttachmentDataUrl,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { probeAttachmentMediaDimensions } from "../attachmentMedia.ts";
import { ChatAttachmentUploads } from "../attachmentUpload.ts";
import { ServerConfig } from "../config.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

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

/** The id a command gives a new message: a turn start's, a steer's or a queued follow-up's. */
const newMessageIdOf = (command: OrchestrationCommand): string | null => {
  switch (command.type) {
    case "thread.turn.start":
    case "thread.turn.steer":
      return command.message.messageId;
    case "thread.queue.add":
      return command.entry.messageId;
    default:
      return null;
  }
};

/**
 * A person's turn start, steer or queued follow-up may not use an id the server mints for
 * messages nobody typed (`SERVER_MINTED_MESSAGE_ID_PREFIXES`): clients show those as another
 * agent's message or a delegated result, and a queued entry is sent under its own id. Checked
 * where a client's command enters, not here, because the server's own wakes pass through this
 * normalizer too.
 */
export const refuseServerMintedMessageId = (
  command: OrchestrationCommand,
): Effect.Effect<void, OrchestrationDispatchCommandError> => {
  const messageId = newMessageIdOf(command);
  return messageId !== null &&
    SERVER_MINTED_MESSAGE_ID_PREFIXES.some((prefix) => messageId.startsWith(prefix))
    ? Effect.fail(
        new OrchestrationDispatchCommandError({
          message: "This message id is reserved for messages Ryco sends.",
        }),
      )
    : Effect.void;
};

/**
 * The attachments a client command uploads: a turn start's or steer's message, and a queued
 * follow-up's (`thread.queue.add`, `thread.queue.edit`). All are stored the same way, so a
 * queued entry holds attachment ids like a sent message.
 */
type UploadingCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.turn.start" | "thread.turn.steer" | "thread.queue.add" | "thread.queue.edit" }
>;

const isUploadingCommand = (command: ClientOrchestrationCommand): command is UploadingCommand =>
  command.type === "thread.turn.start" ||
  command.type === "thread.turn.steer" ||
  command.type === "thread.queue.add" ||
  command.type === "thread.queue.edit";

function uploadAttachmentsOf(command: UploadingCommand): ReadonlyArray<UploadChatAttachment> {
  switch (command.type) {
    case "thread.queue.add":
      return command.entry.attachments;
    case "thread.queue.edit":
      return command.attachments;
    default:
      return command.message.attachments;
  }
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

    // Project kind is server-owned: chats are created by the first-send bootstrap inside the
    // chats root and become projects only through promotion, which also moves their folder.
    // Both dispatch server-internally and never pass through this client normalization.
    if (command.type === "project.create") {
      if (command.kind === "chat") {
        return yield* new OrchestrationDispatchCommandError({
          message:
            "A chat without a project is created by sending its first message, not as a project.",
        });
      }
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
      if (command.kind !== undefined) {
        return yield* new OrchestrationDispatchCommandError({
          message:
            "A project's kind cannot be changed directly. Turn the chat into a project instead.",
        });
      }
      const workspaceRoot =
        command.workspaceRoot === undefined
          ? undefined
          : yield* normalizeProjectWorkspaceRoot(command.workspaceRoot);
      if (workspaceRoot !== undefined) {
        const project = yield* (yield* ProjectionSnapshotQuery)
          .getProjectShellById(command.projectId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "Failed to read the project before changing its folder.",
                  cause,
                }),
            ),
          );
        if (
          Option.isSome(project) &&
          isChatProject(project.value) &&
          project.value.workspaceRoot !== workspaceRoot
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: "A chat's folder moves only when the chat is turned into a project.",
          });
        }
      }
      return {
        ...command,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(command.projectMetadataDir !== undefined
          ? { projectMetadataDir: yield* normalizeProjectMetadataDir(command.projectMetadataDir) }
          : {}),
      } satisfies OrchestrationCommand;
    }

    if (!isUploadingCommand(command)) {
      return command as OrchestrationCommand;
    }
    const uploads = uploadAttachmentsOf(command);
    // A follow-up already sent as a message is a no-op add: its attachments are not stored again.
    if (command.type === "thread.queue.add") {
      const sent = yield* alreadySentMessage(command.threadId, command.entry.messageId);
      if (sent) {
        return {
          ...command,
          entry: { ...command.entry, attachments: [] },
          alreadySent: true,
        } satisfies OrchestrationCommand;
      }
    }

    const adoptionAttempt = Option.getOrUndefined(
      yield* Effect.serviceOption(AttachmentAdoptionAttempt),
    );
    const preparedAttachments = yield* Effect.forEach(
      uploads,
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
          const decoded = decodeUploadAttachmentDataUrl({
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl,
          });
          if (!decoded.ok) {
            return yield* new OrchestrationDispatchCommandError({ message: decoded.message });
          }
          const { bytes, mimeType: normalizedMimeType } = decoded;

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

    switch (command.type) {
      case "thread.queue.add":
        return {
          ...command,
          entry: { ...command.entry, attachments: normalizedAttachments },
        } satisfies OrchestrationCommand;
      case "thread.queue.edit":
        return { ...command, attachments: normalizedAttachments } satisfies OrchestrationCommand;
      default:
        return {
          ...command,
          message: {
            ...command.message,
            attachments: normalizedAttachments,
          },
        } satisfies OrchestrationCommand;
    }
  });

/**
 * Whether `messageId` is already a message of the thread. The decider's command model keeps only
 * the thread's user-message anchors from before the server started, so an add of a follow-up
 * sent before then is recognised here.
 */
const alreadySentMessage = (threadId: ThreadId, messageId: MessageId) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    if (query.getThreadMessageById === undefined) return false;
    const message = yield* query.getThreadMessageById({ threadId, messageId }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to read the thread before queuing the follow-up.",
            cause,
          }),
      ),
    );
    return Option.isSome(message);
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
  const tokens = (isUploadingCommand(command) ? uploadAttachmentsOf(command) : []).flatMap(
    (attachment) =>
      isKnownUploadAttachment(attachment) &&
      attachment.type === "file" &&
      attachment.uploadToken !== undefined
        ? [attachment.uploadToken]
        : [],
  );
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
