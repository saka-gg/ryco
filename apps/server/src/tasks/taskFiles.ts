import { link, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  type ChatAttachment,
  LocalTaskError,
  type LocalTaskFile,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ryco/contracts";
import { Effect } from "effect";

import { probeAttachmentMediaDimensions } from "../attachmentMedia.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import {
  attachmentIdExtensionSegment,
  cloneAttachmentFile,
  createFileAttachmentId,
  decodeUploadAttachmentDataUrl,
  deleteThreadAttachmentFiles,
  derivedAttachmentId,
  resolveAttachmentPath,
  toSafeFileAttachmentExtensionSegment,
  toSafeThreadAttachmentSegment,
  composeAttachmentId,
  uuidFromSha256Hex,
} from "../attachmentStore.ts";
import { stageWorkspaceFile } from "../assistantAttachments.ts";
import { inferImageExtension } from "../imageMime.ts";

/**
 * Task files live in the node's task-file store (`ServerConfig.taskFilesDir`), named exactly by
 * their file id: a streamed-upload id (`task-<taskId>-<uuid>-<ext>`) whose first segment names
 * the task. Every chat started from the task gets its own private copy under the chat's
 * attachment ids (a copy-on-write clone where the filesystem has them), never a hard link: an
 * agent may edit its attachment in place, and that must not change the task's original, which
 * every later chat copies again. Deleting the task (or a file) never touches a chat, and deleting
 * or editing a chat's copy never touches the task.
 */

/** The id segment of a task's files, in place of the thread segment of chat attachments. */
export const taskFileSegment = (taskId: string) => `task-${taskId}`;

/**
 * How a chat receives the file: an image only when the provider can take it as one (an image
 * MIME type with a known image extension, within the image size limit); everything else
 * travels as a plain file. `rasterImage: false` says the bytes were read and are not a raster
 * image (a text file named `.png`), so the name and MIME type don't make it one.
 */
export function classifyTaskFile(input: {
  readonly mimeType: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly rasterImage?: boolean | undefined;
}): LocalTaskFile["type"] {
  const mimeType = input.mimeType.toLowerCase();
  if (
    input.rasterImage === false ||
    !mimeType.startsWith("image/") ||
    input.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  ) {
    return "file";
  }
  return inferImageExtension({ mimeType, fileName: input.name }) === ".bin" ? "file" : "image";
}

/** The stored record of a task file; the MIME type is lowercased like chat attachments'. */
export function toLocalTaskFile(input: {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly addedAt: string;
  readonly rasterImage?: boolean | undefined;
}): LocalTaskFile {
  const mimeType = input.mimeType.toLowerCase();
  return {
    fileId: input.fileId,
    type: classifyTaskFile({
      mimeType,
      name: input.name,
      sizeBytes: input.sizeBytes,
      rasterImage: input.rasterImage,
    }),
    name: input.name,
    mimeType,
    sizeBytes: input.sizeBytes,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    addedAt: input.addedAt,
  };
}

const invalid = (message: string) => new LocalTaskError({ reason: "invalid", message });
const storageError = (message: string) => new LocalTaskError({ reason: "persistence", message });

/** Why a workspace file couldn't be read, without the node's absolute paths. */
function workspaceFileFailure(cause: unknown): string {
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR")
    return "The file (or this thread's workspace) does not exist.";
  if (code === "EACCES" || code === "EPERM") return "The file can't be read.";
  if (code === "EISDIR") return "The path is a folder, not a file.";
  // Node's own errors name the absolute path; `stageWorkspaceFile`'s are plain sentences.
  return cause instanceof Error && cause.message && code === undefined
    ? cause.message
    : "The file could not be read from the workspace.";
}

const taskFilePath = (taskFilesDir: string, fileId: string) =>
  resolveAttachmentRelativePath({ attachmentsDir: taskFilesDir, relativePath: fileId });

/**
 * Stores an inline (`data:` URL) task file under a fresh id, validated exactly like an inline
 * chat attachment. The caller owns the file until a task references it.
 */
export const writeTaskFileFromDataUrl = (input: {
  readonly taskFilesDir: string;
  readonly taskId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}): Effect.Effect<
  { readonly fileId: string; readonly width?: number; readonly height?: number },
  LocalTaskError
> =>
  Effect.gen(function* () {
    const decoded = decodeUploadAttachmentDataUrl({ ...input, type: "file" });
    if (!decoded.ok) return yield* invalid(decoded.message);
    const fileId = createFileAttachmentId(taskFileSegment(input.taskId), input.name);
    const filePath = fileId === null ? null : taskFilePath(input.taskFilesDir, fileId);
    if (fileId === null || filePath === null)
      return yield* invalid("Failed to create a safe id for the task file.");
    yield* Effect.tryPromise({
      try: () => writeFile(filePath, decoded.bytes, { flag: "wx" }),
      catch: () => storageError(`Failed to store task file '${input.name}'.`),
    });
    const dimensions = yield* probeAttachmentMediaDimensions(filePath, decoded.mimeType);
    return dimensions ? { fileId, width: dimensions.width, height: dimensions.height } : { fileId };
  });

/**
 * Stores a regular file of a workspace (`cwd`, a relative path, the same rules as
 * `ryco_attach_file`) as a task file, under an id derived from the task, the path, the name and
 * the bytes: adding the same file again names the same task file, so a retry adds nothing twice.
 * The caller owns the file until a task references it.
 */
export const storeTaskFileFromWorkspace = (input: {
  readonly taskFilesDir: string;
  readonly taskId: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly name?: string | undefined;
}): Effect.Effect<
  {
    readonly fileId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    /** Whether the bytes are a raster image a provider takes inline (`toLocalTaskFile`). */
    readonly rasterImage: boolean;
    readonly width?: number;
    readonly height?: number;
  },
  LocalTaskError
> =>
  Effect.gen(function* () {
    const segment = toSafeThreadAttachmentSegment(taskFileSegment(input.taskId));
    // One file however the path is spelled (`a.txt`, `./a.txt`), so it names one task file.
    const relativePath = path.relative(input.cwd, path.resolve(input.cwd, input.relativePath));
    if (!segment) return yield* invalid("Failed to create a safe id for the task file.");
    const staged = yield* Effect.tryPromise({
      try: (signal) =>
        stageWorkspaceFile({
          cwd: input.cwd,
          relativePath: input.relativePath,
          name: input.name,
          stagingDir: input.taskFilesDir,
          maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
          hashSeed: (name) => JSON.stringify([input.taskId, relativePath, name]),
          signal,
        }),
      catch: (cause) => invalid(workspaceFileFailure(cause)),
    });
    const fileId = composeAttachmentId(
      segment,
      uuidFromSha256Hex(staged.contentHash),
      toSafeFileAttachmentExtensionSegment(staged.name),
    );
    const filePath = taskFilePath(input.taskFilesDir, fileId);
    yield* Effect.tryPromise({
      try: async () => {
        try {
          if (filePath === null) throw new Error("unsafe task file id");
          // Never overwrites: the same id is the same snapshot.
          await link(staged.temporary, filePath).catch((error: unknown) => {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
              throw error;
          });
        } finally {
          await rm(staged.temporary, { force: true });
        }
      },
      catch: () => storageError(`Failed to store task file '${staged.name}'.`),
    });
    const dimensions =
      filePath === null ? null : yield* probeAttachmentMediaDimensions(filePath, staged.mimeType);
    return {
      fileId,
      name: staged.name,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
      rasterImage: staged.inlineImage,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    };
  });

/** Deletes task files by id. Best effort: a missing or undeletable file is left as it is. */
export const deleteTaskFiles = (
  taskFilesDir: string,
  fileIds: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    fileIds,
    (fileId) => {
      const filePath = taskFilePath(taskFilesDir, fileId);
      return filePath === null
        ? Effect.void
        : Effect.tryPromise(() => rm(filePath, { force: true })).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to delete a task file", { fileId, cause }),
            ),
          );
    },
    { discard: true },
  );

/** The chat attachments a start carries its task files as, and which of them it wrote. */
export interface TaskFileCopies {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /**
   * The copies this call created. One that already existed (a retried start, or an earlier
   * start into the same chat, whose message may still reference it) is not listed.
   */
  readonly createdIds: ReadonlyArray<string>;
}

/** Deletes a chat's copies of task files by attachment id. Best effort. */
export const deleteTaskFileCopies = (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentIds: ReadonlyArray<string>;
}): Effect.Effect<void> =>
  input.attachmentIds.length === 0
    ? Effect.void
    : Effect.tryPromise(() => deleteThreadAttachmentFiles(input)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to delete a chat's copies of task files", {
            threadId: input.threadId,
            cause,
          }),
        ),
      );

const copyTaskFileToThread = (
  input: {
    readonly taskFilesDir: string;
    readonly attachmentsDir: string;
    readonly threadId: string;
  },
  file: LocalTaskFile,
) =>
  Effect.gen(function* () {
    const id = derivedAttachmentId({
      threadId: input.threadId,
      sourceId: file.fileId,
      extensionSegment:
        file.type === "image"
          ? null
          : (attachmentIdExtensionSegment(file.fileId)?.slice(1) ?? null),
    });
    const failed = storageError(`Task file '${file.name}' could not be added to the chat.`);
    if (id === null) return yield* failed;
    const dimensions = {
      ...(file.width !== undefined ? { width: file.width } : {}),
      ...(file.height !== undefined ? { height: file.height } : {}),
    };
    const attachment: ChatAttachment =
      file.type === "image"
        ? {
            type: "image",
            id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            ...dimensions,
          }
        : {
            type: "file",
            id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            ...dimensions,
          };
    const source = taskFilePath(input.taskFilesDir, file.fileId);
    const destination = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (source === null || destination === null) return yield* failed;
    const { created } = yield* Effect.tryPromise({
      try: () =>
        cloneAttachmentFile({
          source,
          destination,
          attachmentsDir: input.attachmentsDir,
          sizeBytes: file.sizeBytes,
          name: file.name,
        }),
      catch: () => failed,
    });
    return { attachment, id, created };
  });

/**
 * Copies task files into a chat as message attachments: each file gets a private copy at an id
 * in the chat's own segment derived from (chat, file), so a retried start finds the same copies
 * again and an existing copy counts as done. An image's id carries no extension segment because
 * image attachments are stored as id plus image extension. A failure deletes the copies this
 * call already created, so a start that never got its files leaves none behind.
 */
export const copyTaskFilesToThread = (input: {
  readonly taskFilesDir: string;
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly files: ReadonlyArray<LocalTaskFile>;
}): Effect.Effect<TaskFileCopies, LocalTaskError> =>
  Effect.gen(function* () {
    const attachments: ChatAttachment[] = [];
    const createdIds: string[] = [];
    for (const file of input.files) {
      const copy = yield* copyTaskFileToThread(input, file).pipe(
        Effect.tapError(() =>
          deleteTaskFileCopies({
            attachmentsDir: input.attachmentsDir,
            threadId: input.threadId,
            attachmentIds: createdIds,
          }),
        ),
      );
      attachments.push(copy.attachment);
      if (copy.created) createdIds.push(copy.id);
    }
    return { attachments, createdIds };
  });
