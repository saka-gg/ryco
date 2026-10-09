import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ClaudeCacheObservation,
  type EnvironmentApi,
  type OrchestrationThread,
} from "@ryco/contracts";
import { assessClaudeCacheResume, latestClaudeCacheObservation } from "./claudeCacheReview.ts";
import { commitSendTurnDispatch, type CommitSendTurnDispatchInput } from "./sendEngine.ts";

const now = Date.parse("2026-09-27T12:00:00.000Z");
const observation: ClaudeCacheObservation = {
  source: "assistant-usage",
  observedAt: "2026-09-27T10:00:00.000Z",
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "sonnet",
  messageId: "request-1",
  directInputTokens: 100,
  cacheReadInputTokens: 50_000,
  cacheWriteInputTokens: 2_000,
};
function fixture(): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    modelSelection: { instanceId: observation.providerInstanceId, model: "sonnet" },
    session: {
      threadId: ThreadId.make("thread-1"),
      providerName: "claudeAgent",
      providerInstanceId: observation.providerInstanceId,
      runtimeSessionId: observation.runtimeSessionId,
      status: "ready",
      activeTurnId: null,
      lastError: null,
      runtimeMode: "full-access",
      updatedAt: observation.observedAt,
    },
    latestTurn: null,
    messages: [],
    activities: [
      {
        id: EventId.make("usage-1"),
        kind: "context-window.updated",
        tone: "info",
        summary: "Context usage",
        payload: { usedTokens: 52_100, claudeCache: observation },
        turnId: null,
        createdAt: observation.observedAt,
      },
    ],
  } as unknown as OrchestrationThread;
}
function setup(choice: "continue" | "compact" | "cancel" = "compact") {
  let thread = fixture();
  let workspaceCwd: string | undefined;
  const read = vi.fn(async () => ({ thread, ...(workspaceCwd ? { workspaceCwd } : {}) }));
  const dispatch = vi.fn<EnvironmentApi["orchestration"]["dispatchCommand"]>(async () => ({
    sequence: 1,
  }));
  const review = vi.fn(async () => choice);
  const input: CommitSendTurnDispatchInput = {
    providerDriver: "claudeAgent",
    assertMutationReady: vi.fn(),
    api: {
      orchestration: { getThreadWindow: read, dispatchCommand: dispatch },
    } as unknown as EnvironmentApi,
    threadId: thread.id,
    isFirstMessage: false,
    isServerThread: true,
    title: "Title",
    messageId: MessageId.make("original-1"),
    outgoingMessageText: "Original prompt",
    turnAttachments: [
      {
        type: "file",
        name: "fixture.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        uploadToken: "fixture-token",
      },
    ],
    modelSelection: thread.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    tokenMode: "balanced",
    bootstrap: undefined,
    sourceControlContexts: [],
    createdAt: new Date(now).toISOString(),
    newCommandId: () => CommandId.make("command-1"),
    beginLocalDispatch: vi.fn(),
    persistThreadSettingsForNextTurn: vi.fn(async () => {}),
    claudeCacheReview: { review },
  };
  const settle = (state: "completed" | "error" | "interrupted" = "completed", boundary = true) => {
    const turnId = TurnId.make("compact-turn");
    thread = {
      ...thread,
      messages: [
        {
          id: MessageId.make("claude-resume-compact:original-1"),
          role: "user",
          text: "/compact",
          turnId: null,
          streaming: false,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      ],
      latestTurn: {
        turnId,
        userMessageId: MessageId.make("claude-resume-compact:original-1"),
        state,
        requestedAt: input.createdAt,
        startedAt: input.createdAt,
        completedAt: input.createdAt,
        assistantMessageId: null,
      },
      activities: boundary
        ? [
            ...thread.activities,
            {
              id: EventId.make("boundary"),
              kind: "context-compaction",
              tone: "info",
              summary: "Context compacted",
              payload: {},
              turnId,
              createdAt: input.createdAt,
            },
          ]
        : thread.activities,
    };
  };
  return {
    input,
    read,
    dispatch,
    review,
    settle,
    setThread: (value: OrchestrationThread) => {
      thread = value;
    },
    setWorkspaceCwd: (value: string) => {
      workspaceCwd = value;
    },
  };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("Claude resume evidence policy", () => {
  it("reviews large idle context without claiming expiration or cost", () => {
    const thread = fixture();
    expect(assessClaudeCacheResume(thread, thread.modelSelection, now)?.reason).toContain(
      "not a cache lifetime",
    );
    expect(
      assessClaudeCacheResume(
        thread,
        thread.modelSelection,
        Date.parse(observation.observedAt) + 1,
      ),
    ).toBeUndefined();
  });
  it("does not fabricate freshness, count child scopes, or review missing evidence/non-Claude", () => {
    const thread = fixture();
    expect(latestClaudeCacheObservation(thread.activities)?.observedAt).toBe(
      observation.observedAt,
    );
    expect(
      assessClaudeCacheResume({ ...thread, activities: [] }, thread.modelSelection, now),
    ).toBeUndefined();
    expect(
      assessClaudeCacheResume(
        { ...thread, session: { ...thread.session!, providerName: "codex" } },
        thread.modelSelection,
        now,
      ),
    ).toBeUndefined();
    expect(
      assessClaudeCacheResume(
        thread,
        { ...thread.modelSelection, instanceId: ProviderInstanceId.make("other-account") },
        now,
      )?.reason,
    ).toContain("changed");
    expect(assessClaudeCacheResume(thread, thread.modelSelection, 0)).toBeUndefined();
  });
  it("invalidates evidence on compaction and reviews runtime/model/context changes", () => {
    const thread = fixture();
    for (const target of [
      { ...thread.modelSelection, model: "opus" },
      { ...thread.modelSelection, options: [{ id: "contextWindow", value: "1m" }] },
    ]) {
      expect(
        assessClaudeCacheResume(thread, target, Date.parse(observation.observedAt))?.reason,
      ).toContain("changed");
    }
    expect(
      latestClaudeCacheObservation([
        ...thread.activities,
        { ...thread.activities[0]!, kind: "context-compaction" },
      ]),
    ).toBeUndefined();
  });
});
describe("held send through native compaction", () => {
  it("retains original text/attachments and sends once only after a matching successful boundary", async () => {
    const f = setup();
    let finish!: () => void;
    f.dispatch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.settle();
      return { sequence: 1 };
    });
    const first = commitSendTurnDispatch(f.input);
    const duplicate = commitSendTurnDispatch(f.input);
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1));
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
      message: { text: "/compact", attachments: [] },
    });
    expect(f.input.turnAttachments[0]?.uploadToken).toBe("fixture-token");
    finish();
    await Promise.all([first, duplicate]);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.dispatch.mock.calls[1]?.[0]).toMatchObject({
      message: {
        messageId: "original-1",
        text: "Original prompt",
        attachments: f.input.turnAttachments,
      },
      claudeResumeGuard: { latestTurnId: "compact-turn" },
    });
  });
  it.each([
    ["error", true],
    ["interrupted", true],
    ["completed", false],
  ] as const)("keeps draft on %s / boundary=%s", async (state, boundary) => {
    const f = setup();
    f.dispatch.mockImplementationOnce(async () => {
      f.settle(state, boundary);
      return { sequence: 1 };
    });
    await expect(commitSendTurnDispatch(f.input)).rejects.toThrow("did not complete");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.input.outgoingMessageText).toBe("Original prompt");
    expect(f.input.persistThreadSettingsForNextTurn).not.toHaveBeenCalled();
  });
  it("calls onBeforeTurnStart once, after the /compact turn and before the original send", async () => {
    const f = setup();
    const order: string[] = [];
    f.dispatch.mockImplementation(async (command) => {
      const message = (command as { message?: { text?: string } }).message;
      order.push(message?.text === "/compact" ? "compact" : String(command.type));
      if (message?.text === "/compact") f.settle();
      return { sequence: 1 };
    });
    await commitSendTurnDispatch({
      ...f.input,
      onBeforeTurnStart: () => {
        order.push("onBeforeTurnStart");
      },
    });
    expect(order).toEqual(["compact", "onBeforeTurnStart", "thread.turn.start"]);
  });
  it("does not call onBeforeTurnStart when the review is cancelled", async () => {
    const f = setup("cancel");
    const onBeforeTurnStart = vi.fn();
    await expect(commitSendTurnDispatch({ ...f.input, onBeforeTurnStart })).rejects.toThrow(
      "cancelled",
    );
    expect(onBeforeTurnStart).not.toHaveBeenCalled();
  });
  it("cancels without consuming attachments or dispatching", async () => {
    const f = setup("cancel");
    await expect(commitSendTurnDispatch(f.input)).rejects.toThrow("cancelled");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("continues directly with a stable reviewed command and current-identity guard", async () => {
    const f = setup("continue");
    await commitSendTurnDispatch(f.input);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
      commandId: "composer-send:thread-1:original-1",
      claudeResumeGuard: { runtimeSessionId: "runtime-1" },
    });
  });
  it("preserves held send on disconnect and never retries an uncertain compaction dispatch", async () => {
    const f = setup();
    f.dispatch.mockRejectedValueOnce(new Error("disconnected"));
    await expect(commitSendTurnDispatch(f.input)).rejects.toThrow("disconnected");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it("rejects session replacement during compaction", async () => {
    const f = setup();
    f.dispatch.mockImplementationOnce(async () => {
      const thread = fixture();
      f.setThread({
        ...thread,
        session: { ...thread.session!, runtimeSessionId: RuntimeSessionId.make("replacement") },
      });
      return { sequence: 1 };
    });
    await expect(commitSendTurnDispatch(f.input)).rejects.toThrow("session changed");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it("requires fresh review if another turn changes the conversation while the dialog is open", async () => {
    const f = setup();
    f.review.mockImplementationOnce(async () => {
      f.settle();
      return "continue";
    });
    await expect(commitSendTurnDispatch(f.input)).rejects.toThrow("conversation changed");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("keeps ordinary non-Claude sends on the normal dispatch path", async () => {
    const f = setup();
    const thread = fixture();
    f.setThread({ ...thread, session: { ...thread.session!, providerName: "codex" } });
    await commitSendTurnDispatch({ ...f.input, providerDriver: "codex" });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it("reuses the logical command after successful compact+send loses its acknowledgement, even with a fresh API and no evidence", async () => {
    const f = setup();
    const accepted = new Set<string>();
    let providerSends = 0;
    f.dispatch.mockImplementation(async (command) => {
      if (command.type !== "thread.turn.start") return { sequence: 1 };
      if (accepted.has(command.commandId)) return { sequence: 1 };
      accepted.add(command.commandId);
      if (command.message.text === "/compact") {
        f.settle();
        return { sequence: 1 };
      }
      providerSends++;
      throw new Error("reply lost");
    });
    await expect(commitSendTurnDispatch(f.input)).rejects.toThrow("reply lost");
    const retryApi = {
      orchestration: { getThreadWindow: f.read, dispatchCommand: f.dispatch },
    } as unknown as EnvironmentApi;
    await commitSendTurnDispatch({ ...f.input, api: retryApi });
    const originals = f.dispatch.mock.calls
      .map(([command]) => command)
      .filter(
        (command) =>
          command.type === "thread.turn.start" && command.message.text === "Original prompt",
      );
    expect(originals).toHaveLength(2);
    expect(originals[0]?.commandId).toBe(originals[1]?.commandId);
    expect(providerSends).toBe(1);
  });
  it("does not send when a successful projected turn still has an active runtime", async () => {
    const f = setup();
    f.dispatch.mockImplementationOnce(async () => {
      f.settle();
      return { sequence: 1 };
    });
    const read = f.read.getMockImplementation()!;
    let checkedBusy = false;
    f.read.mockImplementation(async () => {
      const value = await read();
      if (value.thread.latestTurn && !checkedBusy) {
        checkedBusy = true;
        return {
          thread: {
            ...value.thread,
            session: {
              ...value.thread.session!,
              status: "running",
              activeTurnId: value.thread.latestTurn.turnId,
            },
          },
        };
      }
      return value;
    });
    const pending = commitSendTurnDispatch(f.input);
    await vi.waitFor(() => expect(checkedBusy).toBe(true));
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    await pending;
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it("rechecks connection generation after settings persistence and holds on reconnect", async () => {
    const f = setup("continue");
    let ready = true;
    const input = {
      ...f.input,
      assertMutationReady: () => {
        if (!ready) throw new Error("new connection generation");
      },
      persistThreadSettingsForNextTurn: async () => {
        ready = false;
      },
    };
    await expect(commitSendTurnDispatch(input)).rejects.toThrow("new connection generation");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("rejects a simultaneous newer turn immediately before final send", async () => {
    const f = setup("continue");
    await expect(
      commitSendTurnDispatch({
        ...f.input,
        persistThreadSettingsForNextTurn: async () => {
          f.settle();
        },
      }),
    ).rejects.toThrow("changed before sending");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("holds the original draft when the bounded compaction wait expires", async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const f = setup();
    const pending = commitSendTurnDispatch(f.input);
    const rejected = expect(pending).rejects.toThrow("could not be confirmed in time");
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.input.turnAttachments[0]?.uploadToken).toBe("fixture-token");
  });
});

it("retains a queued draft when a permission-blocked runtime cannot compact", async () => {
  const f = setup("compact");
  const thread = fixture();
  f.setThread({
    ...thread,
    session: {
      ...thread.session!,
      status: "running",
      activeTurnId: TurnId.make("permission-turn"),
    },
    activities: [
      ...thread.activities,
      {
        id: EventId.make("permission-request"),
        kind: "approval.requested",
        tone: "approval",
        summary: "Permission required",
        turnId: TurnId.make("permission-turn"),
        createdAt: new Date(now).toISOString(),
        payload: { requestId: "permission", requestKind: "command" },
      },
    ],
  });
  await expect(commitSendTurnDispatch(f.input)).rejects.toThrow("ready before compacting");
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.input.beginLocalDispatch).not.toHaveBeenCalled();
  expect(f.input.turnAttachments[0]?.uploadToken).toBe("fixture-token");
  expect(f.input.outgoingMessageText).toBe("Original prompt");
});

describe("a stopped Claude session (no runtime)", () => {
  function stopped(f: ReturnType<typeof setup>) {
    const thread = fixture();
    f.setThread({
      ...thread,
      session: { ...thread.session!, status: "stopped", runtimeSessionId: undefined },
    });
  }

  it("continues with full context under a guard that names no runtime", async () => {
    const f = setup("continue");
    stopped(f);
    await commitSendTurnDispatch(f.input);
    expect(f.review).toHaveBeenCalledWith(
      expect.objectContaining({
        compactUnavailableReason: expect.stringContaining("stopped"),
      }),
    );
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
      message: { messageId: "original-1", text: "Original prompt" },
      claudeResumeGuard: { runtimeSessionId: null, requireReady: false },
    });
  });

  it("refuses compaction with accurate copy and keeps the draft", async () => {
    const f = setup("compact");
    stopped(f);
    await expect(commitSendTurnDispatch(f.input)).rejects.toThrow(
      "stopped, so it cannot compact first",
    );
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.input.turnAttachments[0]?.uploadToken).toBe("fixture-token");
  });

  it("asks for a fresh review when a runtime started after the review", async () => {
    const f = setup("continue");
    stopped(f);
    await expect(
      commitSendTurnDispatch({
        ...f.input,
        persistThreadSettingsForNextTurn: async () => {
          f.setThread(fixture());
        },
      }),
    ).rejects.toThrow("changed before sending");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

describe("a conversation whose folder moved", () => {
  // "Turn into project…" stops the chat's session; attaching a worktree can move a live one.
  it.each([
    ["stopped", { status: "stopped", runtimeSessionId: undefined }],
    ["live", { status: "ready", runtimeSessionId: observation.runtimeSessionId }],
  ] as const)(
    "is not reviewed for a %s session: the next turn starts fresh there",
    async (_, session) => {
      const f = setup("continue");
      const thread = fixture();
      f.setThread({
        ...thread,
        session: { ...thread.session!, ...session },
        activities: [
          {
            ...thread.activities[0]!,
            payload: { claudeCache: { ...observation, cwd: "/chats/pelican" } },
          },
        ],
      });
      f.setWorkspaceCwd("/projects/pelican");
      await commitSendTurnDispatch(f.input);
      expect(f.review).not.toHaveBeenCalled();
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(f.dispatch.mock.calls[0]?.[0]).not.toHaveProperty("claudeResumeGuard");
    },
  );

  it("is still reviewed while the next turn runs in the observed folder", async () => {
    const f = setup("continue");
    const thread = fixture();
    f.setThread({
      ...thread,
      activities: [
        {
          ...thread.activities[0]!,
          payload: { claudeCache: { ...observation, cwd: "/projects/pelican" } },
        },
      ],
    });
    f.setWorkspaceCwd("/projects/pelican");
    await commitSendTurnDispatch(f.input);
    expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
      claudeResumeGuard: { runtimeSessionId: observation.runtimeSessionId },
    });
  });
});

it("does not preflight Claude cache for a known non-Claude source handoff", async () => {
  const f = setup();
  f.read.mockRejectedValue(new Error("Source history is unavailable"));
  await commitSendTurnDispatch({ ...f.input, sourceProviderDriver: "codex" });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.review).not.toHaveBeenCalled();
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it("still reviews an existing Claude source when its target model changes", async () => {
  const f = setup("continue");
  await commitSendTurnDispatch({
    ...f.input,
    sourceProviderDriver: "claudeAgent",
    modelSelection: { ...f.input.modelSelection, model: "opus" },
  });
  expect(f.review).toHaveBeenCalledTimes(1);
  expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
    modelSelection: { model: "opus" },
    claudeResumeGuard: { runtimeSessionId: "runtime-1" },
  });
});

describe("usage-limit resume through the Claude review", () => {
  const resume = {
    commandId: CommandId.make("usage-limit-resume:limit-1"),
    usageLimitResumeGuard: { limitId: "limit-1", origin: "manual" as const },
  };

  it("still reviews and a cancel prevents the dispatch", async () => {
    const f = setup("cancel");
    await expect(commitSendTurnDispatch({ ...f.input, ...resume })).rejects.toThrow("cancelled");
    expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the reviewed resume with its own command id and guard", async () => {
    const f = setup("continue");
    await commitSendTurnDispatch({ ...f.input, ...resume });
    expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
      commandId: "usage-limit-resume:limit-1",
      usageLimitResumeGuard: { limitId: "limit-1", origin: "manual" },
      claudeResumeGuard: { runtimeSessionId: "runtime-1" },
    });
  });
});
