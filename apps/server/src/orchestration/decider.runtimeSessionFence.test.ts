import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
  type ThreadSessionSetExpectedRuntime,
} from "@ryco/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import {
  SUPERSEDED_RUNTIME_SESSION_SET_DETAIL,
  expectedRuntimeOf,
  isSupersededRuntimeSessionSet,
} from "./runtimeSessionFence.ts";

const now = "2026-10-08T13:42:21.219Z";
const threadId = ThreadId.make("thread-model-switch");
const claude = ProviderInstanceId.make("claudeAgent");
const oldRuntime = RuntimeSessionId.make("a0e7016f");
const newRuntime = RuntimeSessionId.make("3f8cad48");

function session(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId,
    status: "ready",
    providerName: "claudeAgent",
    providerInstanceId: claude,
    runtimeSessionId: oldRuntime,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
    ...overrides,
  };
}

function initialModel(): OrchestrationReadModel {
  const thread: OrchestrationThread = {
    id: threadId,
    projectId: ProjectId.make("project-model-switch"),
    title: "Model switch",
    modelSelection: { instanceId: claude, model: "claude-sonnet-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: session(),
  };
  return { snapshotSequence: 1, projects: [], threads: [thread], updatedAt: now };
}

let sequence = 1;
function sessionSet(
  id: string,
  next: OrchestrationSession,
  expectedRuntime?: ThreadSessionSetExpectedRuntime,
): OrchestrationCommand {
  return {
    type: "thread.session.set",
    commandId: CommandId.make(id),
    threadId,
    session: next,
    ...(expectedRuntime ? { expectedRuntime } : {}),
    createdAt: next.updatedAt,
  };
}

/** Decides `command` against `model` and projects the accepted events, like the engine. */
async function dispatch(model: OrchestrationReadModel, command: OrchestrationCommand) {
  const exit = await Effect.runPromiseExit(
    decideOrchestrationCommand({ command, readModel: model }),
  );
  if (Exit.isFailure(exit)) return { model, cause: exit.cause };
  const planned = Array.isArray(exit.value) ? exit.value : [exit.value];
  let next = model;
  for (const event of planned) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: ++sequence } as OrchestrationEvent),
    );
  }
  return { model: next, cause: undefined };
}

const sessionOf = (model: OrchestrationReadModel) =>
  model.threads.find((thread) => thread.id === threadId)!.session;

describe("runtime fence of provider-originated session updates", () => {
  it("rejects a replaced runtime's late exit after the new runtime was bound (c8d50937)", async () => {
    let model = initialModel();
    // ProviderCommandReactor.bindSessionToThread after the model-switch restart: unfenced.
    ({ model } = await dispatch(
      model,
      sessionSet("server:provider-session-set", session({ runtimeSessionId: newRuntime })),
    ));
    expect(sessionOf(model)?.runtimeSessionId).toBe(newRuntime);

    // Ingestion read the thread while it still named the old runtime, so its pre-check
    // passed; the old runtime's `session.exited` reaches the engine only now.
    const exited = await dispatch(
      model,
      sessionSet(
        "provider:exited:thread-session-set",
        session({ status: "stopped", updatedAt: "2026-10-08T13:42:21.660Z" }),
        expectedRuntimeOf({ providerInstanceId: claude, runtimeSessionId: oldRuntime }),
      ),
    );
    expect(exited.cause).toBeDefined();
    expect(isSupersededRuntimeSessionSet(exited.cause!)).toBe(true);
    expect(Cause.pretty(exited.cause!)).toContain(SUPERSEDED_RUNTIME_SESSION_SET_DETAIL);
    expect(sessionOf(exited.model)).toMatchObject({
      status: "ready",
      runtimeSessionId: newRuntime,
    });

    // The new runtime's own lifecycle still applies.
    const started = await dispatch(
      exited.model,
      sessionSet(
        "provider:turn-started:thread-session-set",
        session({
          status: "running",
          runtimeSessionId: newRuntime,
          activeTurnId: TurnId.make("turn-notes"),
        }),
        expectedRuntimeOf({ providerInstanceId: claude, runtimeSessionId: newRuntime }),
      ),
    );
    expect(started.cause).toBeUndefined();
    expect(sessionOf(started.model)).toMatchObject({
      status: "running",
      runtimeSessionId: newRuntime,
      activeTurnId: "turn-notes",
    });
  });

  it("keeps an explicit stop final for the stopped runtime", async () => {
    const stoppedModel = (
      await dispatch(
        initialModel(),
        sessionSet(
          "server:provider-session-set:stop",
          session({ status: "stopped", runtimeSessionId: undefined }),
        ),
      )
    ).model;
    const lateReady = await dispatch(
      stoppedModel,
      sessionSet(
        "provider:late-ready:thread-session-set",
        session({ status: "ready" }),
        expectedRuntimeOf({ providerInstanceId: claude, runtimeSessionId: oldRuntime }),
      ),
    );
    expect(isSupersededRuntimeSessionSet(lateReady.cause!)).toBe(true);
    expect(sessionOf(lateReady.model)).toMatchObject({ status: "stopped" });
    expect(sessionOf(lateReady.model)?.runtimeSessionId).toBeUndefined();
  });

  it("still applies the bound runtime's updates and legacy updates without identities", async () => {
    const own = await dispatch(
      initialModel(),
      sessionSet(
        "provider:own-exit:thread-session-set",
        session({ status: "stopped" }),
        expectedRuntimeOf({ providerInstanceId: claude, runtimeSessionId: oldRuntime }),
      ),
    );
    expect(own.cause).toBeUndefined();
    expect(sessionOf(own.model)).toMatchObject({ status: "stopped", runtimeSessionId: oldRuntime });

    const legacyModel = (
      await dispatch(
        initialModel(),
        sessionSet(
          "server:legacy-seed",
          session({ providerInstanceId: undefined, runtimeSessionId: undefined }),
        ),
      )
    ).model;
    const legacy = await dispatch(
      legacyModel,
      sessionSet(
        "provider:legacy:thread-session-set",
        session({ status: "running", providerInstanceId: undefined, runtimeSessionId: undefined }),
        expectedRuntimeOf({}),
      ),
    );
    expect(legacy.cause).toBeUndefined();
    expect(sessionOf(legacy.model)?.status).toBe("running");
  });

  it("rejects an update for another provider instance or a thread without a session", async () => {
    const otherInstance = await dispatch(
      initialModel(),
      sessionSet(
        "provider:other-instance:thread-session-set",
        session({ status: "stopped" }),
        expectedRuntimeOf({
          providerInstanceId: ProviderInstanceId.make("claude_work"),
          runtimeSessionId: oldRuntime,
        }),
      ),
    );
    expect(isSupersededRuntimeSessionSet(otherInstance.cause!)).toBe(true);

    const base = initialModel();
    const withoutSession: OrchestrationReadModel = {
      ...base,
      threads: [{ ...base.threads[0]!, session: null }],
    };
    const noSession = await dispatch(
      withoutSession,
      sessionSet(
        "provider:no-session:thread-session-set",
        session(),
        expectedRuntimeOf({ providerInstanceId: claude, runtimeSessionId: oldRuntime }),
      ),
    );
    expect(isSupersededRuntimeSessionSet(noSession.cause!)).toBe(true);
  });
});
