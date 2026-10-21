import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { canSettleThread } from "@ryco/shared/threadSettlement";
import { canSnoozeThread } from "@ryco/shared/threadSnooze";
import { describe, expect, it } from "vite-plus/test";

import { inheritedItemId } from "./forkInheritance.ts";
import {
  nodeAutoSettleAfterDays,
  shellSettlementPolicy,
  threadSettlementInput,
  threadShellSettlementInput,
} from "./threadSettlementInput.ts";

const SOURCE = ThreadId.make("thread-source");
const FORK = ThreadId.make("fork-settle");
const SOURCE_TURN = TurnId.make("turn-source");
const FORKED_AT = "2026-10-11T10:00:50.000Z";
// Within the queued-turn grace window of the inherited prompt (10:00:00).
const NOW = "2026-10-11T10:01:05.000Z";

const message = (
  id: string,
  role: "user" | "assistant",
  createdAt: string,
  turnId: TurnId | null = SOURCE_TURN,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text: role,
  turnId,
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

const inherited = (id: string) =>
  inheritedItemId({ forkThreadId: FORK, sourceThreadId: SOURCE, sourceItemId: id });

// A fork right after publication: inherited history only, no turn of its own yet.
const fork: OrchestrationThread = {
  id: FORK,
  projectId: ProjectId.make("project-settle"),
  title: "Source (fork)",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: FORKED_AT,
  updatedAt: FORKED_AT,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    message(inherited("message-question"), "user", "2026-10-11T10:00:00.000Z"),
    message(inherited("message-answer"), "assistant", "2026-10-11T10:00:40.000Z"),
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const readModelWith = (thread: OrchestrationThread): OrchestrationReadModel => ({
  snapshotSequence: 1,
  projects: [],
  threads: [thread],
  updatedAt: FORKED_AT,
});

describe("threadSettlementInput", () => {
  it("leaves a fork's inherited prompts out of its own user recency, like the shell", () => {
    const input = threadSettlementInput(readModelWith(fork), fork, NOW);
    expect(input.latestUserMessageAt).toBeNull();
    expect(canSettleThread(input)).toEqual({ canSettle: true, blocker: null });
    expect(canSnoozeThread(input).canSnooze).toBe(true);

    // The projected shell (and so every client) holds no own prompt for a fresh fork.
    const shellInput = threadShellSettlementInput(
      {
        ...fork,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      } as unknown as OrchestrationThreadShell,
      NOW,
    );
    expect(canSettleThread(shellInput)).toEqual(canSettleThread(input));
    expect(canSnoozeThread(shellInput)).toEqual(canSnoozeThread(input));
  });

  it("still sees the fork's own queued prompt", () => {
    const ownPrompt = message("message-own", "user", "2026-10-11T10:01:00.000Z", null);
    const withOwnPrompt = { ...fork, messages: [...fork.messages, ownPrompt] };
    const input = threadSettlementInput(readModelWith(withOwnPrompt), withOwnPrompt, NOW);
    expect(input.latestUserMessageAt).toBe(ownPrompt.createdAt);
    expect(canSettleThread(input)).toEqual({ canSettle: false, blocker: "queued-turn" });
    expect(canSnoozeThread(input).canSnooze).toBe(false);
  });
});

describe("nodeAutoSettleAfterDays", () => {
  it("is the node's own rule, else the shared default; Off stays off", () => {
    expect(nodeAutoSettleAfterDays({})).toBe(7);
    expect(nodeAutoSettleAfterDays({ threadAutoSettleAfterDays: 30 })).toBe(30);
    expect(nodeAutoSettleAfterDays({ threadAutoSettleAfterDays: null })).toBeNull();
    expect(shellSettlementPolicy({ threadAutoSettleAfterDays: null })).toEqual({
      autoSettleAfterDays: null,
    });
  });
});
