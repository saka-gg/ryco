import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createThreadNotificationProjector } from "./threadNotifications.ts";
import type { SidebarThreadSummary } from "./types.ts";

const environmentId = EnvironmentId.make("one");
const nowMs = Date.parse("2026-10-02T12:00:00.000Z");
function thread(patch: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread"),
    environmentId,
    projectId: ProjectId.make("project"),
    title: "A thread",
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-02T10:00:00.000Z",
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make("turn"),
      state: "running",
      requestedAt: "2026-10-02T10:00:00.000Z",
      startedAt: "2026-10-02T10:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...patch,
  };
}
function completed(patch: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return thread({
    latestTurn: {
      ...thread().latestTurn!,
      state: "completed",
      completedAt: "2026-10-02T11:00:00.000Z",
    },
    ...patch,
  });
}
function fixture(initial: SidebarThreadSummary = thread()) {
  const generation = {};
  let current: object | null = generation;
  const projector = createThreadNotificationProjector({ readGeneration: () => current });
  projector.baseline({ environmentId, generation, sequence: 1, threads: [initial], nowMs });
  return {
    projector,
    generation,
    replace: (next: object | null) => {
      current = next;
    },
    observe: (next: SidebarThreadSummary, sequence: number) =>
      projector.observe({ generation, sequence, thread: next, nowMs }),
  };
}

describe("thread notification projection", () => {
  it("accepts distinct thread changes in one envelope while rejecting duplicate rows and older envelopes", () => {
    const test = fixture();
    const secondId = ThreadId.make("second-thread");
    test.projector.baseline({
      environmentId,
      generation: test.generation,
      sequence: 1,
      threads: [thread(), thread({ id: secondId })],
      nowMs,
    });
    const first = test.observe(completed(), 2)!;
    const second = test.observe(completed({ id: secondId }), 2)!;
    expect(first.kind).toBe("completed");
    expect(second.kind).toBe("completed");
    expect(test.observe(thread({ id: secondId, hasPendingApprovals: true }), 2)).toBeNull();
    expect(test.projector.isCurrent(second)).toBe(true);
    test.observe(thread({ hasPendingApprovals: true }), 3);
    expect(test.observe(thread({ id: secondId, hasPendingApprovals: true }), 2)).toBeNull();
    test.projector.remove({
      environmentId,
      generation: test.generation,
      sequence: 3,
      threadId: secondId,
    });
    expect(test.projector.isCurrent(second)).toBe(false);
    // A duplicate upsert cannot resurrect a row removed by the same envelope.
    expect(test.observe(completed({ id: secondId }), 3)).toBeNull();
    expect(test.projector.isCurrent(second)).toBe(false);
  });
  it("emits one grouped completion and suppresses repeated terminal projections", () => {
    const test = fixture();
    const event = test.observe(completed(), 2)!;
    expect(event.kind).toBe("completed");
    expect(event.ref).toEqual({ environmentId, threadId: thread().id });
    expect(event.groupKey).toBe("one:thread");
    expect(Object.isFrozen(event)).toBe(true);
    expect(test.observe(completed({ title: "Renamed" }), 3)).toBeNull();
    expect(test.projector.isCurrent(event)).toBe(true);
  });

  it("baseline and reconnect never replay historical completion", () => {
    const test = fixture(completed());
    expect(test.observe(completed(), 2)).toBeNull();
    const next = {};
    test.replace(next);
    test.projector.baseline({
      environmentId,
      generation: next,
      sequence: 0,
      threads: [completed()],
      nowMs,
    });
    expect(
      test.projector.observe({ generation: next, sequence: 1, thread: completed(), nowMs }),
    ).toBeNull();
  });

  it("rejects stale generations at observation and again before queued delivery", () => {
    const test = fixture();
    const event = test.observe(completed(), 2)!;
    test.replace({});
    expect(test.observe(thread({ hasPendingApprovals: true }), 3)).toBeNull();
    expect(test.projector.isCurrent(event)).toBe(false);
  });

  it("ignores unbaselined streams, foreign threads, and old sequences", () => {
    const test = fixture();
    expect(test.observe(completed(), 1)).toBeNull();
    expect(test.observe(completed({ environmentId: EnvironmentId.make("two") }), 2)).toBeNull();
    test.projector.clear(environmentId);
    expect(test.observe(completed(), 3)).toBeNull();
  });

  it("uses shared attention precedence over a still-running turn and clears resolved alerts", () => {
    const test = fixture();
    const approval = test.observe(
      thread({ hasPendingApprovals: true, hasPendingUserInput: true }),
      2,
    )!;
    expect(approval.kind).toBe("approval");
    expect(test.observe(thread({ hasPendingUserInput: true }), 3)?.kind).toBe("input");
    expect(test.projector.isCurrent(approval)).toBe(false);
    expect(test.observe(thread(), 4)).toBeNull();
  });

  it("does not re-notify a completed turn after an approval resolves", () => {
    const test = fixture();
    expect(test.observe(completed(), 2)?.kind).toBe("completed");
    expect(test.observe(completed({ hasPendingApprovals: true }), 3)?.kind).toBe("approval");
    expect(test.observe(completed(), 4)).toBeNull();
  });

  it("waits for background work before notifying completion and reports terminal errors", () => {
    const test = fixture();
    expect(test.observe(completed({ backgroundLiveness: "working" }), 2)).toBeNull();
    expect(test.observe(completed(), 3)?.kind).toBe("completed");
    const failed = completed({
      latestTurn: {
        ...completed().latestTurn!,
        turnId: TurnId.make("failed-turn"),
        state: "error",
      },
    });
    expect(test.observe(failed, 4)?.kind).toBe("failed");
  });

  it("suppresses archival and already-snoozed history, with shared wake rules for new requests", () => {
    const test = fixture();
    expect(test.observe(completed({ archivedAt: "2026-10-02T11:30:00.000Z" }), 2)).toBeNull();
    const snoozed = completed({
      snoozedAt: "2026-10-02T11:30:00.000Z",
      snoozedUntil: "2026-10-02T13:00:00.000Z",
    });
    expect(test.observe(snoozed, 3)).toBeNull();
    expect(test.observe({ ...snoozed, hasPendingUserInput: true }, 4)?.kind).toBe("input");
  });

  it("groups identical thread ids independently across environments", () => {
    const test = fixture();
    const second = EnvironmentId.make("two");
    test.projector.baseline({
      environmentId: second,
      generation: test.generation,
      sequence: 1,
      threads: [thread({ environmentId: second })],
      nowMs,
    });
    const firstEvent = test.observe(completed(), 2)!;
    const secondEvent = test.observe(completed({ environmentId: second }), 2)!;
    expect(secondEvent.groupKey).not.toBe(firstEvent.groupKey);
    expect(secondEvent.id).not.toBe(firstEvent.id);
  });

  it("removes thread baselines and invalidates pending delivery", () => {
    const test = fixture();
    const event = test.observe(completed(), 2)!;
    test.projector.remove({
      environmentId,
      generation: test.generation,
      sequence: 3,
      threadId: thread().id,
    });
    expect(test.projector.isCurrent(event)).toBe(false);
    expect(test.observe(completed(), 4)).toBeNull();
  });

  it("invalidates an older alert when the same request kind returns later", () => {
    const test = fixture();
    const first = test.observe(thread({ hasPendingApprovals: true }), 2)!;
    test.observe(thread(), 3);
    const second = test.observe(thread({ hasPendingApprovals: true }), 4)!;
    expect(test.projector.isCurrent(first)).toBe(false);
    expect(test.projector.isCurrent(second)).toBe(true);
    test.projector.baseline({
      environmentId,
      generation: test.generation,
      sequence: 4,
      threads: [thread({ hasPendingApprovals: true })],
      nowMs,
    });
    expect(test.projector.isCurrent(second)).toBe(false);
  });

  it("announces a ready plan without also announcing the same completion", () => {
    const test = fixture(thread({ interactionMode: "plan" }));
    expect(
      test.observe(completed({ interactionMode: "plan", hasActionableProposedPlan: true }), 2)
        ?.kind,
    ).toBe("plan-ready");
    expect(
      test.observe(completed({ interactionMode: "plan", hasActionableProposedPlan: true }), 3),
    ).toBeNull();
    expect(test.observe(completed({ interactionMode: "plan" }), 4)).toBeNull();
  });
});
