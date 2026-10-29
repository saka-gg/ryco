import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type OrchestrationThread,
} from "@ryco/contracts";
import { OrchestrationDispatchCommandError } from "@ryco/contracts/orchestration";

import {
  describeNativeCompactionBlocker,
  nativeCompactionAdvertised,
  nativeCompactionBlocker,
  nativeCompactionBlockerForSession,
  requestNativeCompaction,
  type NativeCompactionThread,
} from "./nativeCompaction.ts";

type Session = NonNullable<NativeCompactionThread["session"]>;

const readySession: Session = {
  providerName: "claudeAgent",
  status: "ready",
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  activeTurnId: null,
};

function windowThread(session: Partial<Session> | null = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    // The thread's own settings, which differ from anything a composer may have staged.
    modelSelection: { instanceId: ProviderInstanceId.make("claude_work"), model: "opus" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    tokenMode: "aggressive",
    latestTurn: {
      turnId: TurnId.make("turn-7"),
      state: "completed",
      requestedAt: "2026-10-28T10:00:00.000Z",
      startedAt: "2026-10-28T10:00:00.000Z",
      completedAt: "2026-10-28T10:01:00.000Z",
      assistantMessageId: null,
    },
    session: session === null ? null : { ...readySession, ...session },
    messages: [],
    activities: [],
  } as unknown as OrchestrationThread;
}

function setup(thread: OrchestrationThread = windowThread()) {
  const getThreadWindow = vi.fn(async () => ({ thread }));
  const dispatchCommand = vi.fn<EnvironmentApi["orchestration"]["dispatchCommand"]>(async () => ({
    sequence: 1,
  }));
  const api = { orchestration: { getThreadWindow, dispatchCommand } } as unknown as EnvironmentApi;
  return { api, getThreadWindow, dispatchCommand };
}

describe("nativeCompactionBlocker", () => {
  it.each([
    ["a ready, idle Claude session", readySession, null],
    ["another provider", { ...readySession, providerName: "codex" }, "unsupported"],
    ["an unknown provider", { ...readySession, providerName: null }, "unsupported"],
    ["a stopped session", { ...readySession, status: "stopped" }, "stopped"],
    // Starting it again would withdraw the action, so it is never offered.
    [
      "a stopped session of another provider",
      { ...readySession, providerName: "codex", status: "stopped" },
      "unsupported",
    ],
    ["a session without a runtime", { ...readySession, runtimeSessionId: undefined }, "no-runtime"],
    [
      "a running turn",
      { ...readySession, status: "running", activeTurnId: TurnId.make("turn-8") },
      "busy",
    ],
    // A pending approval or question keeps the turn active on a session that reads ready.
    [
      "a turn waiting on the user",
      { ...readySession, activeTurnId: TurnId.make("turn-8") },
      "busy",
    ],
    ["a starting session", { ...readySession, status: "starting" }, "busy"],
    // A session starting its runtime finishes on its own; one that never had a runtime does not.
    [
      "a session starting its runtime",
      { ...readySession, status: "starting", runtimeSessionId: undefined },
      "busy",
    ],
    // A failed turn leaves the session in error with nothing running: no turn to wait for.
    ["a session whose last turn failed", { ...readySession, status: "error" }, "not-ready"],
    ["an interrupted session", { ...readySession, status: "interrupted" }, "not-ready"],
    ["an idle session", { ...readySession, status: "idle" }, "not-ready"],
  ] as const)("%s", (_name, session, expected) => {
    expect(nativeCompactionBlocker({ session: session as Session })).toBe(expected);
  });

  it("tells a failed session apart from a busy one", () => {
    expect(describeNativeCompactionBlocker("not-ready")).toBe(
      "The session is not ready. Send a message to resume it, then compact.",
    );
    expect(describeNativeCompactionBlocker("not-ready")).not.toBe(
      describeNativeCompactionBlocker("busy"),
    );
  });

  it("treats a thread without a session as stopped", () => {
    expect(nativeCompactionBlocker({ session: null })).toBe("stopped");
  });

  it("reads a client store session the same way", () => {
    const session = {
      provider: ProviderDriverKind.make("claudeAgent"),
      orchestrationStatus: "ready" as const,
      runtimeSessionId: "runtime-1",
    };
    expect(nativeCompactionBlockerForSession(session)).toBeNull();
    expect(
      nativeCompactionBlockerForSession({ ...session, activeTurnId: TurnId.make("turn-8") }),
    ).toBe("busy");
    expect(
      nativeCompactionBlockerForSession({ ...session, provider: ProviderDriverKind.make("codex") }),
    ).toBe("unsupported");
    expect(nativeCompactionBlockerForSession({ ...session, runtimeSessionId: undefined })).toBe(
      "no-runtime",
    );
    expect(nativeCompactionBlockerForSession(undefined)).toBe("stopped");
    expect(nativeCompactionBlockerForSession({ ...session, orchestrationStatus: "error" })).toBe(
      "not-ready",
    );
  });

  it("stays busy while a turn this client sent has not reached the session", () => {
    const session = {
      provider: ProviderDriverKind.make("claudeAgent"),
      orchestrationStatus: "ready" as const,
      runtimeSessionId: "runtime-1",
    };
    expect(nativeCompactionBlockerForSession(session, { turnStartPending: true })).toBe("busy");
    expect(nativeCompactionBlockerForSession(session, { turnStartPending: false })).toBeNull();
    // A pending send never offers the action to a provider that cannot compact on request.
    expect(
      nativeCompactionBlockerForSession(
        { ...session, provider: ProviderDriverKind.make("codex") },
        { turnStartPending: true },
      ),
    ).toBe("unsupported");
    expect(
      nativeCompactionBlockerForSession(
        { ...session, orchestrationStatus: "stopped" },
        { turnStartPending: true },
      ),
    ).toBe("stopped");
  });

  it("explains every blocker", () => {
    for (const blocker of ["unsupported", "stopped", "busy", "no-runtime", "not-ready"] as const) {
      expect(describeNativeCompactionBlocker(blocker)).toMatch(/\.$/);
    }
  });
});

describe("nativeCompactionAdvertised", () => {
  const usage = (payload: Record<string, unknown>) => ({
    kind: "context-window.updated",
    payload: { usedTokens: 120_000, ...payload },
  });

  it("reads the latest context usage", () => {
    expect(nativeCompactionAdvertised([usage({ compactsAutomatically: true })])).toBe(true);
    expect(
      nativeCompactionAdvertised([
        usage({ compactsAutomatically: true }),
        { kind: "tool.completed", payload: {} },
      ]),
    ).toBe(true);
    // A newer usage from a CLI without `/compact` withdraws it.
    expect(
      nativeCompactionAdvertised([
        usage({ compactsAutomatically: true }),
        usage({ compactsAutomatically: false }),
      ]),
    ).toBe(false);
  });

  it("skips a usage without a valid token count, as the context meter does", () => {
    expect(
      nativeCompactionAdvertised([
        usage({ compactsAutomatically: true }),
        usage({ usedTokens: null, compactsAutomatically: false }),
      ]),
    ).toBe(true);
  });

  it("is false without any context usage", () => {
    expect(nativeCompactionAdvertised([])).toBe(false);
    expect(nativeCompactionAdvertised([usage({})])).toBe(false);
  });
});

describe("requestNativeCompaction", () => {
  it("sends the native command on the thread's own model and modes, fenced to what it read", async () => {
    const f = setup();
    await requestNativeCompaction({
      api: f.api,
      threadId: ThreadId.make("thread-1"),
      newId: () => "uuid-1",
    });

    expect(f.getThreadWindow).toHaveBeenCalledWith({
      threadId: "thread-1",
      limits: { messages: 1, activities: 1, checkpoints: 1, proposedPlans: 1 },
    });
    expect(f.dispatchCommand).toHaveBeenCalledOnce();
    expect(f.dispatchCommand.mock.calls[0]?.[0]).toEqual({
      type: "thread.turn.start",
      claudeResumeGuard: {
        requireReady: true,
        runtimeSessionId: "runtime-1",
        latestTurnId: "turn-7",
        modelSelection: { instanceId: "claude_work", model: "opus" },
      },
      commandId: "compact-now:uuid-1",
      threadId: "thread-1",
      message: { messageId: "compact-now:uuid-1", role: "user", text: "/compact", attachments: [] },
      modelSelection: { instanceId: "claude_work", model: "opus" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      tokenMode: "aggressive",
      createdAt: expect.any(String),
    });
  });

  it("leaves the token mode out when the thread has none", async () => {
    const thread = windowThread();
    delete (thread as { tokenMode?: unknown }).tokenMode;
    const f = setup(thread);
    await requestNativeCompaction({ api: f.api, threadId: thread.id, newId: () => "uuid-1" });
    expect(f.dispatchCommand.mock.calls[0]?.[0]).not.toHaveProperty("tokenMode");
  });

  it("dispatches nothing when the connection is not ready, before or after the read", async () => {
    const before = setup();
    const notReady = () => {
      throw new Error("The connection changed. Reconnect and try again.");
    };
    await expect(
      requestNativeCompaction({
        api: before.api,
        threadId: ThreadId.make("thread-1"),
        assertMutationReady: notReady,
        newId: () => "uuid-1",
      }),
    ).rejects.toThrow("The connection changed.");
    expect(before.getThreadWindow).not.toHaveBeenCalled();
    expect(before.dispatchCommand).not.toHaveBeenCalled();

    const after = setup();
    let checks = 0;
    await expect(
      requestNativeCompaction({
        api: after.api,
        threadId: ThreadId.make("thread-1"),
        assertMutationReady: () => {
          if (++checks > 1) notReady();
        },
        newId: () => "uuid-1",
      }),
    ).rejects.toThrow("The connection changed.");
    expect(after.getThreadWindow).toHaveBeenCalledOnce();
    expect(after.dispatchCommand).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "running", activeTurnId: TurnId.make("turn-8") }, "busy"],
    [{ status: "stopped" }, "stopped"],
    [{ status: "error" }, "not-ready"],
    [{ providerName: "codex" }, "unsupported"],
  ] as const)("refuses a blocked thread as the node reports it: %o", async (session, blocker) => {
    const f = setup(windowThread(session as Partial<Session>));
    await expect(
      requestNativeCompaction({
        api: f.api,
        threadId: ThreadId.make("thread-1"),
        newId: () => "uuid-1",
      }),
    ).rejects.toThrow(describeNativeCompactionBlocker(blocker));
    expect(f.dispatchCommand).not.toHaveBeenCalled();
  });

  it("reports a node without thread windows instead of guessing the thread's settings", async () => {
    const f = setup();
    const api = {
      orchestration: { dispatchCommand: f.dispatchCommand },
    } as unknown as EnvironmentApi;
    await expect(
      requestNativeCompaction({ api, threadId: ThreadId.make("thread-1"), newId: () => "uuid-1" }),
    ).rejects.toThrow("Update this node");
    expect(f.dispatchCommand).not.toHaveBeenCalled();
  });

  it("words the node's stale-guard refusal for this action and passes other failures through", async () => {
    const f = setup();
    f.dispatchCommand.mockRejectedValueOnce(
      new OrchestrationDispatchCommandError({
        message:
          "Claude resume review is stale. The session, model, context settings, or latest turn changed. Review and send again.",
      }),
    );
    await expect(
      requestNativeCompaction({
        api: f.api,
        threadId: ThreadId.make("thread-1"),
        newId: () => "uuid-1",
      }),
    ).rejects.toThrow("The conversation changed. Try Compact now again.");

    // A relay can deliver the refusal as a plain object.
    f.dispatchCommand.mockRejectedValueOnce({
      _tag: "OrchestrationDispatchCommandError",
      message: "Claude resume review is stale. Review and send again.",
    });
    await expect(
      requestNativeCompaction({
        api: f.api,
        threadId: ThreadId.make("thread-1"),
        newId: () => "uuid-2",
      }),
    ).rejects.toThrow("The conversation changed. Try Compact now again.");

    f.dispatchCommand.mockRejectedValueOnce(new Error("Socket closed."));
    await expect(
      requestNativeCompaction({
        api: f.api,
        threadId: ThreadId.make("thread-1"),
        newId: () => "uuid-3",
      }),
    ).rejects.toThrow("Socket closed.");
  });
});
