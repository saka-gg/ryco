import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type UsageLimitResumeGuard,
} from "@ryco/contracts";
import { usageLimitIdForTurn, usageLimitResumeIds } from "@ryco/shared/usageLimit";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { TURN_FINALIZATION_REASON } from "./turnFinalization.ts";

const createdAt = "2026-10-04T10:00:00.000Z";
const startedAt = "2026-10-04T10:00:05.000Z";
const limitedAt = "2026-10-04T10:00:10.000Z";
const resetAt = "2026-10-04T15:00:00.000Z";
const projectId = ProjectId.make("project-limit");
const threadId = ThreadId.make("thread-limit");
const turnX = TurnId.make("turn-x");
const turnY = TurnId.make("turn-y");
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const limitId = usageLimitIdForTurn(threadId, turnX);

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
          title: "Limits",
          workspaceRoot: "/tmp/limits",
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
          title: "Limits",
          modelSelection: { instanceId: claude, model: "claude-sonnet-4-5" },
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

async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  return Effect.runPromise(Effect.exit(decideOrchestrationCommand({ command, readModel })));
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
    providerName: "claudeAgent",
    providerInstanceId: claude,
    runtimeSessionId: RuntimeSessionId.make("runtime-1"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: createdAt,
    ...overrides,
  };
}

function sessionSet(id: string, next: OrchestrationSession): OrchestrationCommand {
  return {
    type: "thread.session.set",
    commandId: CommandId.make(id),
    threadId,
    session: next,
    createdAt: next.updatedAt,
  };
}

function turnStart(
  id: string,
  options: {
    readonly guard?: UsageLimitResumeGuard;
    readonly instanceId?: ProviderInstanceId;
    readonly messageId?: string;
  } = {},
): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(id),
    threadId,
    message: {
      messageId: MessageId.make(options.messageId ?? `message-${id}`),
      role: "user",
      text: "Continue where you left off.",
      attachments: [],
    },
    ...(options.instanceId
      ? { modelSelection: { instanceId: options.instanceId, model: "gpt-5.4" } }
      : {}),
    ...(options.guard ? { usageLimitResumeGuard: options.guard } : {}),
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: limitedAt,
  };
}

function record(
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.usage-limit.record" }>> = {},
): OrchestrationCommand {
  return {
    type: "thread.usage-limit.record",
    commandId: CommandId.make(`usage-limit-record:${limitId}`),
    threadId,
    limitId,
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: claude,
    turnId: turnX,
    message: "Claude usage limit reached.",
    resetAt,
    createdAt: limitedAt,
    ...overrides,
  };
}

/** A thread whose turn X ended at a usage limit (session error, turn released). */
async function seedLimitedTurnEnd(): Promise<OrchestrationReadModel> {
  const seeded = await seedThread();
  const started = await dispatch(seeded, turnStart("command-turn-start"));
  const running = await dispatch(
    started.readModel,
    sessionSet(
      "command-running",
      session({ status: "running", activeTurnId: turnX, updatedAt: startedAt }),
    ),
  );
  const stopped = await dispatch(running.readModel, {
    type: "thread.session.set",
    commandId: CommandId.make("command-limited"),
    threadId,
    session: session({ status: "error", lastError: "Limited", updatedAt: limitedAt }),
    turnOutcome: {
      turnId: turnX,
      state: "error",
      reason: TURN_FINALIZATION_REASON.usageLimit,
      completedAt: limitedAt,
    },
    createdAt: limitedAt,
  });
  return stopped.readModel;
}

async function seedLimited(
  overrides: Parameters<typeof record>[0] = {},
): Promise<OrchestrationReadModel> {
  const limited = await dispatch(await seedLimitedTurnEnd(), record(overrides));
  return limited.readModel;
}

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === threadId);

describe("thread.usage-limit.record", () => {
  it("records a fresh limit that follows the node setting", async () => {
    const readModel = await seedLimited();
    expect(threadOf(readModel)?.usageLimit).toEqual({
      limitId,
      provider: "claudeAgent",
      providerInstanceId: claude,
      turnId: turnX,
      message: "Claude usage limit reached.",
      limitedAt,
      resetAt,
      autoResume: null,
      updatedAt: limitedAt,
    });
    expect(threadOf(readModel)?.latestTurn).toMatchObject({ turnId: turnX, state: "error" });
  });

  it("only fills a reset that was unknown", async () => {
    const unknown = await seedLimited({ resetAt: null });
    const filled = await dispatch(
      unknown,
      record({ commandId: CommandId.make("fill"), createdAt: startedAt }),
    );
    expect(threadOf(filled.readModel)?.usageLimit).toMatchObject({
      resetAt,
      limitedAt,
      updatedAt: startedAt,
    });
    const refill = await decide(
      filled.readModel,
      record({ commandId: CommandId.make("refill"), resetAt: "2026-10-04T16:00:00.000Z" }),
    );
    expect(refill._tag).toBe("Failure");
  });

  it("rejects the same limit again without a fill", async () => {
    const readModel = await seedLimited();
    const again = await decide(readModel, record({ commandId: CommandId.make("again") }));
    expect(again._tag).toBe("Failure");
  });

  it("rejects archived threads and limits for a turn that is no longer running", async () => {
    const limitedTurn = await seedLimitedTurnEnd();
    const userMessageThread = threadOf(limitedTurn);
    expect(userMessageThread?.messages.length).toBeGreaterThan(0);
    const archived = await dispatch(limitedTurn, {
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    expect((await decide(archived.readModel, record()))._tag).toBe("Failure");

    const newer = await dispatch(
      limitedTurn,
      sessionSet(
        "command-running-y",
        session({ status: "running", activeTurnId: turnY, updatedAt: limitedAt }),
      ),
    );
    expect((await decide(newer.readModel, record()))._tag).toBe("Failure");
  });
});

describe("stale usage-limit records", () => {
  it("never resurrects a limit cleared by a newer turn with a late reset fill", async () => {
    const unknown = await seedLimited({ resetAt: null });
    const resumed = await dispatch(unknown, turnStart("user-turn"));
    const running = await dispatch(
      resumed.readModel,
      sessionSet(
        "command-running-y",
        session({ status: "running", activeTurnId: turnY, updatedAt: startedAt }),
      ),
    );
    const settled = await dispatch(
      running.readModel,
      sessionSet("command-ready-y", session({ status: "ready", updatedAt: limitedAt })),
    );
    expect(threadOf(settled.readModel)?.usageLimit ?? null).toBeNull();
    const fill = await decide(
      settled.readModel,
      record({ commandId: CommandId.make(`usage-limit-reset:${limitId}`) }),
    );
    expect(fill._tag).toBe("Failure");
  });
});

describe("thread.usage-limit.configure", () => {
  it("requires the current limit and stores the override", async () => {
    const readModel = await seedLimited();
    const stale = await decide(readModel, {
      type: "thread.usage-limit.configure",
      commandId: CommandId.make("configure-stale"),
      threadId,
      limitId: "usage-limit:thread-limit:other",
      autoResume: true,
      createdAt: limitedAt,
    });
    expect(stale._tag).toBe("Failure");
    const configured = await dispatch(readModel, {
      type: "thread.usage-limit.configure",
      commandId: CommandId.make("configure"),
      threadId,
      limitId,
      autoResume: true,
      createdAt: limitedAt,
    });
    expect(threadOf(configured.readModel)?.usageLimit?.autoResume).toBe(true);
  });
});

describe("thread.turn.start and usage limits", () => {
  it("clears the limit first on any accepted turn start", async () => {
    const readModel = await seedLimited();
    const started = await dispatch(readModel, turnStart("user-turn"));
    expect(started.events[0]?.type).toBe("thread.usage-limit-cleared");
    expect(started.events[0]?.payload).toMatchObject({ limitId, reason: "turn-started" });
    expect(threadOf(started.readModel)?.usageLimit).toBeNull();
  });

  it("accepts one guarded resume and rejects a second for the same limit", async () => {
    const readModel = await seedLimited();
    const ids = usageLimitResumeIds(limitId);
    const first = await dispatch(
      readModel,
      turnStart(ids.commandId, { guard: { limitId, origin: "manual" }, messageId: ids.messageId }),
    );
    expect(first.events.map((event) => event.type)).toContain("thread.turn-start-requested");
    const second = await decide(
      first.readModel,
      turnStart("other-command", { guard: { limitId, origin: "auto" } }),
    );
    expect(second._tag).toBe("Failure");
  });

  it("rejects a guarded resume after an unguarded user turn started", async () => {
    const readModel = await seedLimited();
    const user = await dispatch(readModel, turnStart("user-turn"));
    const resumed = await decide(
      user.readModel,
      turnStart("resume", { guard: { limitId, origin: "auto" } }),
    );
    expect(resumed._tag).toBe("Failure");
  });

  it("rejects the guard while the session is starting or running, or on another instance", async () => {
    const readModel = await seedLimited();
    for (const status of ["starting", "running"] as const) {
      const busy = await dispatch(
        readModel,
        sessionSet(
          `command-${status}`,
          session({ status, activeTurnId: null, updatedAt: startedAt }),
        ),
      );
      expect(threadOf(busy.readModel)?.usageLimit?.limitId).toBe(limitId);
      const resumed = await decide(
        busy.readModel,
        turnStart(`resume-${status}`, { guard: { limitId, origin: "auto" } }),
      );
      expect(resumed._tag).toBe("Failure");
    }
    const otherInstance = await decide(
      readModel,
      turnStart("resume-codex", { guard: { limitId, origin: "manual" }, instanceId: codex }),
    );
    expect(otherInstance._tag).toBe("Failure");
  });

  it("appends a resumed activity for automatic resumes only", async () => {
    const readModel = await seedLimited();
    const auto = await dispatch(
      readModel,
      turnStart("resume-auto", { guard: { limitId, origin: "auto" } }),
    );
    const activity = auto.events.find((event) => event.type === "thread.activity-appended");
    expect(activity?.payload).toMatchObject({
      activity: {
        id: "usage-limit-resumed:resume-auto",
        kind: "usage-limit.resumed",
        tone: "info",
        summary: "Resumed automatically after the usage limit reset",
        payload: { limitId, resetAt },
        turnId: null,
      },
    });
    const manual = await dispatch(
      readModel,
      turnStart("resume-manual", { guard: { limitId, origin: "manual" } }),
    );
    expect(manual.events.some((event) => event.type === "thread.activity-appended")).toBe(false);
  });
});

describe("other usage-limit clears", () => {
  it("clears on archive and on checkpoint revert", async () => {
    const readModel = await seedLimited();
    const archived = await dispatch(readModel, {
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    expect(archived.events.map((event) => event.type)).toEqual([
      "thread.archived",
      "thread.usage-limit-cleared",
    ]);
    expect(threadOf(archived.readModel)?.usageLimit).toBeNull();

    const reverted = await dispatch(readModel, {
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("revert"),
      threadId,
      turnCount: 0,
      createdAt: limitedAt,
    });
    expect(reverted.events.map((event) => event.type)).toEqual([
      "thread.checkpoint-revert-requested",
      "thread.usage-limit-cleared",
    ]);
    expect(threadOf(reverted.readModel)?.usageLimit).toBeNull();
  });

  it("clears when a different turn runs, but not for the limited turn itself", async () => {
    const readModel = await seedLimited();
    const sameTurn = await dispatch(
      readModel,
      sessionSet(
        "command-running-x",
        session({ status: "running", activeTurnId: turnX, updatedAt: startedAt }),
      ),
    );
    expect(threadOf(sameTurn.readModel)?.usageLimit?.limitId).toBe(limitId);
    const otherTurn = await dispatch(
      readModel,
      sessionSet(
        "command-running-y",
        session({ status: "running", activeTurnId: turnY, updatedAt: startedAt }),
      ),
    );
    expect(otherTurn.events[0]?.type).toBe("thread.usage-limit-cleared");
    expect(threadOf(otherTurn.readModel)?.usageLimit).toBeNull();
  });
});
