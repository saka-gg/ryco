import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationSessionStatus,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "../../scoped.ts";
import type { AppState, EnvironmentState } from "./store.ts";
import {
  hasComposerDraftContent,
  hasUnsentThreadWork,
  isThreadNonIdle,
  planThreadBodyResidency,
  selectThreadBodyUsage,
  THREAD_BODY_MAX_BYTES,
  THREAD_BODY_MAX_THREADS,
  THREAD_WORKING_SESSION_STATUSES,
  type ComposerDraftContent,
  type ThreadBodyResidencyEntry,
} from "./threadBodyResidency.ts";

const environmentId = EnvironmentId.make("environment-residency");
const otherEnvironmentId = EnvironmentId.make("environment-other");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const ref = scopeThreadRef(environmentId, threadId);

function emptyEnvironment(): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
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
  };
}

function appState(
  environment: Partial<EnvironmentState> = {},
  activeEnvironmentId: EnvironmentId | null = environmentId,
): AppState {
  return {
    activeEnvironmentId,
    environmentStateById: { [environmentId]: { ...emptyEnvironment(), ...environment } },
  };
}

// The entries below carry only what the predicate reads.
const fullShell = { id: threadId, projectId, archivedAt: null } as never;
const stub = { shellDetail: "archived-stub", id: threadId, projectId } as never;
const session = (status: OrchestrationSessionStatus) => ({ orchestrationStatus: status });
const turn = (state: "running" | "completed") => ({ turnId: "turn-1", state });

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: threadId,
    projectId,
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as never;
}

describe("isThreadNonIdle", () => {
  it("is false for a thread or environment the store does not know", () => {
    expect(isThreadNonIdle(appState(), ref)).toBe(false);
    expect(isThreadNonIdle(appState(), scopeThreadRef(otherEnvironmentId, threadId))).toBe(false);
  });

  it("counts only a starting or running session as working", () => {
    expect([...THREAD_WORKING_SESSION_STATUSES].toSorted()).toEqual(["running", "starting"]);
  });

  it.each([
    ["pending approvals", { hasPendingApprovals: true }],
    ["pending user input", { hasPendingUserInput: true }],
    ["a running latest turn", { latestTurn: turn("running") }],
    ["a starting session", { session: session("starting") }],
    ["a running session", { session: session("running") }],
  ])("is true for a summary with %s", (_name, overrides) => {
    const state = appState({ sidebarThreadSummaryById: { [threadId]: summary(overrides) } });
    expect(isThreadNonIdle(state, ref)).toBe(true);
  });

  it.each([
    ["a ready session", { session: session("ready") }],
    ["an interrupted session", { session: session("interrupted") }],
    ["an errored session", { session: session("error") }],
    ["an idle session", { session: session("idle") }],
    ["a stopped session", { session: session("stopped") }],
    ["a completed latest turn", { latestTurn: turn("completed") }],
    [
      "a ready session after a completed turn",
      { session: session("ready"), latestTurn: turn("completed") },
    ],
    ["an actionable proposed plan", { hasActionableProposedPlan: true }],
    ["nothing pending", {}],
  ])("is false for a summary with %s", (_name, overrides) => {
    const state = appState({ sidebarThreadSummaryById: { [threadId]: summary(overrides) } });
    expect(isThreadNonIdle(state, ref)).toBe(false);
  });

  it.each([
    ["a starting session", { threadSessionById: { [threadId]: session("starting") } }],
    ["a running session", { threadSessionById: { [threadId]: session("running") } }],
    [
      "a running latest turn",
      { threadTurnStateById: { [threadId]: { latestTurn: turn("running") } } },
    ],
  ])("is true for a shell whose records hold %s", (_name, records) => {
    const state = appState({
      threadShellById: { [threadId]: fullShell },
      ...(records as Partial<EnvironmentState>),
    });
    expect(isThreadNonIdle(state, ref)).toBe(true);
  });

  it.each([
    ["a ready session", { threadSessionById: { [threadId]: session("ready") } }],
    ["an interrupted session", { threadSessionById: { [threadId]: session("interrupted") } }],
    ["an errored session", { threadSessionById: { [threadId]: session("error") } }],
    ["an idle session", { threadSessionById: { [threadId]: session("idle") } }],
    ["a stopped session", { threadSessionById: { [threadId]: session("stopped") } }],
    [
      "a completed latest turn",
      { threadTurnStateById: { [threadId]: { latestTurn: turn("completed") } } },
    ],
    [
      "a pending source proposed plan",
      {
        threadTurnStateById: {
          [threadId]: { latestTurn: null, pendingSourceProposedPlan: { planId: "plan-1" } },
        },
      },
    ],
    ["nothing", {}],
  ])("is false for a shell whose records hold %s", (_name, records) => {
    const state = appState({
      threadShellById: { [threadId]: fullShell },
      ...(records as Partial<EnvironmentState>),
    });
    expect(isThreadNonIdle(state, ref)).toBe(false);
  });

  it("ignores session and turn records of a thread with no full shell", () => {
    const records = {
      threadSessionById: { [threadId]: session("running") } as never,
      threadTurnStateById: { [threadId]: { latestTurn: turn("running") } } as never,
    };
    expect(isThreadNonIdle(appState(records), ref)).toBe(false);
    expect(
      isThreadNonIdle(appState({ ...records, threadShellById: { [threadId]: stub } }), ref),
    ).toBe(false);
  });

  it("knows no pending work for an archived stub's summary", () => {
    const state = appState({
      threadShellById: { [threadId]: stub },
      sidebarThreadSummaryById: { [threadId]: stub },
    });
    expect(isThreadNonIdle(state, ref)).toBe(false);
  });

  it("answers the rule for every combination of its records", () => {
    // Work is in progress while the user is asked something mid-turn, a
    // session works, or the latest turn runs; nothing else keeps a thread busy.
    type Entry =
      | {
          readonly shellDetail?: string;
          readonly hasPendingApprovals?: boolean;
          readonly hasPendingUserInput?: boolean;
          readonly session?: { readonly orchestrationStatus: OrchestrationSessionStatus } | null;
          readonly orchestrationStatus?: OrchestrationSessionStatus;
          readonly latestTurn?: { readonly state: string } | null;
        }
      | null
      | undefined;
    const isFull = (entry: Entry) => entry != null && entry.shellDetail !== "archived-stub";
    const working = (status: OrchestrationSessionStatus | undefined) =>
      status === "starting" || status === "running";
    const referencePredicate = (
      summaryEntry: Entry,
      shellEntry: Entry,
      sessionRecord: Entry,
      turnState: Entry,
    ) => {
      if (
        isFull(summaryEntry) &&
        (summaryEntry?.hasPendingApprovals === true ||
          summaryEntry?.hasPendingUserInput === true ||
          working(summaryEntry?.session?.orchestrationStatus) ||
          summaryEntry?.latestTurn?.state === "running")
      ) {
        return true;
      }
      if (!isFull(shellEntry)) return false;
      return (
        working(sessionRecord?.orchestrationStatus) || turnState?.latestTurn?.state === "running"
      );
    };

    const statuses: OrchestrationSessionStatus[] = [
      "idle",
      "starting",
      "running",
      "ready",
      "interrupted",
      "stopped",
      "error",
    ];
    const summaries = [
      undefined,
      stub,
      summary(),
      summary({ hasPendingApprovals: true }),
      summary({ hasPendingUserInput: true }),
      summary({ hasActionableProposedPlan: true }),
      ...statuses.map((status) => summary({ session: session(status) })),
      summary({ session: session("ready"), latestTurn: turn("completed") }),
      summary({ latestTurn: turn("running") }),
      summary({ latestTurn: turn("completed") }),
    ];
    const shells = [undefined, stub, fullShell];
    const sessions = [undefined, null, ...statuses.map((status) => session(status))];
    const turnStates = [
      undefined,
      { latestTurn: null },
      { latestTurn: turn("running") },
      { latestTurn: turn("completed") },
      { latestTurn: null, pendingSourceProposedPlan: { planId: "plan-1" } },
    ];

    let combinations = 0;
    let nonIdle = 0;
    for (const sidebarSummary of summaries) {
      for (const shell of shells) {
        for (const sessionRecord of sessions) {
          for (const turnState of turnStates) {
            const state = appState({
              ...(sidebarSummary === undefined
                ? {}
                : { sidebarThreadSummaryById: { [threadId]: sidebarSummary } }),
              ...(shell === undefined ? {} : { threadShellById: { [threadId]: shell } }),
              ...(sessionRecord === undefined
                ? {}
                : { threadSessionById: { [threadId]: sessionRecord } as never }),
              ...(turnState === undefined
                ? {}
                : { threadTurnStateById: { [threadId]: turnState } as never }),
            });
            const expected = referencePredicate(sidebarSummary, shell, sessionRecord, turnState);
            expect(isThreadNonIdle(state, ref)).toBe(expected);
            combinations += 1;
            if (expected) nonIdle += 1;
          }
        }
      }
    }
    expect(combinations).toBe(16 * 3 * 9 * 5);
    // The matrix reaches both answers.
    expect(nonIdle).toBeGreaterThan(0);
    expect(nonIdle).toBeLessThan(combinations);
  });
});

/** A composer draft entry; the entry also holds per-thread settings, which are no content. */
function draft(overrides: Partial<ComposerDraftContent> = {}): ComposerDraftContent & {
  readonly interactionMode: "plan" | null;
} {
  return {
    prompt: "",
    images: [],
    persistedAttachments: [],
    terminalContexts: [],
    fileReferences: [],
    sourceControlContexts: [],
    interactionMode: "plan",
    ...overrides,
  };
}

describe("hasComposerDraftContent", () => {
  it.each([
    ["a prompt", { prompt: "hi" }],
    ["an image", { images: [{ id: "image-1" }] }],
    ["a persisted attachment", { persistedAttachments: [{ id: "attachment-1" }] }],
    ["a terminal context", { terminalContexts: [{ id: "context-1" }] }],
    ["a file reference", { fileReferences: [{ id: "reference-1" }] }],
    ["a source-control context", { sourceControlContexts: [{ id: "context-1" }] }],
  ])("is true for a draft with %s", (_name, overrides) => {
    expect(hasComposerDraftContent(draft(overrides))).toBe(true);
  });

  it("is false for a draft that holds only composer settings", () => {
    expect(hasComposerDraftContent(draft())).toBe(false);
  });
});

describe("hasUnsentThreadWork", () => {
  const key = `${environmentId}:${threadId}`;

  it("is true for a thread with a queued or in-flight send", () => {
    expect(
      hasUnsentThreadWork(ref, {
        queuesByThreadKey: { [key]: [{ id: "message-1" }] },
        draftsByThreadKey: {},
      }),
    ).toBe(true);
  });

  it("is true for a thread with unsent composer content", () => {
    expect(
      hasUnsentThreadWork(ref, {
        queuesByThreadKey: {},
        draftsByThreadKey: { [key]: draft({ prompt: "hi" }) },
      }),
    ).toBe(true);
    expect(
      hasUnsentThreadWork(ref, {
        queuesByThreadKey: {},
        draftsByThreadKey: { [key]: draft({ images: [{ id: "image-1" }] }) },
      }),
    ).toBe(true);
  });

  it("is false for a draft entry that holds only composer settings", () => {
    // A send clears the prompt and attachments but keeps the thread's model and modes.
    expect(
      hasUnsentThreadWork(ref, {
        queuesByThreadKey: {},
        draftsByThreadKey: { [key]: draft() },
      }),
    ).toBe(false);
  });

  it("is false for an empty queue, no draft, and other threads' work", () => {
    expect(
      hasUnsentThreadWork(ref, {
        queuesByThreadKey: { [key]: [], [`${environmentId}:thread-2`]: [{ id: "message-1" }] },
        draftsByThreadKey: { [`${environmentId}:thread-3`]: draft({ prompt: "hi" }) },
      }),
    ).toBe(false);
  });
});

describe("selectThreadBodyUsage", () => {
  /** A thread's message slice, from message texts by message id. */
  const slice = (texts: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(texts).map(([id, text]) => [
        id,
        { id: MessageId.make(id), role: "user", text, createdAt: "", streaming: false },
      ]),
    ) as EnvironmentState["messageByThreadId"][ThreadId];

  it("lists the threads that hold any body, across environments, with message-text sizes", () => {
    const state: AppState = {
      activeEnvironmentId: otherEnvironmentId,
      environmentStateById: {
        [environmentId]: {
          ...emptyEnvironment(),
          messageByThreadId: {
            [ThreadId.make("with-messages")]: slice({
              "message-1": "x".repeat(100),
              "message-2": "y".repeat(50),
            }),
          },
          activityByThreadId: { [ThreadId.make("with-activities")]: {} },
          proposedPlanByThreadId: { [ThreadId.make("with-plans")]: {} },
          turnDiffSummaryByThreadId: { [ThreadId.make("with-diffs")]: {} },
          pendingMessagesByThreadId: { [ThreadId.make("with-pending")]: [] },
          // A shell alone is no body.
          threadShellById: { [ThreadId.make("shell-only")]: fullShell },
        },
        [otherEnvironmentId]: {
          ...emptyEnvironment(),
          messageByThreadId: {
            [ThreadId.make("with-messages")]: slice({ "message-1": "z" }),
          },
        },
      },
    };

    const usage = selectThreadBodyUsage(state);
    const bytesOf = (envId: EnvironmentId, id: string) =>
      usage.find((entry) => entry.ref.environmentId === envId && entry.ref.threadId === id)?.bytes;

    expect(
      usage.map((entry) => `${entry.ref.environmentId}:${entry.ref.threadId}`).toSorted(),
    ).toEqual([
      "environment-other:with-messages",
      "environment-residency:with-activities",
      "environment-residency:with-diffs",
      "environment-residency:with-messages",
      "environment-residency:with-pending",
      "environment-residency:with-plans",
    ]);
    // Text plus a fixed overhead per message.
    expect(bytesOf(environmentId, "with-messages")).toBeGreaterThan(150);
    expect(bytesOf(environmentId, "with-messages")).toBeLessThan(150 + 2 * 1024);
    expect(bytesOf(environmentId, "with-activities")).toBe(0);
    expect(
      usage.filter((entry) => entry.environmentActive).map((entry) => entry.ref.environmentId),
    ).toEqual([otherEnvironmentId]);
  });

  it("reports which bodies hold messages that arrived before their shell", () => {
    const pending = slice({ "pending-message": "early" })["pending-message" as MessageId]!;
    const usage = selectThreadBodyUsage(
      appState({
        messageByThreadId: { [ThreadId.make("loaded")]: slice({ "message-1": "x" }) },
        pendingMessagesByThreadId: {
          [ThreadId.make("pending")]: [pending],
          [ThreadId.make("drained")]: [],
        },
      }),
    );
    const pendingOf = (id: string) =>
      usage.find((entry) => entry.ref.threadId === id)?.hasPendingMessages;

    expect(pendingOf("pending")).toBe(true);
    expect(pendingOf("drained")).toBe(false);
    expect(pendingOf("loaded")).toBe(false);
  });

  it("measures a message slice again once the store replaces it", () => {
    const small = slice({ "message-1": "x" });
    const first = selectThreadBodyUsage(appState({ messageByThreadId: { [threadId]: small } }));
    const sameSlice = selectThreadBodyUsage(appState({ messageByThreadId: { [threadId]: small } }));
    const grown = selectThreadBodyUsage(
      appState({
        messageByThreadId: {
          [threadId]: slice({ "message-1": "x".repeat(10_000) }),
        },
      }),
    );

    expect(sameSlice[0]!.bytes).toBe(first[0]!.bytes);
    expect(grown[0]!.bytes).toBeGreaterThan(first[0]!.bytes + 9_000);
  });

  it("reports when a thread last saw activity, from its update or latest user message", () => {
    const at = (iso: string) => Date.parse(iso);
    const usage = selectThreadBodyUsage(
      appState({
        messageByThreadId: {
          [ThreadId.make("updated")]: slice({ "message-1": "x" }),
          [ThreadId.make("messaged")]: slice({ "message-1": "x" }),
          [ThreadId.make("stub")]: slice({ "message-1": "x" }),
          [ThreadId.make("no-summary")]: slice({ "message-1": "x" }),
          [ThreadId.make("unreadable")]: slice({ "message-1": "x" }),
        },
        sidebarThreadSummaryById: {
          [ThreadId.make("updated")]: summary({
            updatedAt: "2026-10-02T10:00:00.000Z",
            latestUserMessageAt: "2026-10-01T10:00:00.000Z",
          }),
          [ThreadId.make("messaged")]: summary({
            updatedAt: undefined,
            latestUserMessageAt: "2026-10-03T10:00:00.000Z",
          }),
          [ThreadId.make("stub")]: {
            shellDetail: "archived-stub",
            id: ThreadId.make("stub"),
            projectId,
            updatedAt: "2026-10-04T10:00:00.000Z",
            latestUserMessageAt: null,
          } as never,
          [ThreadId.make("unreadable")]: summary({
            updatedAt: "not a date",
            latestUserMessageAt: null,
          }),
        },
      }),
    );
    const activityOf = (id: string) =>
      usage.find((entry) => entry.ref.threadId === id)?.lastActivityAt;

    expect(activityOf("updated")).toBe(at("2026-10-02T10:00:00.000Z"));
    expect(activityOf("messaged")).toBe(at("2026-10-03T10:00:00.000Z"));
    expect(activityOf("stub")).toBe(at("2026-10-04T10:00:00.000Z"));
    expect(activityOf("no-summary")).toBe(0);
    expect(activityOf("unreadable")).toBe(0);
  });
});

describe("planThreadBodyResidency", () => {
  const now = Date.UTC(2026, 9, 1);
  const refOf = (id: string) => scopeThreadRef(environmentId, ThreadId.make(id));
  const entry = (
    id: string,
    lastAccessedAt: number,
    overrides: Partial<ThreadBodyResidencyEntry> = {},
  ): ThreadBodyResidencyEntry => ({
    ref: refOf(id),
    bytes: 1,
    lastAccessedAt,
    protected: false,
    ...overrides,
  });
  const idsOf = (refs: ReadonlyArray<{ readonly threadId: string }>) =>
    refs.map((planned) => planned.threadId);
  const plan = (input: Omit<Parameters<typeof planThreadBodyResidency>[0], "now">) =>
    planThreadBodyResidency({ now, ...input });

  it("plans nothing within both limits", () => {
    expect(plan({ entries: [entry("a", 1), entry("b", 2)], maxThreads: 2, maxBytes: 2 })).toEqual({
      evict: [],
      overBudget: false,
      recheckAt: null,
    });
  });

  it("drops the least recently accessed threads past the thread limit, oldest first", () => {
    const { evict } = plan({
      entries: [entry("c", 30), entry("a", 10), entry("e", 50), entry("b", 20), entry("d", 40)],
      maxThreads: 3,
      maxBytes: 100,
    });
    expect(idsOf(evict)).toEqual(["a", "b"]);
  });

  it("never plans a protected thread, but counts it toward the limits", () => {
    const { evict } = plan({
      entries: [
        entry("oldest-protected", 1, { protected: true }),
        entry("a", 2),
        entry("b", 3),
        entry("c", 4),
      ],
      maxThreads: 2,
      maxBytes: 100,
    });
    expect(idsOf(evict)).toEqual(["a", "b"]);
  });

  it("leaves the limits exceeded while everything left is protected", () => {
    const result = plan({
      entries: [
        entry("a", 1, { protected: true }),
        entry("b", 2, { protected: true }),
        entry("c", 3),
      ],
      maxThreads: 1,
      maxBytes: 100,
    });
    expect(idsOf(result.evict)).toEqual(["c"]);
    expect(result.overBudget).toBe(true);
    // Nothing kept is waiting for its recency to lapse.
    expect(result.recheckAt).toBeNull();
  });

  it("keeps a thread until its protection expires, and plans it once it has", () => {
    const entries = [
      entry("recent", 1, { protectedUntil: now + 10 }),
      entry("a", 2),
      entry("b", 3),
    ];
    expect(idsOf(plan({ entries, maxThreads: 2, maxBytes: 100 }).evict)).toEqual(["a"]);
    // Protection ends at the instant it names.
    expect(
      idsOf(
        planThreadBodyResidency({ entries, now: now + 10, maxThreads: 2, maxBytes: 100 }).evict,
      ),
    ).toEqual(["recent"]);
    // `protected` holds whatever the expiry says.
    expect(
      idsOf(
        planThreadBodyResidency({
          entries: [
            entry("pinned", 1, { protected: true, protectedUntil: now - 1 }),
            entry("a", 2),
          ],
          now,
          maxThreads: 1,
          maxBytes: 100,
        }).evict,
      ),
    ).toEqual(["a"]);
  });

  it("re-checks at the earliest expiry while the store stays over a limit", () => {
    const result = plan({
      entries: [
        entry("later", 1, { protectedUntil: now + 30 }),
        entry("sooner", 2, { protectedUntil: now + 20 }),
        entry("expired", 3, { protectedUntil: now }),
        entry("pinned", 4, { protected: true, protectedUntil: now + 5 }),
      ],
      maxThreads: 1,
      maxBytes: 100,
    });
    expect(idsOf(result.evict)).toEqual(["expired"]);
    expect(result.overBudget).toBe(true);
    // A protected thread's expiry frees nothing, so it schedules nothing.
    expect(result.recheckAt).toBe(now + 20);
  });

  it("schedules no re-check once the plan brings the store within its limits", () => {
    const result = plan({
      entries: [entry("recent", 5, { protectedUntil: now + 20 }), entry("a", 1), entry("b", 2)],
      maxThreads: 2,
      maxBytes: 100,
    });
    expect(idsOf(result.evict)).toEqual(["a"]);
    expect(result.overBudget).toBe(false);
    expect(result.recheckAt).toBeNull();
  });

  it("drops threads past the byte limit even within the thread limit, and stops once both hold", () => {
    const { evict } = plan({
      entries: [
        entry("a", 1, { bytes: 40 }),
        entry("b", 2, { bytes: 40 }),
        entry("c", 3, { bytes: 40 }),
      ],
      maxThreads: 10,
      maxBytes: 100,
    });
    expect(idsOf(evict)).toEqual(["a"]);
  });

  it("counts a protected thread's bytes toward the byte limit", () => {
    const { evict } = plan({
      entries: [
        entry("hot", 9, { bytes: 90, protected: true }),
        entry("a", 1, { bytes: 8 }),
        entry("b", 2, { bytes: 8 }),
      ],
      maxThreads: 10,
      maxBytes: 100,
    });
    expect(idsOf(evict)).toEqual(["a"]);
  });

  it("re-checks a store over its byte limit only because of recent bodies", () => {
    const result = plan({
      entries: [
        entry("recent-a", 1, { bytes: 60, protectedUntil: now + 40 }),
        entry("recent-b", 2, { bytes: 60, protectedUntil: now + 50 }),
      ],
      maxThreads: 10,
      maxBytes: 100,
    });
    expect(result.evict).toEqual([]);
    expect(result.overBudget).toBe(true);
    expect(result.recheckAt).toBe(now + 40);
  });

  it("drops the less recently active thread first among equal access times", () => {
    const { evict } = plan({
      entries: [
        entry("quiet-a", 0, { lastActivityAt: 30 }),
        entry("busy", 0, { lastActivityAt: 90 }),
        entry("quiet-b", 0, { lastActivityAt: 10 }),
        entry("unknown", 0),
        entry("accessed", 5, { lastActivityAt: 1 }),
      ],
      maxThreads: 2,
      maxBytes: 100,
    });
    // Access time ranks first; activity only orders what is accessed equally.
    expect(idsOf(evict)).toEqual(["unknown", "quiet-b", "quiet-a"]);
  });

  it("defaults to 64 threads and 48 MiB", () => {
    expect(THREAD_BODY_MAX_THREADS).toBe(64);
    expect(THREAD_BODY_MAX_BYTES).toBe(48 * 1024 * 1024);

    const seventy = Array.from({ length: 70 }, (_, index) => entry(`thread-${index}`, index));
    expect(idsOf(plan({ entries: seventy }).evict)).toEqual(
      Array.from({ length: 6 }, (_, index) => `thread-${index}`),
    );

    const heavy = [
      entry("old", 1, { bytes: 30 * 1024 * 1024 }),
      entry("new", 2, { bytes: 30 * 1024 * 1024 }),
    ];
    expect(idsOf(plan({ entries: heavy }).evict)).toEqual(["old"]);
  });
});
