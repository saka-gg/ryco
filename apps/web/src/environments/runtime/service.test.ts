import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useStore } from "~/store";
import {
  applyEnvironmentThreadDetailEvent,
  classifyProjectionSnapshot,
  flushEnvironmentThreadDetailEvents,
  shouldApplyProjectionEvent,
  shouldApplyProjectionSnapshot,
  shouldApplyTerminalEvent,
} from "./service";

describe("shouldApplyTerminalEvent", () => {
  it("applies terminal events for draft-only threads", () => {
    expect(
      shouldApplyTerminalEvent({
        serverThreadArchivedAt: undefined,
        hasDraftThread: true,
      }),
    ).toBe(true);
  });

  it("drops terminal events for unknown threads", () => {
    expect(
      shouldApplyTerminalEvent({
        serverThreadArchivedAt: undefined,
        hasDraftThread: false,
      }),
    ).toBe(false);
  });

  it("drops terminal events for archived server threads even if a draft exists", () => {
    expect(
      shouldApplyTerminalEvent({
        serverThreadArchivedAt: "2026-04-09T00:00:00.000Z",
        hasDraftThread: true,
      }),
    ).toBe(false);
  });

  it("applies terminal events for active server threads", () => {
    expect(
      shouldApplyTerminalEvent({
        serverThreadArchivedAt: null,
        hasDraftThread: false,
      }),
    ).toBe(true);
  });
});

describe("shouldApplyProjectionSnapshot", () => {
  it("accepts the first snapshot for an environment", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: null,
        next: {
          snapshotSequence: 1,
          updatedAt: "2026-04-22T10:00:00.000Z",
        },
      }),
    ).toBe(true);
  });

  it("drops snapshots with an older sequence", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        next: {
          snapshotSequence: 4,
          updatedAt: "2026-04-22T10:06:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("drops snapshots with the same sequence and older timestamp", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        next: {
          snapshotSequence: 5,
          updatedAt: "2026-04-22T10:04:59.000Z",
        },
      }),
    ).toBe(false);
  });

  it("accepts snapshots with the same sequence and a newer timestamp", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        next: {
          snapshotSequence: 5,
          updatedAt: "2026-04-22T10:05:01.000Z",
        },
      }),
    ).toBe(true);
  });

  it("classifies an unchanged replay snapshot as current", () => {
    expect(
      classifyProjectionSnapshot({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        next: {
          snapshotSequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
      }),
    ).toBe("current");
  });
});

describe("shouldApplyProjectionEvent", () => {
  it("accepts the first event for an environment", () => {
    expect(
      shouldApplyProjectionEvent({
        current: null,
        sequence: 1,
      }),
    ).toBe(true);
  });

  it("drops stale or duplicate events", () => {
    expect(
      shouldApplyProjectionEvent({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        sequence: 5,
      }),
    ).toBe(false);
    expect(
      shouldApplyProjectionEvent({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        sequence: 4,
      }),
    ).toBe(false);
  });

  it("accepts newer events", () => {
    expect(
      shouldApplyProjectionEvent({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        sequence: 6,
      }),
    ).toBe(true);
  });
});

describe("frame-batched thread detail events", () => {
  const environmentId = EnvironmentId.make("environment-detail-batch");
  const projectId = ProjectId.make("project-detail-batch");
  const threadId = ThreadId.make("thread-detail-batch");
  const messageId = MessageId.make("message-detail-batch");
  let sequence = 1;

  afterEach(() => {
    flushEnvironmentThreadDetailEvents();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  });

  function seedThread() {
    useStore.getState().syncServerShellSnapshot(
      {
        snapshotSequence: 1,
        projects: [
          {
            id: projectId,
            title: "Project",
            workspaceRoot: "/tmp/project-detail-batch",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
        worktrees: [],
        threads: [
          {
            id: threadId,
            projectId,
            title: "Thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            worktreeId: null,
            manualStatusBucket: null,
            manualPosition: 0,
            latestTurn: null,
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            session: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
        ],
        updatedAt: "2026-10-01T00:00:00.000Z",
      } as unknown as OrchestrationShellSnapshot,
      environmentId,
    );
  }

  function messageSent(text: string, streaming: boolean): OrchestrationEvent {
    sequence += 1;
    return {
      sequence,
      eventId: `event-detail-batch-${sequence}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-10-01T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId,
        role: "assistant",
        text,
        turnId: null,
        streaming,
        createdAt: "2026-10-01T00:00:01.000Z",
        updatedAt: "2026-10-01T00:00:01.000Z",
      },
    } as unknown as OrchestrationEvent;
  }

  function storedMessage() {
    return useStore.getState().environmentStateById[environmentId]?.messageByThreadId[threadId]?.[
      messageId
    ];
  }

  function applyFrame(events: ReadonlyArray<OrchestrationEvent>) {
    for (const event of events) applyEnvironmentThreadDetailEvent(event, environmentId);
    flushEnvironmentThreadDetailEvents();
  }

  it("keeps earlier text when a delta and its empty completion share a frame", () => {
    seedThread();
    applyFrame([messageSent("Earlier ", true)]);
    applyFrame([messageSent("tail", true), messageSent("", false)]);

    expect(storedMessage()?.text).toBe("Earlier tail");
    expect(storedMessage()?.streaming).toBe(false);
  });

  it("lets a completion that carries the full text replace the streamed text", () => {
    seedThread();
    applyFrame([messageSent("Earlier ", true)]);
    applyFrame([messageSent("tail", true), messageSent("Full text", false)]);

    expect(storedMessage()?.text).toBe("Full text");
    expect(storedMessage()?.streaming).toBe(false);
  });

  it("appends consecutive deltas of one frame", () => {
    seedThread();
    applyFrame([messageSent("a", true), messageSent("b", true)]);

    expect(storedMessage()?.text).toBe("ab");
    expect(storedMessage()?.streaming).toBe(true);
  });

  it("completes a message first seen in the same frame", () => {
    seedThread();
    applyFrame([messageSent("x", true), messageSent("", false)]);

    expect(storedMessage()?.text).toBe("x");
    expect(storedMessage()?.streaming).toBe(false);
  });
});
