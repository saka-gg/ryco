import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CommandId,
  OrchestrationDispatchCommandError,
  MessageId,
  ProjectId,
  ThreadId,
  type ChatImageAttachment,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { expect } from "vite-plus/test";

import { applyOrchestrationCommand } from "./Layers/OrchestrationCommandApplication.ts";
import { attachmentRelativePath, resolveAttachmentPath } from "../attachmentStore.ts";
import {
  ChatAttachmentUploads,
  type ChatAttachmentUploadsShape,
  makeChatAttachmentUploads,
} from "../attachmentUpload.ts";
import { deriveServerPaths, ServerConfig } from "../config.ts";
import { WorkspaceAccessPolicyLayer } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand, withChatAttachmentAdoption } from "./Normalizer.ts";

const projectCreateCommand = (workspaceRoot: string): ClientOrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make("restricted-project-create"),
  projectId: ProjectId.make("restricted-project"),
  title: "Restricted project",
  workspaceRoot,
  createWorkspaceRootIfMissing: true,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const fileTurnCommand = (input?: {
  readonly mimeType?: string;
  readonly dataUrl?: string;
  readonly sizeBytes?: number;
  readonly uploadToken?: string;
  readonly threadId?: string;
  readonly name?: string;
}): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("file-attachment-command"),
  threadId: ThreadId.make(input?.threadId ?? "file-attachment-thread"),
  message: {
    messageId: MessageId.make("file-attachment-message"),
    role: "user",
    text: "Review the attachment",
    attachments: [
      input?.uploadToken !== undefined
        ? {
            type: "file" as const,
            name: input?.name ?? "notes.txt",
            mimeType: input?.mimeType ?? "text/plain",
            sizeBytes: input?.sizeBytes ?? 3,
            uploadToken: input.uploadToken,
          }
        : {
            type: "file" as const,
            name: input?.name ?? "notes.txt",
            mimeType: input?.mimeType ?? "text/plain",
            sizeBytes: input?.sizeBytes ?? 3,
            dataUrl: input?.dataUrl ?? "data:text/plain;base64,YWJj",
          },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const makeUploadNormalizerContext = (input?: { readonly ttlMs?: number }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ryco-normalizer-upload-",
    });
    const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ryco-normalizer-upload-root-",
    });
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined).pipe(
      Effect.provide(NodeServices.layer),
    );
    const uploads = yield* makeChatAttachmentUploads({
      attachmentsDir: derivedPaths.attachmentsDir,
      ...(input?.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    });
    const layer = Layer.mergeAll(
      WorkspaceAccessPolicyLayer(workspaceAccessRoot),
      WorkspacePathsLive,
      ServerConfig.layerTest(workspaceAccessRoot, baseDir),
      Layer.succeed(ChatAttachmentUploads, uploads),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    return { uploads, layer, attachmentsDir: derivedPaths.attachmentsDir };
  }).pipe(Effect.provide(NodeServices.layer));

const completeUploadFixture = Effect.fn("completeUploadFixture")(function* (
  uploads: ChatAttachmentUploadsShape,
  input: { readonly threadId: string; readonly name: string; readonly sizeBytes: number },
) {
  const created = yield* uploads.create({
    threadId: ThreadId.make(input.threadId),
    name: input.name,
    mimeType: "text/plain",
    sizeBytes: input.sizeBytes,
  });
  const lease = yield* uploads.beginUpload(created.uploadToken);
  yield* Effect.promise(async () => {
    await mkdir(path.dirname(lease.finalPath), { recursive: true });
    await writeFile(lease.finalPath, Buffer.from("abc"));
  });
  yield* uploads.completeUpload(created.uploadToken);
  return { created, lease };
});

const makeNormalizerLayer = (workspaceAccessRoot: string) =>
  Layer.mergeAll(
    WorkspaceAccessPolicyLayer(workspaceAccessRoot),
    WorkspacePathsLive,
    ServerConfig.layerTest(workspaceAccessRoot, {
      prefix: "ryco-normalizer-test-",
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("project creation rejects an outside root before creating it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-normalizer-restricted-",
      });
      const outsideParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-normalizer-outside-",
      });
      const requestedRoot = `${outsideParent}/new-project`;

      const error = yield* normalizeDispatchCommand(projectCreateCommand(requestedRoot)).pipe(
        Effect.provide(makeNormalizerLayer(workspaceAccessRoot)),
        Effect.flip,
      );

      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toContain("access is restricted");
      expect(yield* fileSystem.exists(requestedRoot)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("project creation accepts and canonicalizes a root inside the workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-normalizer-restricted-",
      });
      const requestedRoot = `${workspaceAccessRoot}/new-project`;

      const normalized = yield* normalizeDispatchCommand(projectCreateCommand(requestedRoot)).pipe(
        Effect.provide(makeNormalizerLayer(workspaceAccessRoot)),
      );

      expect(normalized.type).toBe("project.create");
      if (normalized.type !== "project.create") {
        throw new Error(`Unexpected normalized command: ${normalized.type}`);
      }
      expect(normalized.workspaceRoot).toBe(yield* fileSystem.realPath(requestedRoot));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("persists a validated general file under an opaque path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-normalizer-file-",
      });
      const layer = makeNormalizerLayer(workspaceAccessRoot);
      const { normalized, persistedBytes, persistedNames } = yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const normalized = yield* normalizeDispatchCommand(fileTurnCommand());
        if (normalized.type !== "thread.turn.start") {
          throw new Error(`Unexpected normalized command: ${normalized.type}`);
        }
        const attachment = normalized.message.attachments[0];
        if (!attachment) {
          throw new Error("Expected a normalized attachment");
        }
        const persistedPath = `${config.attachmentsDir}/${attachment.id}.bin`;
        return {
          normalized,
          persistedBytes: yield* fileSystem.readFile(persistedPath),
          persistedNames: yield* fileSystem.readDirectory(config.attachmentsDir),
        };
      }).pipe(Effect.provide(layer));

      expect(normalized.type).toBe("thread.turn.start");
      if (normalized.type !== "thread.turn.start") {
        throw new Error(`Unexpected normalized command: ${normalized.type}`);
      }
      const attachment = normalized.message.attachments[0];
      expect(attachment?.type).toBe("file");
      if (!attachment) {
        throw new Error("Expected a normalized attachment");
      }

      expect(persistedNames).toContain(`${attachment.id}.bin`);
      expect(Buffer.from(persistedBytes).toString("utf8")).toBe("abc");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

const imageTurnCommand = (input: {
  readonly dataUrl: string;
  readonly sizeBytes: number;
}): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("image-attachment-command"),
  threadId: ThreadId.make("image-attachment-thread"),
  message: {
    messageId: MessageId.make("image-attachment-message"),
    role: "user",
    text: "Review the image",
    attachments: [
      {
        type: "image" as const,
        name: "tiny.png",
        mimeType: "image/png",
        sizeBytes: input.sizeBytes,
        dataUrl: input.dataUrl,
      },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

it.effect("persists probed image dimensions with an inline dataUrl attachment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-normalizer-image-",
      });
      const layer = makeNormalizerLayer(workspaceAccessRoot);

      const { normalized, persistedNames } = yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const normalized = yield* normalizeDispatchCommand(
          imageTurnCommand({
            dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
            sizeBytes: Buffer.from(TINY_PNG_BASE64, "base64").byteLength,
          }),
        );
        return {
          normalized,
          persistedNames: yield* fileSystem.readDirectory(config.attachmentsDir),
        };
      }).pipe(Effect.provide(layer));

      if (normalized.type !== "thread.turn.start") {
        throw new Error(`Unexpected normalized command: ${normalized.type}`);
      }
      const attachment = normalized.message.attachments[0] as ChatImageAttachment | undefined;
      expect(attachment?.type).toBe("image");
      if (!attachment || attachment.type !== "image") {
        throw new Error("Expected a normalized image attachment");
      }
      expect(attachment.width).toBe(1);
      expect(attachment.height).toBe(1);
      expect(persistedNames).toContain(`${attachment.id}.png`);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("persists an unparseable image without dimensions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-normalizer-image-corrupt-",
      });
      const layer = makeNormalizerLayer(workspaceAccessRoot);

      const { normalized, persistedNames } = yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const normalized = yield* normalizeDispatchCommand(
          imageTurnCommand({ dataUrl: "data:image/png;base64,YWJj", sizeBytes: 3 }),
        );
        return {
          normalized,
          persistedNames: yield* fileSystem.readDirectory(config.attachmentsDir),
        };
      }).pipe(Effect.provide(layer));

      if (normalized.type !== "thread.turn.start") {
        throw new Error(`Unexpected normalized command: ${normalized.type}`);
      }
      const attachment = normalized.message.attachments[0] as ChatImageAttachment | undefined;
      expect(attachment?.type).toBe("image");
      if (!attachment || attachment.type !== "image") {
        throw new Error("Expected a normalized image attachment");
      }
      expect(attachment.width).toBeUndefined();
      expect(attachment.height).toBeUndefined();
      expect(persistedNames).toContain(`${attachment.id}.png`);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("rejects mismatched file MIME and size metadata before persistence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceAccessRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-normalizer-invalid-file-",
      });
      const layer = makeNormalizerLayer(workspaceAccessRoot);
      const { attachmentNames, mimeError, sizeError } = yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const mimeError = yield* normalizeDispatchCommand(
          fileTurnCommand({ mimeType: "application/json" }),
        ).pipe(Effect.flip);
        const sizeError = yield* normalizeDispatchCommand(fileTurnCommand({ sizeBytes: 4 })).pipe(
          Effect.flip,
        );
        return {
          attachmentNames: yield* fileSystem.readDirectory(config.attachmentsDir),
          mimeError,
          sizeError,
        };
      }).pipe(Effect.provide(layer));
      expect(mimeError.message).toContain("declares 'application/json'");
      expect(sizeError.message).toContain("mismatched size metadata");
      expect(attachmentNames).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("adopts a streamed upload through its token and extension-suffixed id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer, attachmentsDir } = yield* makeUploadNormalizerContext();
      const threadId = "file-attachment-thread";
      const { lease } = yield* completeUploadFixture(uploads, {
        threadId,
        name: "notes.txt",
        sizeBytes: 3,
      });

      const normalized = yield* normalizeDispatchCommand(
        fileTurnCommand({ uploadToken: lease.uploadToken }),
      ).pipe(Effect.provide(layer));

      expect(normalized.type).toBe("thread.turn.start");
      if (normalized.type !== "thread.turn.start") {
        throw new Error(`Unexpected normalized command: ${normalized.type}`);
      }
      const attachment = normalized.message.attachments[0];
      expect(attachment?.type).toBe("file");
      if (!attachment || attachment.type !== "file") {
        throw new Error("Expected a normalized file attachment");
      }
      const attachmentId = attachment.id ?? "";
      expect(attachment.id).toBe(lease.attachmentId);
      expect(attachmentId.endsWith("-txt")).toBe(true);
      expect(attachment).not.toHaveProperty("dataUrl");
      expect(attachment).not.toHaveProperty("uploadToken");
      expect(attachmentRelativePath(attachment)).toBe(attachmentId);

      const persistedPath = resolveAttachmentPath({
        attachmentsDir,
        attachment,
      });
      expect(persistedPath).toBe(`${attachmentsDir}/${attachment.id}`);
      expect((yield* Effect.promise(() => readFile(persistedPath ?? ""))).toString()).toBe("abc");
    }),
  ),
);

it.effect("replays adoption for the same command but rejects reuse by another command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer } = yield* makeUploadNormalizerContext();
      const { lease } = yield* completeUploadFixture(uploads, {
        threadId: "file-attachment-thread",
        name: "notes.txt",
        sizeBytes: 3,
      });

      yield* normalizeDispatchCommand(fileTurnCommand({ uploadToken: lease.uploadToken })).pipe(
        Effect.provide(layer),
      );
      yield* normalizeDispatchCommand(fileTurnCommand({ uploadToken: lease.uploadToken })).pipe(
        Effect.provide(layer),
      );
      const reuseError = yield* normalizeDispatchCommand({
        ...fileTurnCommand({ uploadToken: lease.uploadToken }),
        commandId: CommandId.make("another-command"),
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(reuseError._tag).toBe("OrchestrationDispatchCommandError");
    }),
  ),
);

it.live("rejects adoption on thread, size mismatches, and expired tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer } = yield* makeUploadNormalizerContext({ ttlMs: 30 });
      const { created, lease } = yield* completeUploadFixture(uploads, {
        threadId: "file-attachment-thread",
        name: "notes.txt",
        sizeBytes: 3,
      });

      const threadMismatch = yield* normalizeDispatchCommand(
        fileTurnCommand({ uploadToken: lease.uploadToken, threadId: "other-thread" }),
      ).pipe(Effect.provide(layer), Effect.flip);
      expect(threadMismatch.message).toContain("does not match its file upload registration");

      const sizeMismatch = yield* normalizeDispatchCommand(
        fileTurnCommand({ uploadToken: lease.uploadToken, sizeBytes: 4 }),
      ).pipe(Effect.provide(layer), Effect.flip);
      expect(sizeMismatch.message).toContain("does not match its file upload registration");

      yield* Effect.sleep("40 millis");
      const expiredError = yield* normalizeDispatchCommand(
        fileTurnCommand({ uploadToken: created.uploadToken }),
      ).pipe(Effect.provide(layer), Effect.flip);
      expect(expiredError.message).toContain("unknown or already-used file upload");
    }),
  ),
);

it.effect("rejects upload references when the upload service is absent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerWithoutUploads = Layer.mergeAll(
        WorkspaceAccessPolicyLayer("/tmp"),
        WorkspacePathsLive,
        ServerConfig.layerTest("/tmp", { prefix: "ryco-normalizer-noupload-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      const uploads = yield* makeChatAttachmentUploads({ attachmentsDir: "/tmp" });
      const created = yield* uploads.create({
        threadId: ThreadId.make("file-attachment-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      });

      const error = yield* normalizeDispatchCommand(
        fileTurnCommand({ uploadToken: created.uploadToken }),
      ).pipe(Effect.provide(layerWithoutUploads), Effect.flip);
      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toContain("upload reference");
    }),
  ),
);

it.effect("releases streamed files after dispatch rejection so a fresh command can retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer } = yield* makeUploadNormalizerContext();
      const { lease } = yield* completeUploadFixture(uploads, {
        threadId: "file-attachment-thread",
        name: "notes.txt",
        sizeBytes: 3,
      });
      const command = fileTurnCommand({ uploadToken: lease.uploadToken });
      const rejected = yield* applyOrchestrationCommand({
        command,
        normalize: normalizeDispatchCommand,
        dispatch: () =>
          Effect.fail(new OrchestrationDispatchCommandError({ message: "thread became busy" })),
        projections: {} as never,
        terminals: {} as never,
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(rejected._tag).toBe("OrchestrationDispatchCommandError");
      const retry = { ...command, commandId: CommandId.make("retry-after-rejection") };
      const result = yield* applyOrchestrationCommand({
        command: retry,
        normalize: normalizeDispatchCommand,
        dispatch: () => Effect.succeed({ sequence: 1 }),
        projections: {} as never,
        terminals: {} as never,
      }).pipe(Effect.provide(layer));
      expect(result.sequence).toBe(1);
      // Committed claims still cannot be stolen by a different command.
      const other = yield* normalizeDispatchCommand({
        ...command,
        commandId: CommandId.make("unrelated-send"),
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(other._tag).toBe("OrchestrationDispatchCommandError");
    }),
  ),
);

it.effect("releases earlier claims when a later attachment fails normalization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer } = yield* makeUploadNormalizerContext();
      const { lease } = yield* completeUploadFixture(uploads, {
        threadId: "file-attachment-thread",
        name: "notes.txt",
        sizeBytes: 3,
      });
      const command = fileTurnCommand({ uploadToken: lease.uploadToken });
      if (command.type !== "thread.turn.start") throw new Error("Expected turn");
      const invalid = {
        ...command,
        message: {
          ...command.message,
          attachments: [
            ...command.message.attachments,
            {
              type: "file" as const,
              name: "bad.txt",
              mimeType: "text/plain",
              sizeBytes: 3,
              dataUrl: "invalid",
            },
          ],
        },
      };
      yield* withChatAttachmentAdoption(invalid, normalizeDispatchCommand(invalid)).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      const retry = { ...command, commandId: CommandId.make("retry-after-normalization") };
      const normalized = yield* withChatAttachmentAdoption(
        retry,
        normalizeDispatchCommand(retry),
      ).pipe(Effect.provide(layer));
      expect(normalized.type).toBe("thread.turn.start");
    }),
  ),
);

it.effect("retains claims for an interrupted dispatch with an unknown commit result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer } = yield* makeUploadNormalizerContext();
      const { lease } = yield* completeUploadFixture(uploads, {
        threadId: "file-attachment-thread",
        name: "notes.txt",
        sizeBytes: 3,
      });
      const command = fileTurnCommand({ uploadToken: lease.uploadToken });
      const interrupted = yield* withChatAttachmentAdoption(
        command,
        normalizeDispatchCommand(command).pipe(Effect.andThen(Effect.interrupt)),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(interrupted._tag).toBe("Failure");
      yield* normalizeDispatchCommand(command).pipe(Effect.provide(layer));
      const unrelated = yield* normalizeDispatchCommand({
        ...command,
        commandId: CommandId.make("different-command"),
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(unrelated._tag).toBe("OrchestrationDispatchCommandError");
    }),
  ),
);

it.effect("a failed replay cannot release an earlier accepted attachment claim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer } = yield* makeUploadNormalizerContext();
      const { lease } = yield* completeUploadFixture(uploads, {
        threadId: "file-attachment-thread",
        name: "notes.txt",
        sizeBytes: 3,
      });
      const command = fileTurnCommand({ uploadToken: lease.uploadToken });
      yield* withChatAttachmentAdoption(command, normalizeDispatchCommand(command)).pipe(
        Effect.provide(layer),
      );
      const invalidReplay = fileTurnCommand({ uploadToken: lease.uploadToken, sizeBytes: 4 });
      yield* withChatAttachmentAdoption(
        invalidReplay,
        normalizeDispatchCommand(invalidReplay),
      ).pipe(Effect.provide(layer), Effect.flip);
      const unrelated = { ...command, commandId: CommandId.make("cannot-steal-accepted-claim") };
      yield* withChatAttachmentAdoption(unrelated, normalizeDispatchCommand(unrelated)).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      yield* normalizeDispatchCommand(command).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a committed overlapping replay when the first attempt later fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { uploads, layer } = yield* makeUploadNormalizerContext();
      const { lease } = yield* completeUploadFixture(uploads, {
        threadId: "file-attachment-thread",
        name: "notes.txt",
        sizeBytes: 3,
      });
      const command = fileTurnCommand({ uploadToken: lease.uploadToken });
      const firstClaimed = yield* Deferred.make<void>();
      const failFirst = yield* Deferred.make<void>();
      const first = yield* withChatAttachmentAdoption(
        command,
        Effect.gen(function* () {
          yield* normalizeDispatchCommand(command);
          yield* Deferred.succeed(firstClaimed, undefined);
          yield* Deferred.await(failFirst);
          // A later validation failure in A occurs only after B has committed.
          return yield* normalizeDispatchCommand(fileTurnCommand({ dataUrl: "invalid" }));
        }),
      ).pipe(Effect.provide(layer), Effect.exit, Effect.forkChild);
      yield* Deferred.await(firstClaimed);
      yield* applyOrchestrationCommand({
        command,
        normalize: normalizeDispatchCommand,
        dispatch: () => Effect.succeed({ sequence: 1 }),
        projections: {} as never,
        terminals: {} as never,
      }).pipe(Effect.provide(layer));
      yield* Deferred.succeed(failFirst, undefined);
      expect((yield* Fiber.join(first))._tag).toBe("Failure");
      const third = {
        ...command,
        commandId: CommandId.make("cannot-claim-after-overlapping-commit"),
      };
      const result = yield* withChatAttachmentAdoption(third, normalizeDispatchCommand(third)).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(result._tag).toBe("Failure");
    }),
  ),
);
