import {
  MessageId,
  ProviderInstanceId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { assert, describe, it } from "@effect/vitest";

import {
  describeRunResult,
  evaluateRun,
  findProject,
  followUpQueueBlocker,
  formatRunResult,
  formatTranscript,
  initialRunFacts,
  isBusyTurnStartRejection,
  latestRunFacts,
  observeRunEvent,
  queueGate,
  queuedMessageBlocker,
  resolveStartModel,
  resolveStartRuntimeMode,
  runExitCode,
  threadTitleFromPrompt,
  waitsInFollowUpQueue,
  type RunFacts,
  type RunState,
} from "./threadRun.ts";

const T0 = "2026-10-28T10:00:00.000Z";
const T1 = "2026-10-28T10:00:01.000Z";
const T2 = "2026-10-28T10:00:02.000Z";
const T3 = "2026-10-28T10:00:03.000Z";

const ours = MessageId.make("message-ours");
const theirs = MessageId.make("message-theirs");
const earlierTurn = TurnId.make("turn-earlier");
const ourTurn = TurnId.make("turn-ours");
const laterTurn = TurnId.make("turn-later");

type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

const session = (
  status: SessionStatus,
  activeTurnId: TurnId | null = null,
  options: { readonly lastError?: string; readonly updatedAt?: string } = {},
) => ({
  threadId: "thread-1",
  status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId,
  lastError: options.lastError ?? null,
  updatedAt: options.updatedAt ?? T2,
});

const latestTurn = (
  turnId: TurnId,
  state: "running" | "completed" | "interrupted" | "error",
  userMessageId?: MessageId,
) => ({
  turnId,
  state,
  requestedAt: T0,
  startedAt: T1,
  completedAt: state === "running" ? null : T2,
  assistantMessageId: null,
  ...(userMessageId === undefined ? {} : { userMessageId }),
});

const shell = (extra: Record<string, unknown> = {}): OrchestrationThreadShell =>
  ({
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    archivedAt: null,
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...extra,
  }) as never;

let sequence = 0;
const event = (type: string, payload: Record<string, unknown>) =>
  ({ sequence: ++sequence, type, payload }) as unknown as OrchestrationEvent;

const turnStartRequested = (messageId: MessageId) =>
  event("thread.turn-start-requested", { threadId: "thread-1", messageId, createdAt: T0 });

const sessionSet = (
  status: SessionStatus,
  activeTurnId: TurnId | null,
  released?: { turnId: TurnId; state: "completed" | "error" | "interrupted" },
  lastError?: string,
) =>
  event("thread.session-set", {
    threadId: "thread-1",
    session: session(status, activeTurnId, lastError === undefined ? {} : { lastError }),
    ...(released === undefined
      ? {}
      : { releasedTurn: { ...released, completedAt: T2, reason: "test" } }),
  });

const fold = (facts: RunFacts, events: ReadonlyArray<OrchestrationEvent>) =>
  events.reduce(observeRunEvent, facts);

describe("runExitCode", () => {
  it("maps every run state to the exit code scripts read", () => {
    const codes: Record<RunState, number> = {
      started: 0,
      completed: 0,
      failed: 1,
      stopped: 1,
      unknown: 5,
      "needs-approval": 2,
      "needs-input": 2,
      held: 2,
      restarted: 3,
      "timed-out": 4,
    };
    for (const [state, code] of Object.entries(codes)) {
      assert.strictEqual(runExitCode(state as RunState), code, state);
    }
  });
});

describe("binding the run to its own turn", () => {
  it("never ends on a turn that was already running", () => {
    // Another client's turn runs; this command's message waits behind it.
    let facts = fold(initialRunFacts({ messageId: ours }), [turnStartRequested(theirs)]);
    facts = fold(facts, [
      sessionSet("running", earlierTurn),
      turnStartRequested(ours),
      sessionSet("ready", null, { turnId: earlierTurn, state: "completed" }),
    ]);
    assert.isNull(facts.turnId);
    const afterEarlier = shell({
      session: session("ready", null, { updatedAt: T3 }),
      latestTurn: latestTurn(earlierTurn, "completed", theirs),
    });
    assert.deepEqual(evaluateRun(afterEarlier, facts), { done: false, turnId: null });

    facts = fold(facts, [sessionSet("running", ourTurn)]);
    assert.strictEqual(facts.turnId, ourTurn);
    const running = shell({
      session: session("running", ourTurn),
      latestTurn: latestTurn(ourTurn, "running", ours),
    });
    assert.deepEqual(evaluateRun(running, facts), { done: false, turnId: ourTurn });

    facts = fold(facts, [sessionSet("ready", null, { turnId: ourTurn, state: "completed" })]);
    const evaluation = evaluateRun(
      shell({
        session: session("ready", null, { updatedAt: T3 }),
        latestTurn: latestTurn(ourTurn, "completed", ours),
      }),
      facts,
    );
    assert.deepInclude(evaluation, { done: true, state: "completed", turnId: ourTurn });
  });

  it("binds from the shell when the events were missed", () => {
    const evaluation = evaluateRun(
      shell({
        session: session("ready", null, { updatedAt: T3 }),
        latestTurn: latestTurn(ourTurn, "completed", ours),
      }),
      initialRunFacts({ messageId: ours }),
    );
    assert.deepInclude(evaluation, { done: true, state: "completed", turnId: ourTurn });
  });

  it("does not take a later turn's start for its own end", () => {
    // The run completed, and a queued message from elsewhere is already starting.
    const facts = initialRunFacts({ turnId: ourTurn });
    const evaluation = evaluateRun(
      shell({ session: session("starting"), latestTurn: latestTurn(ourTurn, "completed") }),
      facts,
    );
    assert.deepInclude(evaluation, { done: true, state: "completed" });
  });

  it("keeps how its turn ended after a later turn took over", () => {
    const facts = fold(initialRunFacts({ turnId: ourTurn }), [
      sessionSet("error", null, { turnId: ourTurn, state: "error" }, "The provider crashed."),
    ]);
    const evaluation = evaluateRun(
      shell({
        session: session("running", laterTurn),
        latestTurn: latestTurn(laterTurn, "running"),
      }),
      facts,
    );
    assert.deepInclude(evaluation, { done: true, state: "failed", error: "The provider crashed." });
  });

  it("does not know how a turn ended once a later one replaced it unseen", () => {
    const evaluation = evaluateRun(
      shell({
        session: session("running", laterTurn),
        latestTurn: latestTurn(laterTurn, "running"),
      }),
      initialRunFacts({ turnId: ourTurn }),
    );
    assert.deepInclude(evaluation, { done: true, state: "unknown" });
  });

  it("fails a turn start the node gave up before any turn ran", () => {
    const facts = fold(initialRunFacts({ messageId: ours }), [
      event("thread.activity-appended", {
        threadId: "thread-1",
        activity: {
          id: "activity-1",
          kind: "provider.turn.start.failed",
          tone: "error",
          summary: "Turn start failed",
          payload: { messageId: ours, detail: "Model unavailable." },
          turnId: null,
          createdAt: T1,
        },
      }),
    ]);
    const evaluation = evaluateRun(shell({ session: session("ready") }), facts);
    assert.deepInclude(evaluation, { done: true, state: "failed", error: "Model unavailable." });
  });
});

describe("how the run ended", () => {
  const runningShell = (extra: Record<string, unknown> = {}) =>
    shell({
      session: session("running", ourTurn),
      latestTurn: latestTurn(ourTurn, "running", ours),
      ...extra,
    });

  it("needs a person when its running turn waits for an approval or an answer", () => {
    const facts = initialRunFacts({ turnId: ourTurn });
    assert.deepInclude(evaluateRun(runningShell({ hasPendingApprovals: true }), facts), {
      done: true,
      state: "needs-approval",
    });
    assert.deepInclude(evaluateRun(runningShell({ hasPendingUserInput: true }), facts), {
      done: true,
      state: "needs-input",
    });
  });

  it("reports a turn a node restart cut off, from the release or from the shell", () => {
    const released = fold(initialRunFacts({ turnId: ourTurn }), [
      sessionSet(
        "error",
        null,
        { turnId: ourTurn, state: "interrupted" },
        ORPHANED_PROVIDER_SESSION_ERROR,
      ),
    ]);
    // A restart continuation already runs the next turn.
    assert.deepInclude(
      evaluateRun(
        shell({
          session: session("running", laterTurn),
          latestTurn: latestTurn(laterTurn, "running"),
        }),
        released,
      ),
      { done: true, state: "restarted" },
    );
    assert.deepInclude(
      evaluateRun(
        shell({
          session: session("error", null, { lastError: ORPHANED_PROVIDER_SESSION_ERROR }),
          latestTurn: latestTurn(ourTurn, "interrupted"),
        }),
        initialRunFacts({ turnId: ourTurn }),
      ),
      { done: true, state: "restarted" },
    );
  });

  it("tells a stopped turn from a failed one", () => {
    const facts = initialRunFacts({ turnId: ourTurn });
    assert.deepInclude(
      evaluateRun(
        shell({
          session: session("ready", null, { updatedAt: T3 }),
          latestTurn: latestTurn(ourTurn, "interrupted"),
        }),
        facts,
      ),
      { done: true, state: "stopped" },
    );
    assert.deepInclude(
      evaluateRun(
        shell({
          session: session("error", null, { lastError: "Out of credits.", updatedAt: T3 }),
          latestTurn: latestTurn(ourTurn, "error"),
        }),
        facts,
      ),
      { done: true, state: "failed", error: "Out of credits." },
    );
  });

  it("ends a turn row the session already released", () => {
    const evaluation = evaluateRun(
      shell({
        session: session("ready", null, { updatedAt: T3 }),
        latestTurn: latestTurn(ourTurn, "running"),
      }),
      initialRunFacts({ turnId: ourTurn }),
    );
    assert.deepInclude(evaluation, { done: true, state: "completed" });
  });

  it("reports a deleted thread", () => {
    assert.deepInclude(evaluateRun(null, initialRunFacts({ turnId: ourTurn })), {
      done: true,
      state: "failed",
    });
  });
});

describe("the turn `wait` follows", () => {
  it("is the running turn, else a pending start's turn, else the latest", () => {
    assert.strictEqual(
      latestRunFacts(shell({ session: session("running", ourTurn) }))?.turnId,
      ourTurn,
    );
    assert.strictEqual(
      latestRunFacts(shell({ latestTurn: latestTurn(ourTurn, "completed") }))?.turnId,
      ourTurn,
    );
    assert.isNull(latestRunFacts(shell()));

    const pending = latestRunFacts(
      shell({ session: session("starting"), latestTurn: latestTurn(earlierTurn, "completed") }),
    )!;
    assert.strictEqual(pending.nextTurnAfter, earlierTurn);
    // The earlier turn does not stand in for the pending one.
    assert.deepEqual(
      evaluateRun(
        shell({ session: session("starting"), latestTurn: latestTurn(earlierTurn, "completed") }),
        pending,
      ),
      { done: false, turnId: null },
    );
    const bound = fold(pending, [sessionSet("running", ourTurn)]);
    assert.strictEqual(bound.turnId, ourTurn);
  });
});

describe("queueing behind a running turn", () => {
  it("waits while the thread runs or waits for a person, and sends once it is idle", () => {
    assert.strictEqual(queueGate(shell({ session: session("running", earlierTurn) })).kind, "wait");
    assert.strictEqual(queueGate(shell({ session: session("starting") })).kind, "wait");
    assert.strictEqual(queueGate(shell({ hasPendingApprovals: true })).kind, "wait");
    assert.strictEqual(
      queueGate(
        shell({ session: session("ready"), latestTurn: latestTurn(earlierTurn, "completed") }),
      ).kind,
      "ready",
    );
    // A turn row the session already released does not hold the queue.
    assert.strictEqual(
      queueGate(
        shell({
          session: session("ready", null, { updatedAt: T3 }),
          latestTurn: latestTurn(earlierTurn, "running"),
        }),
      ).kind,
      "ready",
    );
    assert.strictEqual(queueGate(shell({ archivedAt: T0 })).kind, "unavailable");
    assert.strictEqual(queueGate(null).kind, "unavailable");
  });

  it("recognizes the node refusing a start because another turn got there first", () => {
    assert.isTrue(
      isBusyTurnStartRejection(
        new Error(
          "Thread 'thread-1' already has active turn 'turn-1' and cannot start another turn until it finishes.",
        ),
      ),
    );
    assert.isFalse(isBusyTurnStartRejection(new Error("Project is unavailable.")));
  });
});

describe("a message in the node's follow-up queue", () => {
  const queued = () => initialRunFacts({ messageId: ours, queued: true });
  const removed = (reason: string) =>
    event("thread.queue-entries-removed", {
      threadId: "thread-1",
      messageIds: [ours],
      reason,
      updatedAt: T1,
    });
  const hold = (reason: string, causeKeys: ReadonlyArray<string>, detail: string | null = null) =>
    ({ reason, detail, causeKeys, heldAt: T1 }) as never;
  const entry = (messageId: MessageId, status = "queued") =>
    ({ messageId, status, text: "Next", author: "user", attachments: [] }) as never;
  const bySlotOnly = (value: { readonly causeKeys: ReadonlyArray<string> }) =>
    value.causeKeys.every((key) => key.startsWith("delegation-slot:"));

  it("waits in the queue until the node sends it, and binds the turn the node starts", () => {
    let facts = queued();
    assert.isTrue(waitsInFollowUpQueue(facts));
    assert.isFalse(waitsInFollowUpQueue(initialRunFacts({ messageId: ours })));
    // The drain's turn start takes it out of the queue in one batch.
    facts = fold(facts, [removed("dispatched"), turnStartRequested(ours)]);
    assert.isFalse(waitsInFollowUpQueue(facts));
    facts = fold(facts, [sessionSet("running", ourTurn)]);
    assert.strictEqual(facts.turnId, ourTurn);
  });

  it("ends when a person removes it, and follows the turn it was steered into", () => {
    const evaluation = evaluateRun(
      shell({ session: session("running", earlierTurn) }),
      fold(queued(), [removed("user")]),
    );
    assert.deepInclude(evaluation, { done: true, state: "stopped", turnId: null });

    const steered = fold(queued(), [
      event("thread.turn-steer-accepted", {
        threadId: "thread-1",
        messageId: ours,
        expectedTurnId: earlierTurn,
        turnId: earlierTurn,
        resolvedAt: T1,
      }),
      removed("steered"),
    ]);
    assert.strictEqual(steered.turnId, earlierTurn);
    assert.deepInclude(
      evaluateRun(
        shell({
          session: session("running", earlierTurn),
          latestTurn: latestTurn(earlierTurn, "running"),
        }),
        steered,
      ),
      { done: false, turnId: earlierTurn },
    );
  });

  it("is blocked by a hold or a head waiting for Retry, never by a hold the node lifts", () => {
    assert.isNull(followUpQueueBlocker(null, bySlotOnly));
    assert.isNull(followUpQueueBlocker({ hold: null, headStatus: "queued" }, bySlotOnly));
    assert.isNull(followUpQueueBlocker({ hold: null, headStatus: "steering" }, bySlotOnly));
    assert.strictEqual(
      followUpQueueBlocker(
        { hold: hold("error", ["error:turn-1:boom"], "The provider crashed."), headStatus: null },
        bySlotOnly,
      ),
      "Paused after an error: The provider crashed.",
    );
    assert.strictEqual(
      followUpQueueBlocker(
        { hold: hold("interrupted", ["interrupt:turn-1"]), headStatus: "queued" },
        bySlotOnly,
      ),
      "Paused after Stop.",
    );
    assert.strictEqual(
      followUpQueueBlocker({ hold: null, headStatus: "failed" }, bySlotOnly),
      "A queued message waits for Retry.",
    );
    assert.isNull(
      followUpQueueBlocker(
        {
          hold: hold("paused", ["delegation-slot:proposal-1"], "Waiting for a free slot."),
          headStatus: "queued",
        },
        bySlotOnly,
      ),
    );
    // Only while the message itself is still in the queue.
    const paused = { entries: [entry(theirs), entry(ours)], hold: hold("paused", ["paused:1"]) };
    assert.strictEqual(queuedMessageBlocker(paused as never, ours, bySlotOnly), "Paused.");
    assert.isNull(
      queuedMessageBlocker({ ...paused, entries: [entry(theirs)] } as never, ours, bySlotOnly),
    );
    assert.isNull(queuedMessageBlocker(undefined, ours, bySlotOnly));
  });

  it("tells a person the message stays queued", () => {
    const result = {
      threadId: "thread-1",
      turnId: null,
      state: "held" as const,
      reply: null,
      error: "Paused after Stop.",
    };
    assert.strictEqual(runExitCode(result.state), 2);
    const note = describeRunResult(result) ?? "";
    assert.include(note, "Paused after Stop.");
    assert.include(note, "waits in the follow-up queue of thread thread-1");
  });
});

describe("starting a thread", () => {
  const projectDefault = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
    options: [{ id: "effort", value: "high" }],
  };

  it("starts at the project's runtime mode and refuses one above it", () => {
    assert.deepEqual(resolveStartRuntimeMode(null), { runtimeMode: "full-access" });
    assert.deepEqual(resolveStartRuntimeMode("approval-required", "auto"), {
      runtimeMode: "approval-required",
    });
    assert.property(resolveStartRuntimeMode("full-access", "auto"), "error");
  });

  it("reads --model as instance/model and keeps the default's options for the same model", () => {
    assert.deepEqual(resolveStartModel(null, projectDefault), { modelSelection: projectDefault });
    assert.deepEqual(resolveStartModel("codex/gpt-5.5", projectDefault), {
      modelSelection: projectDefault,
    });
    assert.deepEqual(resolveStartModel("opencode/anthropic/claude-sonnet", projectDefault), {
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "anthropic/claude-sonnet",
      },
    });
    assert.property(resolveStartModel("gpt-5.5", projectDefault), "error");
    assert.property(resolveStartModel("codex/", projectDefault), "error");
  });

  it("finds the project by id or by the deepest folder holding the path", () => {
    const projects = [
      { id: "outer", workspaceRoot: "/work" },
      { id: "inner", workspaceRoot: "/work/app" },
    ] as unknown as ReadonlyArray<OrchestrationProjectShell>;
    assert.strictEqual(findProject(projects, "outer", null)?.id, "outer");
    assert.strictEqual(findProject(projects, "x", "/work/app/src")?.id, "inner");
    assert.strictEqual(findProject(projects, "x", "/work/docs")?.id, "outer");
    assert.isNull(findProject(projects, "x", "/elsewhere"));
    assert.isNull(findProject(projects, "x", "/workbench"));
    const withChat = [
      ...projects,
      { id: "chat", kind: "chat", workspaceRoot: "/work/app/chats/today" },
    ] as unknown as ReadonlyArray<OrchestrationProjectShell>;
    assert.strictEqual(findProject(withChat, "x", "/work/app/chats/today")?.id, "inner");
    assert.strictEqual(findProject(withChat, "chat", null)?.id, "chat");
  });

  it("titles the thread from the message's first line", () => {
    assert.strictEqual(threadTitleFromPrompt("\n  Fix the tests\nThen ship"), "Fix the tests");
    assert.strictEqual(threadTitleFromPrompt("x".repeat(80)), `${"x".repeat(50)}...`);
  });
});

describe("output", () => {
  const result = {
    threadId: "thread-1",
    turnId: ourTurn,
    state: "completed" as const,
    reply: "Done.",
    error: null,
  };

  it("prints the reply, or one JSON line under --json", () => {
    assert.strictEqual(formatRunResult(result, { json: false, startedId: "turn" }), "Done.");
    assert.deepEqual(JSON.parse(formatRunResult(result, { json: true, startedId: "turn" })!), {
      threadId: "thread-1",
      turnId: ourTurn,
      state: "completed",
      reply: "Done.",
      error: null,
    });
  });

  it("prints a page's messages and its follow-up queue, next first", () => {
    const text = formatTranscript({
      thread: {
        threadId: "thread-1",
        projectId: "project-1",
        title: "Thread",
        status: "running",
        activeTurnId: ourTurn,
        providerInstanceId: null,
        archived: false,
        createdAt: T0,
        updatedAt: T1,
      },
      messages: [
        {
          messageId: "message-1",
          role: "user",
          text: "Fix it",
          truncated: false,
          turnId: ourTurn,
          attachmentCount: 0,
          createdAt: T0,
        },
      ],
      hasMoreBefore: false,
      nextCursor: null,
      followUpQueue: {
        hold: { reason: "error", detail: "The provider crashed.", heldAt: T1 },
        entries: [
          {
            messageId: "message-2",
            author: "user",
            status: "queued",
            text: "Then run the tests",
            attachmentCount: 0,
            createdAt: T1,
          },
          {
            messageId: "message-3",
            author: "agent",
            status: "failed",
            text: "Check",
            textTruncated: true,
            attachmentCount: 0,
            createdAt: T1,
          },
        ],
      },
    });
    assert.strictEqual(
      text,
      [
        "Thread",
        "thread-1  running",
        "",
        "[user]",
        "Fix it",
        "",
        "[queued, held: Paused after an error: The provider crashed.]",
        "1. (user) Then run the tests",
        "2. (agent, failed) Check […]",
      ].join("\n"),
    );
  });

  it("prints the id a script passes on for a run it did not wait for", () => {
    const started = { ...result, state: "started" as const, reply: null };
    assert.strictEqual(formatRunResult(started, { json: false, startedId: "thread" }), "thread-1");
    assert.strictEqual(formatRunResult(started, { json: false, startedId: "turn" }), ourTurn);
  });
});
