import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { KeybindingCommand } from "./keybindings.ts";
import {
  AgentControlMcpProjectSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  ProjectCreateCommand,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  ThreadTurnStartCommand,
  CHAT_PROJECT_TITLE_MAX_CHARS,
  OrchestrationDispatchCommandError,
  PROJECT_RELOCATION_PENDING_MESSAGE,
  ProjectChatDestinationStatus,
  ProjectChatError,
  ProjectsPromoteChatInput,
  ProjectsPromoteChatPreviewInput,
  ServerChatsCapability,
  ServerSettings,
  ServerSettingsPatch,
  TerminalCwdError,
  TrashedThreadSummary,
} from "./index.ts";

const at = "2026-10-08T10:00:00.000Z";
const project = {
  id: "project-1",
  title: "Project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
};
const turnStart = {
  type: "thread.turn.start",
  commandId: "cmd-chat",
  threadId: "thread-chat",
  message: { messageId: "msg-chat", role: "user", text: "hello", attachments: [] },
  createdAt: at,
};

it.effect("decodes projects without a kind as regular projects", () =>
  Effect.gen(function* () {
    const full = yield* Schema.decodeUnknownEffect(OrchestrationProject)({
      ...project,
      deletedAt: null,
    });
    assert.strictEqual(full.kind, "project");
    const shell = yield* Schema.decodeUnknownEffect(OrchestrationProjectShell)(project);
    assert.strictEqual(shell.kind, "project");
    const chat = yield* Schema.decodeUnknownEffect(OrchestrationProjectShell)({
      ...project,
      kind: "chat",
    });
    assert.strictEqual(chat.kind, "chat");
    const summary = yield* Schema.decodeUnknownEffect(AgentControlMcpProjectSummary)({
      projectId: "project-1",
      title: "Project",
      createdAt: at,
      updatedAt: at,
    });
    assert.strictEqual(summary.kind, "project");
    const unknownKind = yield* Effect.result(
      Schema.decodeUnknownEffect(OrchestrationProjectShell)({ ...project, kind: "folder" }),
    );
    assert.strictEqual(unknownKind._tag, "Failure");
  }),
);

it.effect("keeps project kind optional on commands and events", () =>
  Effect.gen(function* () {
    const { id: projectId, ...rest } = project;
    const created = yield* Schema.decodeUnknownEffect(ProjectCreatedPayload)({
      projectId,
      ...rest,
    });
    assert.strictEqual(created.kind, "project");
    const create = yield* Schema.decodeUnknownEffect(ProjectCreateCommand)({
      type: "project.create",
      commandId: "cmd-create",
      projectId,
      title: "Chat",
      workspaceRoot: "/tmp/chat",
      createdAt: at,
    });
    assert.strictEqual(create.kind, undefined);
    const updated = yield* Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload)({
      projectId,
      title: "Renamed",
      updatedAt: at,
    });
    assert.strictEqual(updated.kind, undefined);
    const promoted = yield* Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload)({
      projectId,
      kind: "project",
      updatedAt: at,
    });
    assert.strictEqual(promoted.kind, "project");
  }),
);

it.effect("accepts a chat bootstrap only for its own first thread, never with a worktree", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
    const createChatProject = { projectId: "project-chat", titleSeed: "  Plan a trip  " };
    const createThread = (projectId: string) => ({
      projectId,
      title: "Plan a trip",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
    });
    const parsed = yield* decode({
      ...turnStart,
      bootstrap: { createChatProject, createThread: createThread("project-chat") },
    });
    assert.deepEqual(parsed.bootstrap?.createChatProject, {
      projectId: "project-chat",
      titleSeed: "Plan a trip",
    });
    const valid = { createChatProject, createThread: createThread("project-chat") };
    for (const bootstrap of [
      { ...valid, prepareWorktree: { projectCwd: "/tmp/repo", baseBranch: "main" } },
      { ...valid, requireWorktree: true },
      { createChatProject },
      { createChatProject, createThread: createThread("project-other") },
      {
        ...valid,
        createChatProject: {
          projectId: "project-chat",
          titleSeed: "x".repeat(CHAT_PROJECT_TITLE_MAX_CHARS + 1),
        },
      },
      { ...valid, createChatProject: { projectId: "project-chat", titleSeed: "   " } },
    ]) {
      const rejected = yield* Effect.result(decode({ ...turnStart, bootstrap }));
      assert.strictEqual(rejected._tag, "Failure");
    }
  }),
);

it.effect("describes chat availability, settings and the keybinding", () =>
  Effect.gen(function* () {
    const unavailable = yield* Schema.decodeUnknownEffect(ServerChatsCapability)({
      available: false,
      unavailableReason: "inside-git-repository",
    });
    assert.strictEqual(unavailable.root, undefined);

    const settings = yield* Schema.decodeUnknownEffect(ServerSettings)({});
    assert.strictEqual(settings.chatsRoot, "");
    const patch = yield* Schema.decodeUnknownEffect(ServerSettingsPatch)({
      chatsRoot: " ~/Chats ",
    });
    assert.strictEqual(patch.chatsRoot, "~/Chats");
    const projectOverride = yield* Effect.result(
      Schema.decodeUnknownEffect(ServerSettingsPatch)({
        projectPreferences: { a: { chatsRoot: "/tmp" } },
      }),
    );
    assert.strictEqual(projectOverride._tag, "Failure");

    assert.strictEqual(
      yield* Schema.decodeUnknownEffect(KeybindingCommand)("chat.newWithoutProject"),
      "chat.newWithoutProject",
    );
  }),
);

it.effect("decodes chat promotion inputs and errors", () =>
  Effect.gen(function* () {
    const preview = yield* Schema.decodeUnknownEffect(ProjectsPromoteChatPreviewInput)({
      projectId: "project-chat",
      destination: "",
    });
    assert.strictEqual(preview.destination, "");
    const promote = yield* Schema.decodeUnknownEffect(ProjectsPromoteChatInput)({
      projectId: "project-chat",
      title: "Trip",
      destination: "/Users/me/Code/trip",
      initializeGit: true,
      initialCommit: true,
      writeGitignore: true,
    });
    assert.strictEqual(promote.expectedUpdatedAt, undefined);
    const blankDestination = yield* Effect.result(
      Schema.decodeUnknownEffect(ProjectsPromoteChatInput)({ ...promote, destination: " " }),
    );
    assert.strictEqual(blankDestination._tag, "Failure");

    const error = yield* Schema.decodeUnknownEffect(ProjectChatError)({
      _tag: "ProjectChatError",
      reason: "busy",
      message: "A thread is still working.",
    });
    assert.strictEqual(error.reason, "busy");
  }),
);

it.effect("decodes the additive chat wire fields, with and without them", () =>
  Effect.gen(function* () {
    // A chat folder moving into a project travels as an existing reason with a cause, so
    // clients that predate it decode it and show the retry hint.
    const relocating = yield* Schema.decodeUnknownEffect(TerminalCwdError)(
      yield* Schema.encodeUnknownEffect(TerminalCwdError)(
        new TerminalCwdError({
          cwd: "/chats/trip",
          reason: "statFailed",
          cause: new Error(PROJECT_RELOCATION_PENDING_MESSAGE),
        }),
      ),
    );
    assert.include(relocating.message, PROJECT_RELOCATION_PENDING_MESSAGE);
    const unknownReason = yield* Effect.result(
      Schema.decodeUnknownEffect(TerminalCwdError)({
        _tag: "TerminalCwdError",
        cwd: "/chats/trip",
        reason: "relocationPending",
      }),
    );
    assert.strictEqual(unknownReason._tag, "Failure");
    const cleanup = new TerminalCwdError({ cwd: "/checkout", reason: "cleanupPending" });
    assert.include(cleanup.message, "Checkout cleanup is pending");

    // A node that predates the reason sends none; the client then only shows the message.
    const plain = yield* Schema.decodeUnknownEffect(OrchestrationDispatchCommandError)({
      _tag: "OrchestrationDispatchCommandError",
      message: "Failed to dispatch orchestration command",
    });
    assert.strictEqual(plain.reason, undefined);
    const retired = yield* Schema.decodeUnknownEffect(OrchestrationDispatchCommandError)({
      _tag: "OrchestrationDispatchCommandError",
      message: "This chat was cleaned up before its first message was sent.",
      reason: "chat-project-retired",
    });
    assert.strictEqual(retired.reason, "chat-project-retired");

    const trashed = {
      threadId: "thread-chat",
      projectId: "project-chat",
      projectTitle: "Trip",
      projectAvailable: true,
      title: "Trip",
      branch: null,
      worktreePath: null,
      worktreeId: null,
      archivedAt: null,
      trashedAt: at,
      createdAt: at,
      updatedAt: at,
    };
    const legacy = yield* Schema.decodeUnknownEffect(TrashedThreadSummary)(trashed);
    assert.isFalse("projectKind" in legacy);
    const chat = yield* Schema.decodeUnknownEffect(TrashedThreadSummary)({
      ...trashed,
      projectKind: "chat",
    });
    assert.strictEqual(chat.projectKind, "chat");

    assert.strictEqual(
      yield* Schema.decodeUnknownEffect(ProjectChatDestinationStatus)("retired-checkout"),
      "retired-checkout",
    );
  }),
);
