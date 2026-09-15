import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  ChatUnknownAttachment,
  ClientOrchestrationCommand,
  ContextHandoffActivityPayload,
  ContextHandoffExportChunk,
  ContextHandoffInspectionEntriesInput,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  FileAttachmentCreateUploadUrlInput,
  FileAttachmentCreateUploadUrlResult,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationGetThreadWindowInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  OrchestrationThread,
  OrchestrationThreadShell,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectCreateCommand,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { THREAD_GOAL_OBJECTIVE_MAX_CHARS } from "./threadGoal.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeContextHandoffActivity = Schema.decodeUnknownEffect(ContextHandoffActivityPayload);
const decodeContextHandoffEntriesInput = Schema.decodeUnknownEffect(
  ContextHandoffInspectionEntriesInput,
);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeOrchestrationThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeChatAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeChatUnknownAttachment = Schema.decodeUnknownEffect(ChatUnknownAttachment);
const decodeChatImageAttachment = Schema.decodeUnknownEffect(ChatImageAttachment);
const decodeChatFileAttachment = Schema.decodeUnknownEffect(ChatFileAttachment);
const decodeFileAttachmentCreateUploadUrlInput = Schema.decodeUnknownEffect(
  FileAttachmentCreateUploadUrlInput,
);
const decodeFileAttachmentCreateUploadUrlResult = Schema.decodeUnknownEffect(
  FileAttachmentCreateUploadUrlResult,
);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeThreadWindowInput = Schema.decodeUnknownEffect(OrchestrationGetThreadWindowInput);
const decodeThreadHistoryPageInput = Schema.decodeUnknownEffect(
  OrchestrationGetThreadHistoryPageInput,
);

const clientTurnWithAttachments = (attachments: ReadonlyArray<unknown>) => ({
  type: "thread.turn.start",
  commandId: "attachment-command",
  threadId: "attachment-thread",
  message: {
    messageId: "attachment-message",
    role: "user",
    text: "",
    attachments,
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-08-30T00:00:00.000Z",
});

it.effect("accepts bounded general file uploads for capable providers", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientOrchestrationCommand(
      clientTurnWithAttachments([
        {
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          dataUrl: "data:text/plain;base64,YWJj",
        },
      ]),
    );

    assert.strictEqual(parsed.type, "thread.turn.start");
    if (parsed.type !== "thread.turn.start") {
      throw new Error(`Unexpected command type: ${parsed.type}`);
    }
    assert.strictEqual(parsed.message.attachments[0]?.type, "file");
  }),
);

it.effect("rejects oversized, unsafe, and excessive general file uploads", () =>
  Effect.gen(function* () {
    const baseFile = {
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      dataUrl: "data:text/plain;base64,YWJj",
    };
    const exits = yield* Effect.all([
      Effect.exit(
        decodeClientOrchestrationCommand(
          clientTurnWithAttachments([
            { ...baseFile, sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 },
          ]),
        ),
      ),
      Effect.exit(
        decodeClientOrchestrationCommand(
          clientTurnWithAttachments([{ ...baseFile, name: "../secret.txt" }]),
        ),
      ),
      Effect.exit(
        decodeClientOrchestrationCommand(
          clientTurnWithAttachments([{ ...baseFile, mimeType: "invalid" }]),
        ),
      ),
      Effect.exit(
        decodeClientOrchestrationCommand(
          clientTurnWithAttachments(
            Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => baseFile),
          ),
        ),
      ),
    ]);

    for (const result of exits) {
      assert.strictEqual(result._tag, "Failure");
    }
  }),
);

it.effect("decodes future attachment kinds and rejects malformed known kinds", () =>
  Effect.gen(function* () {
    const unknown = yield* decodeChatAttachment({
      type: "future-kind",
      name: "archive.zip",
      mimeType: "application/zip",
      sizeBytes: 12,
      extraField: "tolerated",
    });
    assert.strictEqual(unknown.type, "future-kind");

    const directUnknown = yield* decodeChatUnknownAttachment({ type: "future-kind" });
    assert.strictEqual(directUnknown.type, "future-kind");

    const malformedImage = yield* Effect.exit(
      decodeChatAttachment({
        type: "image",
        id: "img-1",
        name: "pic.png",
        mimeType: "image/png",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      }),
    );
    assert.strictEqual(malformedImage._tag, "Failure");

    const malformedFile = yield* Effect.exit(
      decodeChatAttachment({
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      }),
    );
    assert.strictEqual(malformedFile._tag, "Failure");
  }),
);

it.effect("decodes optional attachment media dimensions and rejects negative ones", () =>
  Effect.gen(function* () {
    const image = yield* decodeChatImageAttachment({
      type: "image",
      id: "img-1",
      name: "pic.png",
      mimeType: "image/png",
      sizeBytes: 3,
      width: 1920,
      height: 1080,
    });
    assert.strictEqual(image.width, 1920);
    assert.strictEqual(image.height, 1080);

    const file = yield* decodeChatFileAttachment({
      type: "file",
      id: "clip-1",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 3,
      width: 640,
      height: 360,
    });
    assert.strictEqual(file.width, 640);
    assert.strictEqual(file.height, 360);

    const absent = yield* decodeChatImageAttachment({
      type: "image",
      id: "img-2",
      name: "old.png",
      mimeType: "image/png",
      sizeBytes: 3,
    });
    assert.strictEqual(absent.width, undefined);
    assert.strictEqual(absent.height, undefined);

    const negativeWidth = yield* Effect.exit(
      decodeChatAttachment({
        type: "image",
        id: "img-3",
        name: "pic.png",
        mimeType: "image/png",
        sizeBytes: 3,
        width: -1,
        height: 2,
      }),
    );
    assert.strictEqual(negativeWidth._tag, "Failure");

    const negativeHeight = yield* Effect.exit(
      decodeChatAttachment({
        type: "file",
        id: "clip-2",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 3,
        width: 2,
        height: -1,
      }),
    );
    assert.strictEqual(negativeHeight._tag, "Failure");
  }),
);

it.effect("accepts file uploads by dataUrl or uploadToken but not both or neither", () =>
  Effect.gen(function* () {
    const baseFile = {
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    };
    const byDataUrl = yield* decodeClientOrchestrationCommand(
      clientTurnWithAttachments([{ ...baseFile, dataUrl: "data:text/plain;base64,YWJj" }]),
    );
    assert.strictEqual(byDataUrl.type, "thread.turn.start");

    const byUploadToken = yield* decodeClientOrchestrationCommand(
      clientTurnWithAttachments([{ ...baseFile, uploadToken: "upload-token-1" }]),
    );
    assert.strictEqual(byUploadToken.type, "thread.turn.start");

    const neither = yield* Effect.exit(
      decodeClientOrchestrationCommand(clientTurnWithAttachments([baseFile])),
    );
    assert.strictEqual(neither._tag, "Failure");

    const both = yield* Effect.exit(
      decodeClientOrchestrationCommand(
        clientTurnWithAttachments([
          { ...baseFile, dataUrl: "data:text/plain;base64,YWJj", uploadToken: "upload-token-1" },
        ]),
      ),
    );
    assert.strictEqual(both._tag, "Failure");
  }),
);

it.effect("validates file attachment upload-url contracts", () =>
  Effect.gen(function* () {
    const input = yield* decodeFileAttachmentCreateUploadUrlInput({
      threadId: "thread-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    });
    assert.strictEqual(input.sizeBytes, 3);

    const oversized = yield* Effect.exit(
      decodeFileAttachmentCreateUploadUrlInput({
        threadId: "thread-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    );
    assert.strictEqual(oversized._tag, "Failure");

    const result = yield* decodeFileAttachmentCreateUploadUrlResult({
      uploadToken: "upload-token-1",
      expiresAt: "2026-09-06T00:00:00.000Z",
      maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    });
    assert.strictEqual(result.uploadToken, "upload-token-1");
    assert.strictEqual(result.maxUploadBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  }),
);

it.effect("validates thread goal commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.goal.set",
      commandId: "goal-command",
      threadId: "goal-thread",
      objective: "Ship persistent goals",
      status: "active",
      createdAt: "2026-08-17T10:00:00.000Z",
    });
    assert.strictEqual(parsed.type, "thread.goal.set");

    const invalid = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.goal.set",
        commandId: "goal-command-too-long",
        threadId: "goal-thread",
        objective: "x".repeat(THREAD_GOAL_OBJECTIVE_MAX_CHARS + 1),
        createdAt: "2026-08-17T10:00:00.000Z",
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("accepts bounded thread history inputs with positive limits", () =>
  Effect.gen(function* () {
    const windowInput = yield* decodeThreadWindowInput({
      threadId: "thread-1",
      limits: {
        messages: 100,
        proposedPlans: 20,
        activities: 100,
        checkpoints: 20,
      },
    });
    assert.strictEqual(windowInput.limits.messages, 100);

    const pageInput = yield* decodeThreadHistoryPageInput({
      threadId: "thread-1",
      collection: "messages",
      mode: { kind: "before", cursor: "v1.opaque" },
      limit: 50,
    });
    assert.strictEqual(pageInput.mode.kind, "before");
  }),
);

it.effect("rejects empty cursors and non-positive thread history limits", () =>
  Effect.gen(function* () {
    const windowExit = yield* Effect.exit(
      decodeThreadWindowInput({
        threadId: "thread-1",
        limits: {
          messages: 0,
          proposedPlans: 1,
          activities: 1,
          checkpoints: 1,
        },
      }),
    );
    assert.strictEqual(windowExit._tag, "Failure");

    const pageExit = yield* Effect.exit(
      decodeThreadHistoryPageInput({
        threadId: "thread-1",
        collection: "messages",
        mode: { kind: "before", cursor: "" },
        limit: 1,
      }),
    );
    assert.strictEqual(pageExit._tag, "Failure");
  }),
);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes project.create with createWorkspaceRootIfMissing enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      createWorkspaceRootIfMissing: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.createWorkspaceRootIfMissing, true);
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("decodes ask interaction mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-ask",
      threadId: "thread-1",
      message: {
        messageId: "msg-ask",
        role: "user",
        text: "hello",
        attachments: [],
      },
      interactionMode: "ask",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.interactionMode, "ask");
  }),
);

it.effect("accepts bootstrap metadata in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Bootstrap thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/workspace",
          baseBranch: "main",
          branch: "ryco/example",
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    if (archived.type !== "thread.archived") {
      assert.fail(`Expected thread.archived, got ${archived.type}`);
    }
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("defaults settlement fields on historical thread snapshots", () =>
  Effect.gen(function* () {
    const shell = {
      id: "thread-settlement-legacy",
      projectId: "project-1",
      title: "Legacy thread",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const parsedShell = yield* decodeOrchestrationThreadShell(shell);
    const parsedThread = yield* decodeOrchestrationThread({
      ...shell,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });

    assert.strictEqual(parsedShell.settledOverride, null);
    assert.strictEqual(parsedShell.settledAt, null);
    assert.strictEqual(parsedThread.settledOverride, null);
    assert.strictEqual(parsedThread.settledAt, null);
  }),
);

it.effect("decodes settlement commands and rejects client-forged activity resets", () =>
  Effect.gen(function* () {
    const settle = yield* decodeOrchestrationCommand({
      type: "thread.settle",
      commandId: "cmd-settle-1",
      threadId: "thread-1",
    });
    const unsettle = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-1",
      threadId: "thread-1",
      reason: "user",
    });
    const forgedActivityReset = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.unsettle",
        commandId: "cmd-unsettle-forged",
        threadId: "thread-1",
        reason: "activity",
      }),
    );

    assert.strictEqual(settle.type, "thread.settle");
    assert.strictEqual(unsettle.type, "thread.unsettle");
    assert.strictEqual(forgedActivityReset._tag, "Failure");
  }),
);

it.effect("decodes settled and user/activity-unsettled events", () =>
  Effect.gen(function* () {
    const eventBase = {
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-01-02T00:00:00.000Z",
      causationEventId: null,
      metadata: {},
    } as const;
    const settled = yield* decodeOrchestrationEvent({
      ...eventBase,
      sequence: 3,
      eventId: "event-settled-1",
      type: "thread.settled",
      commandId: "cmd-settle-1",
      correlationId: "cmd-settle-1",
      payload: {
        threadId: "thread-1",
        settledAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const userUnsettled = yield* decodeOrchestrationEvent({
      ...eventBase,
      sequence: 4,
      eventId: "event-unsettled-user",
      type: "thread.unsettled",
      commandId: "cmd-unsettle-1",
      correlationId: "cmd-unsettle-1",
      payload: {
        threadId: "thread-1",
        reason: "user",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const activityUnsettled = yield* decodeOrchestrationEvent({
      ...eventBase,
      sequence: 5,
      eventId: "event-unsettled-activity",
      type: "thread.unsettled",
      commandId: "cmd-turn-1",
      correlationId: "cmd-turn-1",
      payload: {
        threadId: "thread-1",
        reason: "activity",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(settled.type, "thread.settled");
    if (userUnsettled.type !== "thread.unsettled") {
      assert.fail(`Expected thread.unsettled, got ${userUnsettled.type}`);
    }
    if (activityUnsettled.type !== "thread.unsettled") {
      assert.fail(`Expected thread.unsettled, got ${activityUnsettled.type}`);
    }
    assert.strictEqual(userUnsettled.payload.reason, "user");
    assert.strictEqual(activityUnsettled.payload.reason, "activity");
  }),
);

it.effect("decodes Jira work item metadata on worktree create commands and events", () =>
  Effect.gen(function* () {
    const command = yield* decodeOrchestrationCommand({
      type: "worktree.create",
      commandId: "cmd-jira-worktree-create",
      worktreeId: "worktree-jira-kan-4",
      projectId: "project-jira",
      branch: "KAN-4-super-toll",
      worktreePath: "/tmp/KAN-4-super-toll",
      origin: "issue",
      prNumber: null,
      issueNumber: null,
      prTitle: null,
      issueTitle: null,
      workItemProvider: "jira",
      workItemKey: "KAN-4",
      workItemTitle: "SUPER TOLL",
      workItemState: "open",
      workItemStateName: "Next to come",
      workItemUrl: "https://ryco-app.atlassian.net/browse/KAN-4",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const event = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-jira-worktree-created",
      aggregateKind: "worktree",
      aggregateId: "worktree-jira-kan-4",
      type: "worktree.created",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-jira-worktree-create",
      causationEventId: null,
      correlationId: "cmd-jira-worktree-create",
      metadata: {},
      payload: {
        worktreeId: "worktree-jira-kan-4",
        projectId: "project-jira",
        branch: "KAN-4-super-toll",
        worktreePath: "/tmp/KAN-4-super-toll",
        origin: "issue",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        workItemProvider: "jira",
        workItemKey: "KAN-4",
        workItemTitle: "SUPER TOLL",
        workItemState: "open",
        workItemStateName: "Next to come",
        workItemUrl: "https://ryco-app.atlassian.net/browse/KAN-4",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    if (command.type !== "worktree.create") {
      throw new Error(`Unexpected command type: ${command.type}`);
    }
    assert.strictEqual(command.workItemState, "open");
    assert.strictEqual(command.workItemStateName, "Next to come");
    if (event.type !== "worktree.created") {
      throw new Error(`Unexpected event type: ${event.type}`);
    }
    assert.strictEqual(event.payload.workItemState, "open");
    assert.strictEqual(event.payload.workItemStateName, "Next to come");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "reasoningEffort"), "high");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "fastMode"), true);
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect("normalizes legacy object-shaped defaultModelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Legacy default project",
      workspaceRoot: "/tmp/legacy",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "low" },
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.defaultModelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
    ]);
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeThreadCreatedPayload({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Round trip thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: true },
        },
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const encoded = yield* Schema.encodeEffect(ThreadCreatedPayload)(decoded);
      assert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes historical and context-handoff turn-start requests", () =>
  Effect.gen(function* () {
    const historical = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-1",
      messageId: "msg-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(historical.contextHandoff, undefined);

    const handoff = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-1",
      messageId: "msg-2",
      contextHandoff: {
        handoffId: "handoff-1",
        activityId: "activity-1",
        targetMessageId: "msg-2",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(handoff.contextHandoff?.handoffId, "handoff-1");
  }),
);

it.effect("decodes every context handoff activity state", () =>
  Effect.gen(function* () {
    const base = {
      schemaVersion: 1,
      handoffId: "handoff-1",
      mode: "full-context-fresh-session",
      targetMessageId: "msg-2",
      sourceSelection: { instanceId: "codex_work", model: "gpt-5.6" },
      targetSelection: { instanceId: "claude_work", model: "claude-fable-5" },
      sourceRuntimeSessionId: "runtime-source",
    } as const;
    const presentation = {
      sources: [
        {
          providerInstanceId: "codex_work",
          driverKind: "codex",
          providerDisplayName: "Codex Work",
          modelSlug: "gpt-5.6",
          modelDisplayName: "GPT-5.6",
        },
      ],
      target: {
        providerInstanceId: "claude_work",
        driverKind: "claudeAgent",
        providerDisplayName: "Claude Work",
        modelSlug: "claude-fable-5",
        modelDisplayName: "Claude Fable 5",
      },
    } as const;
    const context = {
      contextVersion: 1,
      contextDigest: "a".repeat(64),
    } as const;

    for (const status of ["requested", "preparing"] as const) {
      const decoded = yield* decodeContextHandoffActivity({ ...base, status });
      assert.strictEqual(decoded.status, status);
    }
    for (const status of ["dispatching", "consumed"] as const) {
      const decoded = yield* decodeContextHandoffActivity({
        ...base,
        ...presentation,
        ...context,
        targetRuntimeSessionId: "runtime-target",
        ...(status === "consumed"
          ? {
              inspection: {
                completeEntryCount: 12,
                includedEntryCount: 8,
                truncated: true,
                completeDigest: "a".repeat(64),
                providerInputDigest: "b".repeat(64),
                preparedAt: "2026-08-05T10:00:00.000Z",
                acceptedAt: "2026-08-05T10:00:01.000Z",
              },
            }
          : {}),
        status,
      });
      assert.strictEqual(decoded.status, status);
      if (decoded.status !== "dispatching" && decoded.status !== "consumed") {
        throw new Error(`expected ${status} context handoff activity`);
      }
      assert.strictEqual(decoded.sources.length, 1);
      if (decoded.status === "consumed") {
        assert.strictEqual(decoded.inspection?.includedEntryCount, 8);
        assert.strictEqual(decoded.inspection?.truncated, true);
      }
    }
    const failed = yield* decodeContextHandoffActivity({
      ...base,
      ...presentation,
      status: "failed",
      error: "Target startup failed",
    });
    assert.strictEqual(failed.status, "failed");
    const uncertain = yield* decodeContextHandoffActivity({
      ...base,
      ...presentation,
      ...context,
      targetRuntimeSessionId: "runtime-target",
      status: "delivery-uncertain",
      error: "Provider acceptance could not be proven after restart",
    });
    assert.strictEqual(uncertain.status, "delivery-uncertain");
  }),
);

it.effect("rejects malformed context handoff activity metadata", () =>
  Effect.gen(function* () {
    const invalidSources = yield* Effect.exit(
      decodeContextHandoffActivity({
        schemaVersion: 1,
        handoffId: "handoff-1",
        mode: "full-context-fresh-session",
        targetMessageId: "msg-2",
        sourceSelection: { instanceId: "codex", model: "gpt-5.6" },
        targetSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
        sources: [],
        target: {
          providerInstanceId: "claudeAgent",
          driverKind: "claudeAgent",
          modelSlug: "claude-fable-5",
        },
        contextVersion: 1,
        contextDigest: "a".repeat(64),
        status: "consumed",
      }),
    );
    assert.strictEqual(invalidSources._tag, "Failure");

    const oversizedError = yield* Effect.exit(
      decodeContextHandoffActivity({
        schemaVersion: 1,
        handoffId: "handoff-1",
        mode: "full-context-fresh-session",
        targetMessageId: "msg-2",
        sourceSelection: { instanceId: "codex", model: "gpt-5.6" },
        targetSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
        sources: [
          {
            providerInstanceId: "codex",
            driverKind: "codex",
            modelSlug: "gpt-5.6",
          },
        ],
        target: {
          providerInstanceId: "claudeAgent",
          driverKind: "claudeAgent",
          modelSlug: "claude-fable-5",
        },
        status: "failed",
        error: "x".repeat(2_001),
      }),
    );
    assert.strictEqual(oversizedError._tag, "Failure");
  }),
);

it.effect("bounds context handoff inspection pages and export filenames", () =>
  Effect.gen(function* () {
    const oversizedPage = yield* Effect.exit(
      decodeContextHandoffEntriesInput({
        threadId: "thread-1",
        handoffId: "handoff-1",
        scope: "sent",
        section: "messages",
        limit: 21,
      }),
    );
    assert.strictEqual(oversizedPage._tag, "Failure");
    const unsafeFilename = yield* Effect.exit(
      Schema.decodeUnknownEffect(ContextHandoffExportChunk)({
        scope: "sent",
        format: "json",
        offset: 0,
        chunk: "{}",
        nextOffset: null,
        totalBytes: 2,
        digest: "a".repeat(64),
        filename: "../../handoff.json",
      }),
    );
    assert.strictEqual(unsafeFilename._tag, "Failure");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.runtimeSessionId, undefined);
  }),
);

it.effect("decodes orchestration session runtime epochs", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: "codex",
      providerInstanceId: "codex_work",
      runtimeSessionId: "runtime-session-1",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeSessionId, "runtime-session-1");
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it("rejects legacy recall commands while preserving historical recall payloads", () => {
  const projectMemory = { projectId: "old-project", references: [{ id: "entry", revision: 1 }] };
  const command = clientTurnWithAttachments([]);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ClientOrchestrationCommand)(command));
  for (const value of [projectMemory, null, {}, "invalid"]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(ClientOrchestrationCommand)({ ...command, projectMemory: value }),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(ThreadTurnStartCommand)({ ...command, projectMemory: value }),
    );
  }
  const payload = Schema.decodeUnknownSync(ThreadTurnStartRequestedPayload)({
    threadId: "attachment-thread",
    messageId: "attachment-message",
    createdAt: command.createdAt,
    projectMemory,
  });
  assert.deepEqual(payload.projectMemory, projectMemory);
});
