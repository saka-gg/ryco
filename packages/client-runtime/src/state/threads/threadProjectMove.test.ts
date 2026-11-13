import { CommandId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveRevertTurnCountByUserMessageId } from "../session/checkpointRevert.ts";
import { deriveUndoTurnCountByTurnId, isForkableCheckpointSummary } from "./checkpointSummary.ts";
import {
  listMoveTargetProjects,
  threadMoveConfirmation,
  threadMoveNotices,
  threadProjectMoveCommand,
  threadSummaryMoveBlocker,
} from "./threadProjectMove.ts";
import type { TurnDiffSummary } from "./types.ts";

const idle = {
  archivedAt: null,
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  backgroundLiveness: null,
} as const;

describe("threadSummaryMoveBlocker", () => {
  it("lets an idle thread move and names what keeps a busy one in place", () => {
    expect(threadSummaryMoveBlocker(idle)).toBeNull();
    expect(threadSummaryMoveBlocker({ ...idle, archivedAt: "2026-11-01T00:00:00.000Z" })).toBe(
      "thread-archived",
    );
    expect(
      threadSummaryMoveBlocker({
        ...idle,
        latestTurn: { state: "running" } as never,
      }),
    ).toBe("session-running");
    expect(threadSummaryMoveBlocker({ ...idle, hasPendingApprovals: true })).toBe(
      "pending-approval",
    );
    expect(threadSummaryMoveBlocker({ ...idle, hasPendingUserInput: true })).toBe(
      "pending-user-input",
    );
    expect(threadSummaryMoveBlocker({ ...idle, backgroundLiveness: "working" })).toBe(
      "background-work",
    );
    expect(threadSummaryMoveBlocker({ ...idle, backgroundLiveness: "monitoring" })).toBeNull();
  });
});

describe("listMoveTargetProjects", () => {
  it("offers the other projects by name, never the current one or a chat's folder", () => {
    const projects = [
      { id: ProjectId.make("b"), name: "Beta" },
      { id: ProjectId.make("a"), name: "Alpha" },
      { id: ProjectId.make("current"), name: "Current" },
      { id: ProjectId.make("chat"), name: "A chat", kind: "chat" as const },
    ];
    expect(listMoveTargetProjects(projects, ProjectId.make("current")).map((p) => p.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});

describe("threadMoveNotices", () => {
  const none = {
    sourceProjectName: "Alpha",
    worktreePath: null,
    chatFolderPath: null,
    activePullRequestWatches: 0,
    commandWatchCount: 0,
    delegatedTaskCount: 0,
    hasFileChanges: false,
  };

  it("asks nothing when nothing stays behind", () => {
    expect(threadMoveNotices(none)).toEqual([]);
    expect(
      threadMoveConfirmation({ threadTitle: "T", targetName: "Beta", notices: [] }),
    ).toBeNull();
  });

  it("names each thing that does not come along", () => {
    const notices = threadMoveNotices({
      ...none,
      worktreePath: "/tmp/alpha-worktree",
      activePullRequestWatches: 1,
      delegatedTaskCount: 2,
      hasFileChanges: true,
    });
    expect(notices).toEqual([
      "Its worktree stays in Alpha: /tmp/alpha-worktree",
      "Changes from earlier turns can no longer be undone or shown as diffs.",
      "Ryco stops watching for it.",
      "Its 2 delegated tasks stay in Alpha.",
    ]);
    expect(
      threadMoveConfirmation({ threadTitle: "Login fix", targetName: "Beta", notices }),
    ).toContain('Move "Login fix" to Beta?');
    expect(threadMoveNotices({ ...none, chatFolderPath: "/chats/one" })).toEqual([
      "Files in its chat folder stay there: /chats/one",
    ]);
  });
});

describe("threadProjectMoveCommand", () => {
  const base = {
    commandId: CommandId.make("move"),
    threadId: ThreadId.make("thread"),
    threadTitle: "Login fix",
    currentProjectId: ProjectId.make("alpha"),
    createdAt: "2026-11-01T00:00:00.000Z",
  };

  it("fences the move on the project the client saw", () => {
    expect(
      threadProjectMoveCommand({
        ...base,
        target: { kind: "project", projectId: ProjectId.make("beta") },
      }),
    ).toEqual({
      type: "thread.project.move",
      commandId: "move",
      threadId: "thread",
      expectedProjectId: "alpha",
      projectId: "beta",
      createdAt: base.createdAt,
    });
  });

  it("asks the node to create the new chat for a move to No project", () => {
    expect(
      threadProjectMoveCommand({
        ...base,
        target: { kind: "new-chat", projectId: ProjectId.make("chat-new") },
      }),
    ).toMatchObject({
      projectId: "chat-new",
      createChatProject: { projectId: "chat-new", titleSeed: "Login fix" },
    });
  });
});

describe("checkpoints from before a move", () => {
  const summary = (turnCount: number): TurnDiffSummary => ({
    turnId: TurnId.make(`turn-${turnCount}`),
    completedAt: "2026-11-01T00:00:00.000Z",
    status: "ready",
    checkpointRef: `refs/ryco/checkpoints/x/turn/${turnCount}` as TurnDiffSummary["checkpointRef"],
    checkpointTurnCount: turnCount,
    assistantMessageId: `assistant-${turnCount}` as never,
    files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }],
  });
  const summaries = [summary(1), summary(2), summary(3)];

  it("offers undo only for turns after the move", () => {
    const undo = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: summaries,
      inferredCheckpointTurnCountByTurnId: {},
      checkpointFloor: 2,
    });
    expect([...undo.entries()]).toEqual([[TurnId.make("turn-3"), 2]]);
    expect(
      deriveUndoTurnCountByTurnId({
        turnDiffSummaries: summaries,
        inferredCheckpointTurnCountByTurnId: {},
      }).size,
    ).toBe(3);
  });

  it("offers Edit from here only for messages after the move", () => {
    const byAssistant = new Map(summaries.map((entry) => [entry.assistantMessageId!, entry]));
    const messages = summaries.flatMap((entry) => [
      { id: `user-${entry.checkpointTurnCount}` as never, role: "user" },
      { id: entry.assistantMessageId!, role: "assistant" },
    ]);
    const revert = deriveRevertTurnCountByUserMessageId({
      messages,
      turnDiffSummaryByAssistantMessageId: byAssistant,
      inferredCheckpointTurnCountByTurnId: {},
      checkpointFloor: 2,
    });
    expect([...revert.entries()]).toEqual([["user-3", 2]]);
  });

  it("starts a fork's worktree only from a checkpoint captured after the move", () => {
    expect(isForkableCheckpointSummary(summary(2), 2)).toBe(false);
    expect(isForkableCheckpointSummary(summary(3), 2)).toBe(true);
    expect(isForkableCheckpointSummary(summary(1), null)).toBe(true);
  });
});
