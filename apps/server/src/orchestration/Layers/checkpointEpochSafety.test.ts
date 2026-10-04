import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerRollbackEpochViolation } from "./CheckpointReactor.ts";

const now = "2026-08-04T00:00:00.000Z";

function threadWithHandoff(input: {
  readonly activeRuntime: string;
  readonly targetRuntime?: string;
  readonly boundaryTurnCount: number;
}): OrchestrationThread {
  const targetTurnId = TurnId.make(`target-turn-${input.boundaryTurnCount}`);
  return {
    id: ThreadId.make("thread-checkpoint-handoff"),
    projectId: ProjectId.make("project-checkpoint-handoff"),
    title: "Checkpoint handoff",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude_work"),
      model: "claude-fable-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/tmp/worktree",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("target-message"),
        role: "user",
        text: "Continue here",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    proposedPlans: [],
    activities: [
      {
        id: EventId.make("handoff-activity"),
        tone: "info",
        kind: "context-handoff",
        summary: "Context handoff completed",
        payload: {
          schemaVersion: 1,
          handoffId: "handoff-1",
          mode: "full-context-fresh-session",
          status: "consumed",
          targetMessageId: "target-message",
          targetTurnId,
          sourceSelection: { instanceId: "codex_work", model: "gpt-5.6" },
          targetSelection: { instanceId: "claude_work", model: "claude-fable-5" },
          sourceRuntimeSessionId: "runtime-a1",
          ...(input.targetRuntime !== undefined
            ? { targetRuntimeSessionId: input.targetRuntime }
            : {}),
          sources: [
            {
              providerInstanceId: "codex_work",
              driverKind: "codex",
              modelSlug: "gpt-5.6",
            },
          ],
          target: {
            providerInstanceId: "claude_work",
            driverKind: "claudeAgent",
            modelSlug: "claude-fable-5",
          },
          contextVersion: 1,
          contextDigest: "a".repeat(64),
        },
        turnId: null,
        createdAt: now,
      },
    ],
    checkpoints: [
      {
        turnId: TurnId.make("source-turn-1"),
        checkpointTurnCount: input.boundaryTurnCount - 1,
        checkpointRef: CheckpointRef.make(`checkpoint-source-${input.boundaryTurnCount - 1}`),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-08-03T23:59:59.000Z",
      },
      {
        turnId: targetTurnId,
        checkpointTurnCount: input.boundaryTurnCount,
        checkpointRef: CheckpointRef.make(`checkpoint-target-${input.boundaryTurnCount}`),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: now,
      },
      {
        turnId: TurnId.make("target-turn-later"),
        checkpointTurnCount: input.boundaryTurnCount + 1,
        checkpointRef: CheckpointRef.make(`checkpoint-target-${input.boundaryTurnCount + 1}`),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-08-04T00:01:00.000Z",
      },
    ],
    session: {
      threadId: ThreadId.make("thread-checkpoint-handoff"),
      status: "ready",
      providerName: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claude_work"),
      runtimeSessionId: RuntimeSessionId.make(input.activeRuntime),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
  };
}

describe("provider rollback epoch safety", () => {
  it("allows rollback to the checkpoint of the turn that carried the handoff", () => {
    const thread = threadWithHandoff({
      activeRuntime: "runtime-b1",
      targetRuntime: "runtime-b1",
      boundaryTurnCount: 4,
    });
    expect(providerRollbackEpochViolation(thread, 4)).toBeNull();
  });

  it("rejects rollback to the epoch baseline, which drops the handoff turn", () => {
    const thread = threadWithHandoff({
      activeRuntime: "runtime-b1",
      targetRuntime: "runtime-b1",
      boundaryTurnCount: 4,
    });
    expect(providerRollbackEpochViolation(thread, 3)).toBe(
      "Reverting to checkpoint 3 would discard the turn that carried the context handoff (checkpoint 4). Revert to checkpoint 4 or later. Nothing was changed.",
    );
  });

  it("rejects rollback that includes turns from the source epoch", () => {
    const thread = threadWithHandoff({
      activeRuntime: "runtime-b1",
      targetRuntime: "runtime-b1",
      boundaryTurnCount: 4,
    });
    expect(providerRollbackEpochViolation(thread, 2)).toContain(
      "would discard the turn that carried the context handoff",
    );
  });

  it("rejects A→B→A rollback when the latest A epoch identity cannot be proved", () => {
    const thread = threadWithHandoff({
      activeRuntime: "runtime-a2",
      targetRuntime: "runtime-a1",
      boundaryTurnCount: 7,
    });
    expect(providerRollbackEpochViolation(thread, 6)).toContain(
      "active runtime epoch could not be verified",
    );
  });

  it("rejects rollback when a new boundary lacks epoch metadata", () => {
    const thread = threadWithHandoff({
      activeRuntime: "runtime-b1",
      boundaryTurnCount: 4,
    });
    expect(providerRollbackEpochViolation(thread, 3)).toContain(
      "active runtime epoch could not be verified",
    );
  });
});
