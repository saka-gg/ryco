import {
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadHistoryState,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createEnvironmentFallbackThreadRefSelector,
  createThreadSelectorByRef,
  createThreadStructureSelectorByRef,
  createThreadSummaryStructureSelectorByRef,
  selectEnvironmentShellLive,
  selectSubscribedClaudeReviewState,
  selectThreadDetailLoaded,
  selectThreadLiveDetailLoaded,
  selectThreadMessageText,
  threadDiffersOnlyInStreamedText,
} from "./storeSelectors.ts";
import {
  applyOrchestrationEvents,
  applyShellEvent,
  demoteEnvironmentStateToCachedSnapshot,
  evictThreadBodies,
  removeThreadByRef,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  syncServerThreadWindow,
  type AppState,
  type EnvironmentState,
} from "./store.ts";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type SidebarThreadSummary,
  type Thread,
  type ThreadShell,
} from "./types.ts";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const makeEnvironmentState = (overrides: Partial<EnvironmentState> = {}): EnvironmentState => ({
  projectIds: [],
  projectById: {},
  worktreeIds: [],
  worktreeIdsByProjectId: {},
  worktreeById: {},
  threadIds: [],
  threadIdsByProjectId: {},
  threadShellById: {},
  threadSessionById: {},
  threadTurnStateById: {},
  messageIdsByThreadId: {},
  messageByThreadId: {},
  pendingMessagesByThreadId: {},
  activityIdsByThreadId: {},
  activityByThreadId: {},
  proposedPlanIdsByThreadId: {},
  proposedPlanByThreadId: {},
  turnDiffIdsByThreadId: {},
  turnDiffSummaryByThreadId: {},
  sidebarThreadSummaryById: {},
  bootstrapComplete: true,
  ...overrides,
});

const makeState = (environmentState: EnvironmentState): AppState => ({
  activeEnvironmentId: environmentId,
  environmentStateById: {
    [environmentId]: environmentState,
  },
});

const makeSummary = (
  id: ThreadId,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary => ({
  id,
  environmentId,
  projectId,
  title: id,
  interactionMode: DEFAULT_INTERACTION_MODE,
  tokenMode: DEFAULT_AGENT_TOKEN_MODE,
  session: null,
  createdAt: "2026-06-12T10:00:00.000Z",
  archivedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const makeShell = (id: ThreadId, overrides: Partial<ThreadShell> = {}): ThreadShell => ({
  id,
  environmentId,
  codexThreadId: null,
  projectId,
  title: id,
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_INTERACTION_MODE,
  tokenMode: DEFAULT_AGENT_TOKEN_MODE,
  error: null,
  createdAt: "2026-06-12T10:00:00.000Z",
  archivedAt: null,
  branch: null,
  worktreePath: null,
  ...overrides,
});

describe("createEnvironmentFallbackThreadRefSelector", () => {
  it("returns a stable ref when the selected fallback thread does not change", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA, threadB],
        sidebarThreadSummaryById: {
          [threadA]: makeSummary(threadA),
          [threadB]: makeSummary(threadB, {
            latestUserMessageAt: "2026-06-12T11:00:00.000Z",
          }),
        },
      }),
    );
    const selector = createEnvironmentFallbackThreadRefSelector(environmentId, "updated_at");

    const first = selector(state);
    const second = selector(state);

    expect(first).toEqual({ environmentId, threadId: threadB } satisfies ScopedThreadRef);
    expect(second).toBe(first);
  });

  it("sorts fallback candidates by sidebar summary data", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA, threadB],
        sidebarThreadSummaryById: {
          [threadA]: makeSummary(threadA, {
            latestUserMessageAt: "2026-06-12T11:00:00.000Z",
          }),
          [threadB]: makeSummary(threadB, {
            latestUserMessageAt: "2026-06-12T10:30:00.000Z",
          }),
        },
      }),
    );
    const selector = createEnvironmentFallbackThreadRefSelector(environmentId, "updated_at");

    expect(selector(state)).toEqual({ environmentId, threadId: threadA });
  });

  it("falls back to thread shell data when the sidebar summary has not arrived yet", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA],
        threadShellById: {
          [threadA]: makeShell(threadA),
        },
      }),
    );
    const selector = createEnvironmentFallbackThreadRefSelector(environmentId, "updated_at");

    expect(selector(state)).toEqual({ environmentId, threadId: threadA });
  });
});

describe("selectThreadDetailLoaded", () => {
  const ref = { environmentId, threadId: threadA } satisfies ScopedThreadRef;
  const detail: OrchestrationThread = {
    id: threadA,
    projectId,
    title: "Detail",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-12T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as OrchestrationThread;
  const page = { cursor: null, hasMore: false } as never;
  const history = {
    messages: page,
    proposedPlans: page,
    activities: page,
    checkpoints: page,
  } as OrchestrationThreadHistoryState;

  it("is false for a shell-only thread", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA],
        threadShellById: { [threadA]: makeShell(threadA) },
        sidebarThreadSummaryById: { [threadA]: makeSummary(threadA) },
      }),
    );
    expect(selectThreadDetailLoaded(state, ref)).toBe(false);
  });

  it("is true after a full-detail snapshot", () => {
    const state = syncServerThreadDetail(makeState(makeEnvironmentState()), detail, environmentId);
    expect(selectThreadDetailLoaded(state, ref)).toBe(true);
  });

  it("is true after a thread-detail window", () => {
    const state = syncServerThreadWindow(
      makeState(makeEnvironmentState()),
      { snapshotSequence: 1, thread: detail, history },
      environmentId,
    );
    expect(selectThreadDetailLoaded(state, ref)).toBe(true);
  });
});

describe("selectThreadLiveDetailLoaded", () => {
  const ref = { environmentId, threadId: threadA } satisfies ScopedThreadRef;
  const message = {
    id: "message-1",
    role: "assistant",
    text: "cached",
    createdAt: "2026-06-12T10:00:00.000Z",
    streaming: false,
  } as never;
  const cachedState = makeState(
    makeEnvironmentState({
      threadIds: [threadA],
      threadShellById: { [threadA]: makeShell(threadA) },
      sidebarThreadSummaryById: { [threadA]: makeSummary(threadA) },
      messageIdsByThreadId: { [threadA]: ["message-1" as never] },
      messageByThreadId: { [threadA]: { ["message-1" as never]: message } },
      cachedMessageThreadIds: { [threadA]: true },
    }),
  );
  const detail = {
    id: threadA,
    projectId,
    title: "Detail",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-12T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as unknown as OrchestrationThread;
  const page = { cursor: null, hasMore: false } as never;
  const history = {
    messages: page,
    proposedPlans: page,
    activities: page,
    checkpoints: page,
  } as OrchestrationThreadHistoryState;

  it("is false for messages hydrated from a cache, which selectThreadDetailLoaded counts", () => {
    expect(selectThreadDetailLoaded(cachedState, ref)).toBe(true);
    expect(selectThreadLiveDetailLoaded(cachedState, ref)).toBe(false);
  });

  it("is true once the live window is applied over cached messages", () => {
    const state = syncServerThreadWindow(
      cachedState,
      { snapshotSequence: 1, thread: detail, history },
      environmentId,
    );
    expect(selectThreadLiveDetailLoaded(state, ref)).toBe(true);
  });

  it("is true once a legacy full-detail snapshot replaces cached messages", () => {
    const state = syncServerThreadDetail(cachedState, detail, environmentId);
    expect(selectThreadLiveDetailLoaded(state, ref)).toBe(true);
  });
});

describe("selectEnvironmentShellLive", () => {
  it("is true only for a bootstrapped environment that is not cache provenance", () => {
    expect(selectEnvironmentShellLive(makeState(makeEnvironmentState()), environmentId)).toBe(true);
    expect(
      selectEnvironmentShellLive(
        makeState(makeEnvironmentState({ bootstrapComplete: false })),
        environmentId,
      ),
    ).toBe(false);
    expect(
      selectEnvironmentShellLive(
        makeState(makeEnvironmentState({ hydratedFromCacheAt: 1 })),
        environmentId,
      ),
    ).toBe(false);
    expect(
      selectEnvironmentShellLive(makeState(makeEnvironmentState()), EnvironmentId.make("other")),
    ).toBe(false);
  });
});

describe("selectSubscribedClaudeReviewState", () => {
  const ref = { environmentId, threadId: threadA } satisfies ScopedThreadRef;
  const detail = {
    id: threadA,
    projectId,
    title: "Detail",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-12T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: threadA,
      status: "ready",
      providerName: "claudeAgent",
      runtimeSessionId: "runtime-1",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-06-12T10:00:00.000Z",
    },
  } as unknown as OrchestrationThread;
  const project = {
    id: projectId,
    environmentId,
    name: "Project",
    cwd: "/repo",
    defaultModelSelection: null,
    scripts: [],
  };
  const withDetail = (overrides: Partial<EnvironmentState> = {}, thread = detail) =>
    syncServerThreadDetail(
      makeState(makeEnvironmentState({ projectById: { [projectId]: project }, ...overrides })),
      thread,
      environmentId,
    );

  it("maps the subscribed thread, session and project workspace", () => {
    expect(selectSubscribedClaudeReviewState(withDetail(), ref)).toEqual({
      thread: {
        modelSelection: detail.modelSelection,
        activities: [],
        session: {
          providerName: "claudeAgent",
          runtimeSessionId: "runtime-1",
          status: "ready",
          activeTurnId: null,
        },
      },
      workspaceCwd: "/repo",
    });
  });

  it("prefers the thread's worktree and omits a missing runtime session", () => {
    const state = withDetail({}, {
      ...detail,
      worktreePath: "/repo/.worktrees/a",
      session: { ...detail.session!, runtimeSessionId: undefined },
    } as OrchestrationThread);
    const subscribed = selectSubscribedClaudeReviewState(state, ref);
    expect(subscribed?.workspaceCwd).toBe("/repo/.worktrees/a");
    expect(subscribed?.thread.session).not.toHaveProperty("runtimeSessionId");
  });

  it("is undefined unless the shell is live and the detail is loaded", () => {
    expect(
      selectSubscribedClaudeReviewState(withDetail({ hydratedFromCacheAt: 1 }), ref),
    ).toBeUndefined();
    expect(
      selectSubscribedClaudeReviewState(withDetail({ bootstrapComplete: false }), ref),
    ).toBeUndefined();
    const shellOnly = makeState(
      makeEnvironmentState({
        threadIds: [threadA],
        threadShellById: { [threadA]: makeShell(threadA) },
        sidebarThreadSummaryById: { [threadA]: makeSummary(threadA) },
      }),
    );
    expect(selectSubscribedClaudeReviewState(shellOnly, ref)).toBeUndefined();
  });

  it("documents the accepted gap: a detail loaded before a reconnect qualifies once the shell is live", () => {
    const loaded = withDetail();
    const demoted = demoteEnvironmentStateToCachedSnapshot(loaded, environmentId, 1);
    expect(selectSubscribedClaudeReviewState(demoted, ref)).toBeUndefined();
    // A live shell snapshot lands before the retained detail subscription has
    // re-synced: the store records no detail sync generation, so the review
    // judges the activities it held before the disconnect.
    const environment = demoted.environmentStateById[environmentId]!;
    const relive: AppState = {
      ...demoted,
      environmentStateById: {
        [environmentId]: {
          ...environment,
          bootstrapComplete: true,
          hydratedFromCacheAt: undefined,
        },
      },
    };
    expect(selectSubscribedClaudeReviewState(relive, ref)?.thread.activities).toEqual(
      selectSubscribedClaudeReviewState(loaded, ref)?.thread.activities,
    );
  });
});

describe("createThreadStructureSelectorByRef", () => {
  const ref = { environmentId, threadId: threadA } satisfies ScopedThreadRef;
  const turnId = TurnId.make("turn-1");
  const userMessageId = MessageId.make("message-user");
  const replyId = MessageId.make("message-reply");
  const startedAt = "2026-06-12T10:00:00.000Z";
  const orchestrationSession = {
    threadId: threadA,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: turnId,
    lastError: null,
    updatedAt: startedAt,
  };
  const latestTurn = {
    turnId,
    state: "running",
    requestedAt: startedAt,
    startedAt,
    completedAt: null,
    assistantMessageId: replyId,
  };
  // The thread row as the shell stream sends it; every call builds fresh nested objects.
  const shellRow = (overrides: Record<string, unknown> = {}) => ({
    id: threadA,
    projectId,
    title: "Streaming",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: { ...latestTurn },
    createdAt: startedAt,
    updatedAt: startedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: { ...orchestrationSession },
    latestUserMessageAt: startedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  });
  const userMessage = {
    id: userMessageId,
    role: "user",
    text: "Say hello",
    turnId,
    streaming: false,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const reply = (text: string) => ({
    id: replyId,
    role: "assistant",
    text,
    turnId,
    streaming: true,
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  /** A thread mid-turn: its shell listed, its detail loaded, its reply streaming `replyText`. */
  function streamingState(replyText = "Hel", threadId = threadA): AppState {
    const listed = syncServerShellSnapshot(
      { activeEnvironmentId: null, environmentStateById: {} },
      {
        snapshotSequence: 1,
        projects: [],
        worktrees: [],
        threads: [shellRow({ id: threadId })],
        updatedAt: startedAt,
      } as never,
      environmentId,
    );
    return syncServerThreadDetail(
      listed,
      {
        ...shellRow({ id: threadId }),
        deletedAt: null,
        messages: [userMessage, reply(replyText)],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      } as unknown as OrchestrationThread,
      environmentId,
    );
  }

  let sequence = 10;
  let clock = Date.parse(startedAt);
  const nextTime = () => new Date((clock += 1_000)).toISOString();
  function event(type: OrchestrationEvent["type"], payload: object, occurredAt = nextTime()) {
    sequence += 1;
    return {
      sequence,
      eventId: EventId.make(`event-${sequence}`),
      aggregateKind: "thread",
      aggregateId: threadA,
      occurredAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    } as unknown as OrchestrationEvent;
  }
  function messageSent(
    text: string,
    options: {
      readonly messageId?: MessageId;
      readonly role?: "user" | "assistant";
      readonly streaming?: boolean;
      readonly attachments?: ReadonlyArray<object>;
      readonly threadId?: ThreadId;
    } = {},
  ) {
    const at = nextTime();
    return event(
      "thread.message-sent",
      {
        threadId: options.threadId ?? threadA,
        messageId: options.messageId ?? replyId,
        role: options.role ?? "assistant",
        text,
        turnId,
        streaming: options.streaming ?? true,
        createdAt: startedAt,
        updatedAt: at,
        ...(options.attachments ? { attachments: options.attachments } : {}),
      },
      at,
    );
  }
  const apply = (state: AppState, ...events: OrchestrationEvent[]) =>
    applyOrchestrationEvents(state, events, environmentId);
  const replyOf = (thread: Thread | undefined) =>
    thread?.messages.find((message) => message.id === replyId);

  it("holds while a streaming reply's text grows; the live text is read per message", () => {
    const select = createThreadStructureSelectorByRef(ref);
    const selectLive = createThreadSelectorByRef(ref);
    const initial = streamingState("Hel");
    const held = select(initial)!;

    const next = apply(initial, messageSent("lo"));
    expect(select(next)).toBe(held);
    expect(select(next)?.updatedAt).toBe(held.updatedAt);
    // Same state in, same value out.
    expect(select(next)).toBe(held);
    const live = selectLive(next)!;
    expect(live).not.toBe(held);
    expect(live.updatedAt).not.toBe(held.updatedAt);
    expect(replyOf(live)?.text).toBe("Hello");
    expect(selectThreadMessageText(next, ref, replyId)).toBe("Hello");
    expect(selectThreadMessageText(next, ref, MessageId.make("missing"))).toBeUndefined();
  });

  it("keeps holding over many deltas, compared with the held thread", () => {
    const select = createThreadStructureSelectorByRef(ref);
    let state = streamingState("Hel");
    const held = select(state);
    for (const chunk of ["lo", ",", " wor", "ld"]) {
      state = apply(state, messageSent(chunk));
      expect(select(state)).toBe(held);
    }
    expect(selectThreadMessageText(state, ref, replyId)).toBe("Hello, world");
  });

  it("releases on the first text of a reply that started empty, then holds", () => {
    const select = createThreadStructureSelectorByRef(ref);
    const empty = streamingState("");
    const before = select(empty);
    const first = apply(empty, messageSent("x"));
    const released = select(first);
    expect(released).not.toBe(before);
    expect(replyOf(released)?.text).toBe("x");
    expect(select(apply(first, messageSent("y")))).toBe(released);
  });

  it("releases with the final text when the stream ends", () => {
    const select = createThreadStructureSelectorByRef(ref);
    const initial = streamingState("Hel");
    const held = select(initial);
    const grown = apply(initial, messageSent("lo"));
    expect(select(grown)).toBe(held);
    const ended = select(apply(grown, messageSent("", { streaming: false })));
    expect(ended).not.toBe(held);
    expect(replyOf(ended)).toMatchObject({ text: "Hello", streaming: false });
  });

  it("releases when a message is added", () => {
    const select = createThreadStructureSelectorByRef(ref);
    const initial = streamingState("Hel");
    const held = select(initial);
    const withSecondReply = apply(
      initial,
      messageSent("Another", { messageId: MessageId.make("message-reply-2") }),
    );
    const afterReply = select(withSecondReply);
    expect(afterReply).not.toBe(held);
    expect(afterReply?.messages).toHaveLength(3);
    const withFollowUp = apply(
      withSecondReply,
      messageSent("Follow-up", {
        messageId: MessageId.make("message-user-2"),
        role: "user",
        streaming: false,
      }),
    );
    expect(select(withFollowUp)).not.toBe(afterReply);
    expect(select(withFollowUp)?.messages).toHaveLength(4);
  });

  it.each([
    [
      "a session change",
      () =>
        event("thread.session-set", {
          threadId: threadA,
          session: { ...orchestrationSession, updatedAt: nextTime() },
        }),
    ],
    [
      "an appended activity",
      () =>
        event("thread.activity-appended", {
          threadId: threadA,
          activity: {
            id: EventId.make("activity-1"),
            tone: "info",
            kind: "task.progress",
            summary: "Working",
            payload: {},
            turnId,
            createdAt: nextTime(),
          },
        }),
    ],
    [
      "a title change",
      () =>
        event("thread.meta-updated", {
          threadId: threadA,
          title: "Renamed",
          updatedAt: nextTime(),
        }),
    ],
    [
      "a turn diff",
      () =>
        event("thread.turn-diff-completed", {
          threadId: threadA,
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-1",
          status: "ready",
          files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }],
          assistantMessageId: replyId,
          completedAt: nextTime(),
        }),
    ],
    [
      "a proposed plan",
      () =>
        event("thread.proposed-plan-upserted", {
          threadId: threadA,
          proposedPlan: {
            id: "plan-1",
            turnId,
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: nextTime(),
            updatedAt: nextTime(),
          },
        }),
    ],
    [
      "new attachments on the streaming reply",
      () =>
        messageSent("", {
          attachments: [
            {
              type: "file",
              id: "attachment-1",
              name: "a.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
        }),
    ],
  ])("releases on %s", (_label, makeEvent) => {
    const select = createThreadStructureSelectorByRef(ref);
    const initial = streamingState("Hel");
    const held = select(initial);
    const grown = apply(initial, messageSent("lo"));
    expect(select(grown)).toBe(held);
    const changed = apply(grown, makeEvent());
    const released = select(changed);
    expect(released).not.toBe(held);
    // The released thread is the newest one, its current text included.
    expect(released).toBe(createThreadSelectorByRef(ref)(changed));
    expect(replyOf(released)?.text).toBe("Hello");
  });

  it("forgets the hold when the thread leaves or its body is evicted", () => {
    const select = createThreadStructureSelectorByRef(ref);
    const initial = streamingState("Hel");
    const held = select(initial);
    const grown = apply(initial, messageSent("lo"));
    expect(select(grown)).toBe(held);
    expect(select(removeThreadByRef(grown, ref))).toBeUndefined();
    // Added back: returned live, not compared with the thread it held before.
    const readded = streamingState("Hello again");
    const readdedThread = select(readded);
    expect(replyOf(readdedThread)?.text).toBe("Hello again");
    // An evicted body empties the messages: structure, not streamed text.
    const evicted = select(evictThreadBodies(apply(readded, messageSent("!")), [ref]));
    expect(evicted).not.toBe(readdedThread);
    expect(evicted?.messages).toEqual([]);
  });

  it("keeps a separate hold per selector", () => {
    const selectA = createThreadStructureSelectorByRef(ref);
    const refB = { environmentId, threadId: threadB } satisfies ScopedThreadRef;
    const selectB = createThreadStructureSelectorByRef(refB);
    const initial = syncServerThreadDetail(
      streamingState("Hel"),
      {
        ...shellRow({ id: threadB }),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      } as unknown as OrchestrationThread,
      environmentId,
    );
    const heldA = selectA(initial);
    const threadBBefore = selectB(initial);
    const grown = apply(initial, messageSent("lo"));
    expect(selectA(grown)).toBe(heldA);
    expect(selectB(grown)).toBe(threadBBefore);
    // Thread B gets a reply: a structural change for B alone.
    const replied = apply(
      grown,
      messageSent("Hi", { threadId: threadB, messageId: MessageId.make("message-b") }),
    );
    expect(selectB(replied)).not.toBe(threadBBefore);
    expect(selectA(replied)).toBe(heldA);
  });
});

describe("threadDiffersOnlyInStreamedText", () => {
  const streamingMessage = (id: string, text: string): ChatMessage => ({
    id: MessageId.make(id),
    role: "assistant",
    text,
    turnId: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    streaming: true,
  });
  const thread = (overrides: Partial<Thread> = {}): Thread =>
    ({
      ...makeShell(threadA, { updatedAt: "2026-06-12T10:00:00.000Z" }),
      session: null,
      latestTurn: null,
      messages: [],
      activities: [],
      proposedPlans: [],
      turnDiffSummaries: [],
      ...overrides,
    }) as Thread;

  it("accepts an updatedAt-only change and several streaming messages growing at once", () => {
    const first = streamingMessage("a", "One");
    const second = streamingMessage("b", "Two");
    const previous = thread({ messages: [first, second] });
    expect(
      threadDiffersOnlyInStreamedText(previous, {
        ...previous,
        updatedAt: "2026-06-12T10:00:05.000Z",
      }),
    ).toBe(true);
    expect(
      threadDiffersOnlyInStreamedText(previous, {
        ...previous,
        messages: [
          { ...first, text: "One more" },
          { ...second, text: "Two more" },
        ],
      }),
    ).toBe(true);
  });

  it("treats a dropped key, a shifted window and non-streamed text as structure", () => {
    const withGoal = thread({ goal: null });
    const { goal: _goal, ...withoutGoal } = withGoal;
    expect(threadDiffersOnlyInStreamedText(withGoal, withoutGoal as Thread)).toBe(false);

    const [a, b, c] = [
      streamingMessage("a", "A"),
      streamingMessage("b", "B"),
      streamingMessage("c", "C"),
    ];
    expect(
      threadDiffersOnlyInStreamedText(thread({ messages: [a, b] }), thread({ messages: [b, c] })),
    ).toBe(false);

    const user: ChatMessage = { ...a, role: "user" };
    expect(
      threadDiffersOnlyInStreamedText(
        thread({ messages: [user] }),
        thread({ messages: [{ ...user, text: "AB" }] }),
      ),
    ).toBe(false);
  });
});

describe("createThreadSummaryStructureSelectorByRef", () => {
  const ref = { environmentId, threadId: threadA } satisfies ScopedThreadRef;
  const updatedAt = "2026-06-12T10:00:00.000Z";
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: threadA,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: updatedAt,
      startedAt: updatedAt,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: threadA,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-1"),
      lastError: null,
      updatedAt,
    },
    latestUserMessageAt: updatedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  });
  let sequence = 1;
  const upsert = (state: AppState, overrides: Record<string, unknown> = {}) =>
    applyShellEvent(
      state,
      { kind: "thread-upserted", sequence: (sequence += 1), thread: row(overrides) } as never,
      environmentId,
    );
  const listed = () =>
    syncServerShellSnapshot(
      { activeEnvironmentId: null, environmentStateById: {} },
      { snapshotSequence: 1, projects: [], worktrees: [], threads: [row()], updatedAt } as never,
      environmentId,
    );

  it("keeps the summary, and the thread's nested shell values, across an updatedAt-only upsert", () => {
    const selectSummary = createThreadSummaryStructureSelectorByRef(ref);
    const selectStructure = createThreadStructureSelectorByRef(ref);
    const before = listed();
    const summary = selectSummary(before);
    const thread = selectStructure(before);
    const previousShell = before.environmentStateById[environmentId]!.threadShellById[threadA];

    // A fresh row with fresh nested objects, as every shell upsert maps one.
    const after = upsert(before, { updatedAt: "2026-06-12T10:00:01.000Z" });
    const environment = after.environmentStateById[environmentId]!;
    const shell = environment.threadShellById[threadA] as ThreadShell;
    expect(shell).not.toBe(previousShell);
    expect(shell.updatedAt).toBe("2026-06-12T10:00:01.000Z");
    expect(shell.modelSelection).toBe((previousShell as ThreadShell).modelSelection);
    const writtenSummary = environment.sidebarThreadSummaryById[threadA] as SidebarThreadSummary;
    expect(writtenSummary.updatedAt).toBe("2026-06-12T10:00:01.000Z");
    expect(writtenSummary.session).toBe(summary?.session);
    expect(writtenSummary.latestTurn).toBe(summary?.latestTurn);

    expect(selectSummary(after)).toBe(summary);
    expect(selectStructure(after)).toBe(thread);
  });

  it("releases on any other summary change", () => {
    const selectSummary = createThreadSummaryStructureSelectorByRef(ref);
    const before = listed();
    const summary = selectSummary(before);
    const after = upsert(before, {
      updatedAt: "2026-06-12T10:00:01.000Z",
      hasPendingApprovals: true,
    });
    expect(selectSummary(after)).not.toBe(summary);
    expect(selectSummary(after)?.hasPendingApprovals).toBe(true);
    expect(selectSummary(removeThreadByRef(after, ref))).toBeUndefined();
    expect(createThreadSummaryStructureSelectorByRef(null)(after)).toBeUndefined();
  });
});
