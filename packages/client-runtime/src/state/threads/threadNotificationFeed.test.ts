import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationArchivedThreadStub,
  type OrchestrationLatestTurn,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadShell,
  type ThreadLineage,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentConnection } from "../../connection/connection.ts";
import type { ShellAcceptance } from "../../connection/supervision.ts";
import {
  applyShellEvent,
  selectEnvironmentState,
  syncServerShellSnapshot,
  type AppState,
} from "./store.ts";
import {
  startThreadNotificationFeed,
  type ThreadNotificationCandidate,
  type ThreadNotificationSource,
} from "./threadNotificationFeed.ts";

const env = EnvironmentId.make("environment-feed");
const projectId = ProjectId.make("project-feed");
const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-20T11:00:00.000Z";
const nowMs = Date.parse("2026-10-20T12:00:00.000Z");

function turn(state: OrchestrationLatestTurn["state"], turnId = "turn-1"): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(turnId),
    state,
    requestedAt: T0,
    startedAt: T0,
    completedAt: state === "running" ? null : T1,
    assistantMessageId: null,
  };
}

function shell(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: turn("running"),
    goal: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: T0,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const upsert = (
  sequence: number,
  thread: OrchestrationThreadShell,
): OrchestrationShellStreamEvent =>
  ({ kind: "thread-upserted", sequence, thread }) as OrchestrationShellStreamEvent;

/**
 * One environment's connection as the supervisor and connection.ts present
 * it: buffered shell events commit on a flush and are then reported, and the
 * readiness token is published after the snapshot it vouches for.
 */
function harness() {
  let state: AppState = { activeEnvironmentId: null, environmentStateById: {} };
  let sequence: number | null = null;
  let buffered: OrchestrationShellStreamEvent[] = [];
  let token: object | null = null;
  let registered: EnvironmentConnection | null = null;
  const readinessListeners = new Set<() => void>();
  const registryListeners = new Set<() => void>();
  const acceptanceListeners = new Set<(acceptance: ShellAcceptance) => void>();
  const connection = {
    environmentId: env,
    shellSnapshotReadiness: {
      read: () => token,
      subscribe: (listener: () => void) => {
        readinessListeners.add(listener);
        return () => readinessListeners.delete(listener);
      },
    },
  } as unknown as EnvironmentConnection;
  const accept = (acceptance: ShellAcceptance) => {
    for (const listener of Array.from(acceptanceListeners)) listener(acceptance);
  };
  const notifyReadiness = () => {
    for (const listener of Array.from(readinessListeners)) listener();
  };
  const notifyRegistry = () => {
    for (const listener of Array.from(registryListeners)) listener();
  };
  const flush = () => {
    const events = buffered.filter((event) => sequence === null || event.sequence > sequence);
    buffered = [];
    if (events.length === 0) return;
    for (const event of events) state = applyShellEvent(state, event, env);
    sequence = events.at(-1)!.sequence;
    accept({ kind: "events", environmentId: env, events });
  };
  const source: ThreadNotificationSource = {
    subscribe: (listener) => {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
    list: () => (registered === null ? [] : [registered]),
    read: (environmentId) => (environmentId === env ? registered : null),
    readShellProjectionSequence: () => {
      flush();
      return sequence;
    },
    subscribeShellAcceptance: (listener) => {
      acceptanceListeners.add(listener);
      return () => acceptanceListeners.delete(listener);
    },
  };
  const delivered: ThreadNotificationCandidate[] = [];
  const startFeed = () =>
    startThreadNotificationFeed({
      source,
      readEnvironmentThreads: (environmentId) =>
        Object.values(selectEnvironmentState(state, environmentId).sidebarThreadSummaryById),
      now: () => nowMs,
      onCandidate: (candidate) => delivered.push(candidate),
    });
  /** Writes rows the way the read cache does: into the store, past the supervisor. */
  const writeUnaccepted = (threads: ReadonlyArray<OrchestrationThreadShell>) => {
    state = syncServerShellSnapshot(
      state,
      { snapshotSequence: 99, projects: [], threads, updatedAt: T1 },
      env,
    );
  };
  const applySnapshot = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    snapshotSequence: number,
    archivedThreadStubs: ReadonlyArray<OrchestrationArchivedThreadStub> = [],
  ) => {
    flush();
    state = syncServerShellSnapshot(
      state,
      { snapshotSequence, projects: [], threads, archivedThreadStubs, updatedAt: T0 },
      env,
    );
    sequence = snapshotSequence;
    accept({ kind: "snapshot", environmentId: env });
  };
  return {
    startFeed,
    applySnapshot,
    writeUnaccepted,
    flush,
    register: () => {
      registered = connection;
      notifyRegistry();
    },
    remove: () => {
      flush();
      registered = null;
      sequence = null;
      notifyRegistry();
    },
    /** A socket drop or resubscribe: the attempt's token is gone. */
    invalidate: () => {
      token = null;
      notifyReadiness();
    },
    /** A new attempt's snapshot or resume is current. */
    publish: () => {
      token = {};
      notifyReadiness();
    },
    /** A new socket attempt: its snapshot applies, then its token is published. */
    connect: (
      threads: ReadonlyArray<OrchestrationThreadShell>,
      snapshotSequence: number,
      archivedThreadStubs?: ReadonlyArray<OrchestrationArchivedThreadStub>,
    ) => {
      token = null;
      notifyReadiness();
      applySnapshot(threads, snapshotSequence, archivedThreadStubs);
      token = {};
      notifyReadiness();
    },
    enqueue: (...events: ReadonlyArray<OrchestrationShellStreamEvent>) => {
      buffered.push(...events);
    },
    /** What reached `onCandidate` once the current task's work is done. */
    settle: async () => {
      await Promise.resolve();
      return delivered.splice(0);
    },
  };
}

describe("thread notification feed", () => {
  it("baselines a current shell silently, then alerts once when a thread finishes", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a", { latestTurn: turn("completed", "turn-0") })], 10);
    test.startFeed();
    expect(await test.settle()).toEqual([]);

    test.enqueue(upsert(11, shell("a")), upsert(12, shell("a", { latestTurn: turn("completed") })));
    test.flush();
    const [candidate, ...rest] = await test.settle();
    expect(rest).toEqual([]);
    expect(candidate?.event.kind).toBe("completed");
    expect(candidate?.event.ref).toEqual({ environmentId: env, threadId: ThreadId.make("a") });
    expect(candidate?.delegated).toBe(false);

    test.enqueue(upsert(13, shell("a", { latestTurn: turn("completed"), title: "Renamed" })));
    test.flush();
    expect(await test.settle()).toEqual([]);
  });

  it("baselines a connection that registers after the feed started once its shell is current", async () => {
    const test = harness();
    test.startFeed();
    test.register();
    test.connect([shell("a", { latestTurn: turn("completed") })], 10);
    test.enqueue(upsert(11, shell("a", { latestTurn: turn("completed"), title: "Renamed" })));
    test.flush();
    expect(await test.settle()).toEqual([]);

    test.enqueue(upsert(12, shell("a", { hasPendingApprovals: true })));
    test.flush();
    expect((await test.settle()).map((candidate) => candidate.event.kind)).toEqual(["approval"]);
  });

  it("alerts for a thread created and asking for approval within one batch", async () => {
    const test = harness();
    test.register();
    test.connect([], 10);
    test.startFeed();

    test.enqueue(
      upsert(11, shell("child", { latestTurn: null })),
      upsert(12, shell("child", { hasPendingApprovals: true })),
    );
    test.flush();
    expect((await test.settle()).map((candidate) => candidate.event.kind)).toEqual(["approval"]);
  });

  it("observes nothing without a current shell token", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a")], 10);
    test.startFeed();
    test.invalidate();

    test.enqueue(upsert(11, shell("a", { latestTurn: turn("completed") })));
    test.flush();
    expect(await test.settle()).toEqual([]);
  });

  it("drops queued alerts when a new attempt replaces the shell, and stays silent about its snapshot", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a"), shell("b")], 10);
    const feed = test.startFeed();

    test.enqueue(upsert(11, shell("a", { latestTurn: turn("completed") })));
    test.flush();
    const [delivered] = await test.settle();
    expect(delivered?.event.kind).toBe("completed");

    test.enqueue(upsert(12, shell("b", { hasPendingUserInput: true })));
    test.flush();
    // Reconnected before the alert went out: the new attempt's snapshot shows
    // b finished, which is history, not news.
    test.connect(
      [
        shell("a", { latestTurn: turn("completed") }),
        shell("b", { latestTurn: turn("completed") }),
      ],
      20,
    );
    expect(await test.settle()).toEqual([]);
    expect(feed.isCurrent(delivered!.event)).toBe(false);
  });

  it("baselines a resumed stream on the shell it holds, applying buffered events first", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a"), shell("b")], 10);
    test.startFeed();

    // Buffered when the socket dropped; it lands with the resume's baseline.
    test.enqueue(upsert(11, shell("a", { latestTurn: turn("completed") })));
    test.invalidate();
    test.publish();
    expect(await test.settle()).toEqual([]);

    test.enqueue(
      upsert(12, shell("a", { latestTurn: turn("completed"), title: "Renamed" })),
      upsert(13, shell("b", { hasPendingApprovals: true })),
    );
    test.flush();
    expect((await test.settle()).map((candidate) => candidate.event.ref.threadId)).toEqual([
      ThreadId.make("b"),
    ]);
  });

  it("rebaselines silently on a snapshot within the same attempt", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a")], 10);
    test.startFeed();

    test.applySnapshot([shell("a", { latestTurn: turn("completed") })], 11);
    test.enqueue(upsert(12, shell("a", { latestTurn: turn("completed"), title: "Renamed" })));
    test.flush();
    expect(await test.settle()).toEqual([]);
  });

  it("leaves an archived stub unbaselined, so its first full shell is silent", async () => {
    const test = harness();
    test.register();
    test.connect([], 10, [
      {
        id: ThreadId.make("archived"),
        projectId,
        title: "Archived",
        branch: null,
        worktreePath: null,
        createdAt: T0,
        updatedAt: T0,
        archivedAt: T0,
        latestUserMessageAt: T0,
      },
    ]);
    test.startFeed();

    test.enqueue(upsert(11, shell("archived", { latestTurn: turn("completed") })));
    test.flush();
    expect(await test.settle()).toEqual([]);

    test.enqueue(
      upsert(12, shell("archived", { latestTurn: turn("running", "turn-2") })),
      upsert(13, shell("archived", { latestTurn: turn("completed", "turn-2") })),
    );
    test.flush();
    expect((await test.settle()).map((candidate) => candidate.event.kind)).toEqual(["completed"]);
  });

  it("drops an alert whose thread is removed in the same batch", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a")], 10);
    test.startFeed();

    test.enqueue(upsert(11, shell("a", { latestTurn: turn("completed") })), {
      kind: "thread-removed",
      sequence: 12,
      threadId: ThreadId.make("a"),
    } as OrchestrationShellStreamEvent);
    test.flush();
    expect(await test.settle()).toEqual([]);
  });

  it("forgets an environment whose connection goes away", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a")], 10);
    const feed = test.startFeed();
    test.enqueue(upsert(11, shell("a", { latestTurn: turn("completed") })));
    test.flush();
    const [delivered] = await test.settle();

    test.remove();
    // Even were the same token to come back, nothing of the old shell is kept.
    test.register();
    expect(feed.isCurrent(delivered!.event)).toBe(false);
  });

  it("never alerts for rows that reach the store past the supervisor", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a")], 10);
    test.startFeed();

    // A hosted fence drops a stale generation's items before the supervisor,
    // and the read cache writes the store directly: neither is accepted.
    test.writeUnaccepted([shell("a", { latestTurn: turn("completed") })]);
    test.publish();
    expect(await test.settle()).toEqual([]);
  });

  it("marks delegated threads", async () => {
    const test = harness();
    test.register();
    test.connect([shell("child")], 10);
    test.startFeed();
    const lineage: ThreadLineage = {
      parentThreadId: ThreadId.make("parent"),
      rootThreadId: ThreadId.make("parent"),
      relationship: "delegated",
    };

    test.enqueue(upsert(11, shell("child", { lineage, hasPendingUserInput: true })));
    test.flush();
    expect((await test.settle()).map((candidate) => candidate.delegated)).toEqual([true]);
  });

  it("delivers nothing more once stopped", async () => {
    const test = harness();
    test.register();
    test.connect([shell("a"), shell("b")], 10);
    const feed = test.startFeed();
    test.enqueue(upsert(11, shell("a", { latestTurn: turn("completed") })));
    test.flush();
    const [delivered] = await test.settle();

    test.enqueue(upsert(12, shell("b", { latestTurn: turn("completed") })));
    test.flush();
    feed.stop();
    expect(await test.settle()).toEqual([]);
    expect(feed.isCurrent(delivered!.event)).toBe(false);

    test.enqueue(upsert(13, shell("b", { hasPendingApprovals: true })));
    test.flush();
    expect(await test.settle()).toEqual([]);
  });
});
