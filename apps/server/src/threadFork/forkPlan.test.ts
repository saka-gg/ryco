import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { createFileAttachmentId, inheritedAttachmentId } from "../attachmentStore.ts";
import { isInheritedItemId } from "../orchestration/forkInheritance.ts";
import { resolveForkBoundary } from "./forkBoundary.ts";
import { sourceHistory, turnRow } from "./forkHistory.fixtures.ts";
import { ThreadForkPublishCommand } from "./forkLedger.ts";
import {
  buildForkPublication,
  FORK_MAX_INHERITED_ACTIVITIES,
  FORK_SKIPPED_ATTACHMENTS_NOTICE,
  type ForkPublicationInput,
  finalizeForkPublication,
  forkThreadTitle,
  withoutUnlinkedAttachments,
} from "./forkPlan.ts";

const forkThreadId = ThreadId.make("fork-0123456789abcdef0123456789abcdef");
const sourceThreadId = ThreadId.make("thread-source");
const at = (seconds: number) => `2026-10-11T10:00:${String(seconds).padStart(2, "0")}.000Z`;

const attachment: ChatAttachment = {
  type: "file",
  id: createFileAttachmentId(sourceThreadId, "spec.pdf")!,
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 10,
};

const plan = (id: string, turnId: string | null, seconds: number, implementedAt?: number) =>
  ({
    id,
    turnId: turnId === null ? null : TurnId.make(turnId),
    planMarkdown: `# ${id}`,
    implementedAt: implementedAt === undefined ? null : at(implementedAt),
    implementationThreadId: implementedAt === undefined ? null : ThreadId.make("thread-impl"),
    createdAt: at(seconds),
    updatedAt: at(seconds),
  }) satisfies OrchestrationProposedPlan;

const activity = (id: string, kind: string, turnId: string, seconds: number, sequence?: number) =>
  ({
    id: EventId.make(id),
    tone: "tool",
    kind,
    summary: kind,
    payload: { id },
    turnId: TurnId.make(turnId),
    ...(sequence === undefined ? {} : { sequence }),
    createdAt: at(seconds),
  }) satisfies OrchestrationThreadActivity;

function publicationInput(overrides: Partial<ForkPublicationInput> = {}): ForkPublicationInput {
  const history = sourceHistory();
  const messages = history.messages.map((entry) =>
    entry.id === "user-2" ? { ...entry, attachments: [attachment] } : entry,
  );
  const boundary = resolveForkBoundary({
    messages,
    turns: history.turns,
    session: null,
    messageId: MessageId.make("assistant-2b"),
  });
  if (!boundary.ok) throw new Error(boundary.detail);
  return {
    forkThreadId,
    commandId: CommandId.make("thread-fork:abc:publish"),
    projectId: ProjectId.make("project-1"),
    createdAt: at(50),
    source: {
      threadId: sourceThreadId,
      title: "  Refactor the parser ",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      tokenMode: "balanced",
    },
    boundary,
    turns: history.turns,
    proposedPlans: [
      plan("plan-1", "turn-1", 5, 11),
      plan("plan-2", "turn-2", 15, 30),
      plan("plan-3", "turn-3", 25),
      plan("plan-loose-early", null, 2),
      plan("plan-loose-late", null, 40),
    ],
    activities: [
      activity("tool-1", "tool.completed", "turn-1", 3, 7),
      activity("approval-1", "approval.requested", "turn-1", 3),
      activity("handoff-2", "context-handoff", "turn-2", 11),
      activity("plan-update-2", "turn.plan.updated", "turn-2", 12, 9),
      activity("tool-3", "tool.started", "turn-3", 22),
    ],
    outcome: {
      checkout: { kind: "current-checkout", worktreePath: "/repo", branch: "main" },
      sourceWorktreeId: WorktreeId.make("worktree-project-1-main"),
      providerContext: "native",
      notices: [],
    },
    ...overrides,
  };
}

describe("buildForkPublication", () => {
  it("publishes the inherited history under fork-owned ids, in order, with source settings", () => {
    const { command, attachments, historyNotices } = buildForkPublication(publicationInput());
    expect(Schema.decodeUnknownSync(ThreadForkPublishCommand)(command)).toEqual(command);
    expect(command.title).toBe("Refactor the parser (fork)");
    expect(command).toMatchObject({
      threadId: forkThreadId,
      sourceThreadId,
      sourceMessageId: "assistant-2b",
      sourceTurnId: "turn-2",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      tokenMode: "balanced",
      createdAt: at(50),
    });
    expect(command.messages.map((entry) => entry.id)).toEqual(
      [
        "user-1",
        "assistant-1",
        "user-2",
        "assistant-2a",
        "steer-2",
        "assistant-2b",
        "system-2",
      ].map((id) => `${forkThreadId}:inherited:${id}`),
    );
    expect(command.messages.every((entry) => isInheritedItemId(forkThreadId, entry.id))).toBe(true);
    expect(command.messages.every((entry) => !entry.streaming)).toBe(true);
    // Prompts are linked to the turn they started; steers keep theirs.
    expect(command.messages.map((entry) => entry.turnId)).toEqual([
      "turn-1",
      "turn-1",
      "turn-2",
      "turn-2",
      "turn-2",
      "turn-2",
      "turn-2",
    ]);
    expect(command.messages[4]?.dispatchMode).toBe("steer");

    const copyId = inheritedAttachmentId({ forkThreadId, sourceAttachmentId: attachment.id! });
    expect(command.messages[2]?.attachments).toEqual([{ ...attachment, id: copyId }]);
    expect(attachments).toEqual([{ source: attachment, attachmentId: copyId }]);
    expect(historyNotices).toEqual([]);
  });

  it("records the inherited turns that were interrupted or failed, for a fork of the fork", () => {
    const history = sourceHistory();
    const turns = [
      // Failed before it replied: the fork has no row for it.
      turnRow("turn-0", 0, null, { state: "error" }),
      ...history.turns.map((turn) =>
        turn.turnId === "turn-1"
          ? { ...turn, state: "interrupted" as const }
          : turn.turnId === "turn-3"
            ? { ...turn, state: "error" as const }
            : turn,
      ),
    ];
    const boundary = resolveForkBoundary({
      messages: history.messages,
      turns,
      session: null,
      messageId: MessageId.make("assistant-2b"),
    });
    if (!boundary.ok) throw new Error(boundary.detail);
    expect(boundary.inheritedTurnIds).toEqual(["turn-0", "turn-1", "turn-2"]);

    const { command } = buildForkPublication(publicationInput({ boundary, turns }));
    // Only inherited turns with a reply; turn 3 comes after the boundary.
    expect(command.forked.inheritedTurnOutcomes).toEqual([
      { turnId: "turn-1", state: "interrupted" },
    ]);
    expect(Schema.decodeUnknownSync(ThreadForkPublishCommand)(command)).toEqual(command);
    // Absent when every inherited turn completed.
    expect(buildForkPublication(publicationInput()).command.forked).not.toHaveProperty(
      "inheritedTurnOutcomes",
    );
  });

  it("carries plans of inherited turns, forgetting implementations after the boundary", () => {
    const { command } = buildForkPublication(publicationInput());
    expect(command.proposedPlans.map((entry) => entry.id)).toEqual(
      ["plan-loose-early", "plan-1", "plan-2"].map((id) => `${forkThreadId}:inherited:${id}`),
    );
    const [, implementedBefore, implementedAfter] = command.proposedPlans;
    expect(implementedBefore?.implementedAt).toBe(at(11));
    expect(implementedBefore?.implementationThreadId).toBe("thread-impl");
    expect(implementedAfter?.implementedAt).toBeNull();
    expect(implementedAfter?.implementationThreadId).toBeNull();
  });

  it("copies only display-only activity of inherited turns, without provider sequences", () => {
    const { command } = buildForkPublication(publicationInput());
    expect(command.activities).toEqual([
      {
        id: `${forkThreadId}:inherited:tool-1`,
        tone: "tool",
        kind: "tool.completed",
        summary: "tool.completed",
        payload: { id: "tool-1" },
        turnId: "turn-1",
        createdAt: at(3),
      },
      {
        id: `${forkThreadId}:inherited:plan-update-2`,
        tone: "tool",
        kind: "turn.plan.updated",
        summary: "turn.plan.updated",
        payload: { id: "plan-update-2" },
        turnId: "turn-2",
        createdAt: at(12),
      },
    ]);
  });

  it("keeps the newest activity when there is too much, and says so", () => {
    const activities = Array.from({ length: FORK_MAX_INHERITED_ACTIVITIES + 5 }, (_, index) => ({
      ...activity(`tool-${String(index).padStart(5, "0")}`, "tool.updated", "turn-2", 12),
    }));
    const { command, historyNotices } = buildForkPublication(publicationInput({ activities }));
    expect(command.activities).toHaveLength(FORK_MAX_INHERITED_ACTIVITIES);
    expect(command.activities[0]?.id).toBe(`${forkThreadId}:inherited:tool-00005`);
    expect(historyNotices).toEqual(["Older tool activity was not carried over."]);
    expect(command.forked.notices).toEqual(historyNotices);
  });

  it("records provenance and is deterministic", () => {
    const input = publicationInput();
    const first = buildForkPublication(input);
    expect(buildForkPublication(input)).toEqual(first);
    expect(first.command.forked).toEqual({
      schemaVersion: 1,
      sourceThreadId,
      sourceMessageId: "assistant-2b",
      sourceTurnId: "turn-2",
      sourceTitle: "Refactor the parser",
      inheritedMessageCount: 7,
      providerContext: "native",
      checkout: { kind: "current-checkout", worktreePath: "/repo", branch: "main" },
      notices: [],
    });
    expect(first.command).toMatchObject({
      branch: "main",
      worktreePath: "/repo",
      worktreeId: "worktree-project-1-main",
      newWorktree: null,
    });
  });
});

describe("finalizeForkPublication", () => {
  it("places the fork in a new worktree and records the handoff reason", () => {
    const { command, historyNotices } = buildForkPublication(publicationInput());
    const finalized = finalizeForkPublication(
      command,
      {
        checkout: {
          kind: "new-worktree",
          worktreeId: WorktreeId.make("worktree-fork-abc"),
          worktreePath: "/worktrees/fork",
          branch: "ryco/fork-abcd1234",
          start: "checkpoint",
          baseRef: "a".repeat(40),
        },
        sourceWorktreeId: WorktreeId.make("ignored"),
        providerContext: "handoff",
        handoffReason: "native-fork-uncertain",
        notices: ["  Codex may have created an unused copy.  "],
      },
      historyNotices,
    );
    expect(Schema.decodeUnknownSync(ThreadForkPublishCommand)(finalized)).toEqual(finalized);
    expect(finalized).toMatchObject({
      branch: "ryco/fork-abcd1234",
      worktreePath: "/worktrees/fork",
      worktreeId: "worktree-fork-abc",
      newWorktree: {
        worktreeId: "worktree-fork-abc",
        branch: "ryco/fork-abcd1234",
        worktreePath: "/worktrees/fork",
      },
    });
    expect(finalized.forked).toMatchObject({
      providerContext: "handoff",
      handoffReason: "native-fork-uncertain",
      notices: ["Codex may have created an unused copy."],
    });
    // Inherited history is untouched.
    expect(finalized.messages).toBe(command.messages);

    const chat = finalizeForkPublication(
      finalized,
      {
        checkout: { kind: "new-chat", folder: "/chats/2026-10-11-fork" },
        sourceWorktreeId: null,
        providerContext: "native",
        handoffReason: "provider-unsupported",
        notices: [],
      },
      historyNotices,
    );
    expect(chat).toMatchObject({
      branch: null,
      worktreePath: null,
      worktreeId: null,
      newWorktree: null,
    });
    expect("handoffReason" in chat.forked).toBe(false);
  });
});

describe("withoutUnlinkedAttachments", () => {
  it("drops only attachments whose copy was never linked, and shows the notice once", () => {
    const { command, attachments } = buildForkPublication(publicationInput());
    const copyId = attachments[0]!.attachmentId;
    expect(withoutUnlinkedAttachments(command, new Set())).toBe(command);
    const stripped = withoutUnlinkedAttachments(command, new Set([copyId]));
    expect(stripped.messages[2]?.attachments).toEqual([]);
    expect(
      stripped.messages.flatMap((message) => message.attachments ?? []).map((entry) => entry.id),
    ).not.toContain(copyId);
    // Every other message is the same object.
    expect(
      stripped.messages.filter((message, index) => message !== command.messages[index]),
    ).toHaveLength(1);
    expect(Schema.decodeUnknownSync(ThreadForkPublishCommand)(stripped)).toEqual(stripped);

    // History and run notices can name the same skip: it is shown once.
    const finalized = finalizeForkPublication(
      stripped,
      {
        checkout: { kind: "current-checkout", worktreePath: "/repo", branch: "main" },
        sourceWorktreeId: null,
        providerContext: "handoff",
        handoffReason: "provider-unsupported",
        notices: [FORK_SKIPPED_ATTACHMENTS_NOTICE],
      },
      [FORK_SKIPPED_ATTACHMENTS_NOTICE],
    );
    expect(finalized.forked.notices).toEqual([FORK_SKIPPED_ATTACHMENTS_NOTICE]);
  });
});

describe("forkThreadTitle", () => {
  it("fits the suffix and never splits a surrogate pair", () => {
    expect(forkThreadTitle("")).toBe("Untitled (fork)");
    const long = forkThreadTitle(`${"a".repeat(192)}😀😀`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("a (fork)")).toBe(true);
  });
});
