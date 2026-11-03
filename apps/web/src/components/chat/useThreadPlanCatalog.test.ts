import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyOrchestrationEvents, syncServerThreadDetail, type AppState } from "../../store";
import { createThreadPlanCatalogSelector } from "./useThreadPlanCatalog";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-plans");
const createdAt = "2026-06-12T10:00:00.000Z";

function loadedState(): AppState {
  return syncServerThreadDetail(
    { activeEnvironmentId: null, environmentStateById: {} },
    {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Plans",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      worktreeId: null,
      manualStatusBucket: null,
      manualPosition: 0,
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-reply"),
          role: "assistant",
          text: "Hel",
          turnId: null,
          streaming: true,
          createdAt,
          updatedAt: createdAt,
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    } as unknown as OrchestrationThread,
    environmentId,
  );
}

let sequence = 0;
function event(type: OrchestrationEvent["type"], payload: object): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: new Date(Date.parse(createdAt) + sequence * 1_000).toISOString(),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as unknown as OrchestrationEvent;
}

describe("createThreadPlanCatalogSelector", () => {
  it("keeps the catalog through a streamed delta, which replaces the shell", () => {
    const select = createThreadPlanCatalogSelector([threadId]);
    const before = loadedState();
    const catalog = select(before);
    expect(catalog).toEqual([{ id: threadId, proposedPlans: [] }]);

    const after = applyOrchestrationEvents(
      before,
      [
        event("thread.message-sent", {
          threadId,
          messageId: MessageId.make("message-reply"),
          role: "assistant",
          text: "lo",
          turnId: null,
          streaming: true,
          createdAt,
          updatedAt: createdAt,
        }),
      ],
      environmentId,
    );
    // The delta moved the shell's `updatedAt`, so the shell is a new object.
    expect(after.environmentStateById[environmentId]!.threadShellById[threadId]).not.toBe(
      before.environmentStateById[environmentId]!.threadShellById[threadId],
    );
    expect(select(after)).toBe(catalog);
  });

  it("returns a new catalog when a proposed plan is upserted", () => {
    const select = createThreadPlanCatalogSelector([threadId]);
    const before = loadedState();
    const catalog = select(before);
    const after = applyOrchestrationEvents(
      before,
      [
        event("thread.proposed-plan-upserted", {
          threadId,
          proposedPlan: {
            id: "plan-1",
            turnId: null,
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ],
      environmentId,
    );
    const next = select(after);
    expect(next).not.toBe(catalog);
    expect(next[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
  });

  it("drops a thread no shell lists and keeps that result stable", () => {
    const select = createThreadPlanCatalogSelector([ThreadId.make("missing")]);
    const state = loadedState();
    const catalog = select(state);
    expect(catalog).toEqual([]);
    expect(select(state)).toBe(catalog);
  });
});
