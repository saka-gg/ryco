import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { TURN_FINALIZATION_REASON } from "./turnFinalization.ts";

const createdAt = "2026-08-01T00:00:00.000Z";
const startedAt = "2026-08-01T00:00:05.000Z";
const endedAt = "2026-08-01T00:00:10.000Z";
const projectId = ProjectId.make("project-finalize");
const threadId = ThreadId.make("thread-finalize");
const turnX = TurnId.make("turn-x");
const codex = ProviderInstanceId.make("codex");

function seedEvent(
  sequence: number,
  event: Omit<
    OrchestrationEvent,
    "sequence" | "eventId" | "causationEventId" | "correlationId" | "metadata"
  >,
): OrchestrationEvent {
  return {
    ...event,
    sequence,
    eventId: EventId.make(`event-seed-${sequence}`),
    causationEventId: null,
    correlationId: event.commandId,
    metadata: {},
  } as OrchestrationEvent;
}

async function seedThread(): Promise<OrchestrationReadModel> {
  const withProject = await Effect.runPromise(
    projectEvent(
      createEmptyReadModel(createdAt),
      seedEvent(1, {
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-project-created"),
        payload: {
          projectId,
          title: "Finalize",
          workspaceRoot: "/tmp/finalize",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      }),
    ),
  );
  return Effect.runPromise(
    projectEvent(
      withProject,
      seedEvent(2, {
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-thread-created"),
        payload: {
          threadId,
          projectId,
          title: "Finalize",
          modelSelection: { instanceId: codex, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
    ),
  );
}

async function dispatch(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<{
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly readModel: OrchestrationReadModel;
}> {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const planned = Array.isArray(result) ? result : [result];
  let next = readModel;
  const events: OrchestrationEvent[] = [];
  for (const entry of planned) {
    const event = { ...entry, sequence: next.snapshotSequence + 1 } as OrchestrationEvent;
    events.push(event);
    next = await Effect.runPromise(projectEvent(next, event));
  }
  return { events, readModel: next };
}

function session(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId,
    status: "ready",
    providerName: "codex",
    providerInstanceId: codex,
    runtimeSessionId: RuntimeSessionId.make("runtime-1"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: createdAt,
    ...overrides,
  };
}

function sessionSet(
  id: string,
  next: OrchestrationSession,
  turnOutcome?: Extract<OrchestrationCommand, { type: "thread.session.set" }>["turnOutcome"],
): OrchestrationCommand {
  return {
    type: "thread.session.set",
    commandId: CommandId.make(id),
    threadId,
    session: next,
    ...(turnOutcome ? { turnOutcome } : {}),
    createdAt: next.updatedAt,
  };
}

/** A thread with one user message and a running turn X. */
async function seedRunningTurn(): Promise<OrchestrationReadModel> {
  const seeded = await seedThread();
  const started = await dispatch(seeded, {
    type: "thread.turn.start",
    commandId: CommandId.make("command-turn-start"),
    threadId,
    message: {
      messageId: MessageId.make("message-user-1"),
      role: "user",
      text: "Do the work",
      attachments: [],
    },
    modelSelection: { instanceId: codex, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt,
  });
  const running = await dispatch(
    started.readModel,
    sessionSet(
      "command-running",
      session({ status: "running", activeTurnId: turnX, updatedAt: startedAt }),
    ),
  );
  expect(running.readModel.threads[0]?.latestTurn).toMatchObject({
    turnId: turnX,
    state: "running",
  });
  return running.readModel;
}

function releasedTurnOf(events: ReadonlyArray<OrchestrationEvent>) {
  const sessionEvent = events.find((event) => event.type === "thread.session-set");
  if (sessionEvent?.type !== "thread.session-set") {
    throw new Error("Expected a thread.session-set event");
  }
  return sessionEvent.payload.releasedTurn;
}

describe("turn finalization in the decider", () => {
  it("finalizes the released turn so a context handoff is accepted afterwards", async () => {
    const running = await seedRunningTurn();
    const released = await dispatch(
      running,
      sessionSet("command-ready", session({ status: "ready", updatedAt: endedAt }), {
        turnId: turnX,
        state: "completed",
        reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
        completedAt: endedAt,
      }),
    );

    // Context handoff (provider instance switch) requires a settled latest turn.
    const handoff = await Effect.runPromise(
      Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("command-handoff"),
            threadId,
            message: {
              messageId: MessageId.make("message-user-2"),
              role: "user",
              text: "Continue elsewhere",
              attachments: [],
            },
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-fable-5",
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: endedAt,
          },
          readModel: released.readModel,
        }),
      ),
    );
    expect(handoff._tag).toBe("Success");

    const latestTurn = released.readModel.threads[0]?.latestTurn;
    expect(latestTurn).toMatchObject({ turnId: turnX, state: "completed" });
    expect(Date.parse(latestTurn?.completedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(latestTurn?.startedAt ?? ""),
    );
    expect(releasedTurnOf(released.events)).toEqual({
      turnId: turnX,
      state: "completed",
      reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
      completedAt: endedAt,
    });
  });

  it("falls back to error for an error release and interrupted otherwise, never completed", async () => {
    const running = await seedRunningTurn();
    const errored = await dispatch(
      running,
      sessionSet(
        "command-error",
        session({ status: "error", lastError: "boom", updatedAt: endedAt }),
      ),
    );
    expect(releasedTurnOf(errored.events)).toMatchObject({
      turnId: turnX,
      state: "error",
      reason: TURN_FINALIZATION_REASON.sessionReleased,
    });
    expect(errored.readModel.threads[0]?.latestTurn?.state).toBe("error");

    const readied = await dispatch(
      running,
      sessionSet("command-ready", session({ status: "ready", updatedAt: endedAt })),
    );
    expect(releasedTurnOf(readied.events)).toMatchObject({
      turnId: turnX,
      state: "interrupted",
      reason: TURN_FINALIZATION_REASON.sessionReleased,
    });
    expect(readied.readModel.threads[0]?.latestTurn?.state).toBe("interrupted");
  });

  it("does not release a turn while the same active turn is kept", async () => {
    const running = await seedRunningTurn();
    const kept = await dispatch(
      running,
      sessionSet(
        "command-error-kept",
        session({ status: "error", activeTurnId: turnX, lastError: "warn", updatedAt: endedAt }),
      ),
    );
    expect(releasedTurnOf(kept.events)).toBeUndefined();
    expect(kept.readModel.threads[0]?.latestTurn?.state).toBe("running");
  });

  it("repairs a legacy stale running turn without waking a snoozed thread", async () => {
    const running = await seedRunningTurn();
    // Legacy state: the session was released without settling the turn.
    const legacy = await dispatch(
      running,
      sessionSet(
        "command-legacy-release",
        session({ status: "error", lastError: "legacy", updatedAt: endedAt }),
      ),
    );
    const legacyThread = legacy.readModel.threads[0]!;
    const stale: OrchestrationReadModel = {
      ...legacy.readModel,
      threads: [
        {
          ...legacyThread,
          latestTurn: { ...legacyThread.latestTurn!, state: "running", completedAt: null },
          snoozedUntil: "2026-08-02T00:00:00.000Z",
          snoozedAt: "2026-08-01T00:01:00.000Z",
        },
      ],
    };

    const repaired = await dispatch(
      stale,
      sessionSet("command-startup-repair", legacyThread.session!, {
        turnId: turnX,
        state: "error",
        reason: TURN_FINALIZATION_REASON.startupStaleTurn,
        completedAt: legacyThread.session!.updatedAt,
      }),
    );

    expect(repaired.events.map((event) => event.type)).toEqual(["thread.session-set"]);
    expect(releasedTurnOf(repaired.events)).toEqual({
      turnId: turnX,
      state: "error",
      reason: TURN_FINALIZATION_REASON.startupStaleTurn,
      completedAt: endedAt,
    });
    expect(repaired.readModel.threads[0]?.latestTurn).toMatchObject({
      turnId: turnX,
      state: "error",
      completedAt: endedAt,
    });
  });

  it("releases the active turn as error when provider history reports it failed", async () => {
    const running = await seedRunningTurn();
    const thread = running.threads[0]!;
    const restoredAt = "2026-08-01T00:00:20.000Z";
    const restored = await dispatch(running, {
      type: "thread.history.restore",
      commandId: CommandId.make("command-history-restore"),
      threadId,
      expectedUpdatedAt: thread.updatedAt,
      providerInstanceId: codex,
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
      messages: [],
      activities: [],
      completedTurnIds: [turnX],
      failedTurnIds: [turnX],
      createdAt: restoredAt,
    });

    expect(releasedTurnOf(restored.events)).toEqual({
      turnId: turnX,
      state: "error",
      reason: TURN_FINALIZATION_REASON.providerHistory,
      completedAt: restoredAt,
    });
    expect(restored.readModel.threads[0]?.latestTurn).toMatchObject({
      turnId: turnX,
      state: "error",
      completedAt: restoredAt,
    });
  });
});
