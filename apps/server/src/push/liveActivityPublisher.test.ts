import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import type { PushActivityEntryStatus, PushActivitySignalInput } from "@ryco/contracts/push-hub";
import { e2eeX25519KeyPair } from "@ryco/shared/relayE2eeKeys";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ATTENTION_COALESCE_MS,
  ATTENTION_READ_DEBOUNCE_MS,
  ATTENTION_UNSUPPORTED_BACKOFF_MS,
  type ActivitySendOutcome,
  startAttentionPublisher,
} from "./attentionPublisher.ts";
import {
  ACTIVITY_FOREGROUND_RECHECK_MS,
  ACTIVITY_MIN_INTERVAL_MS,
  ACTIVITY_REFRESH_MS,
  countNodeAgentActivity,
  planActivityRecipients,
} from "./liveActivityCounts.ts";
import type { PushRegistration } from "./pushRegistrations.ts";

const HUB_ENVIRONMENT = EnvironmentId.make("env_hubEnvironment000000");
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const PHONE = "enr_phone000000000000000000";
const TABLET = "enr_tablet00000000000000000";
const deviceKey = e2eeX25519KeyPair();

function thread(id: string, patch: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: HUB_ENVIRONMENT,
    projectId: ProjectId.make("project"),
    title: `Secret title ${id}`,
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T11:59:00.000Z",
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "running",
      requestedAt: "2026-10-28T11:58:00.000Z",
      startedAt: "2026-10-28T11:58:00.000Z",
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

const finished = (id: string, completedAt: string, patch: Partial<SidebarThreadSummary> = {}) =>
  thread(id, {
    latestTurn: { ...thread(id).latestTurn!, state: "completed", completedAt },
    ...patch,
  });

function registration(enrollmentId: string, patch: Partial<PushRegistration> = {}) {
  return {
    enrollmentId,
    keyId: "AAAAAAAAAAAAAAAAAAAAAA",
    publicKey: Buffer.from(deviceKey.publicKey).toString("base64url"),
    role: "owner",
    kinds: ["approval"],
    sound: true,
    liveActivity: true,
    collapseSalt: "s".repeat(43),
    createdAt: 0,
    refreshedAt: 0,
    ...patch,
  } satisfies PushRegistration;
}

const count = (threads: ReadonlyArray<SidebarThreadSummary>, nowMs = NOW) =>
  countNodeAgentActivity({
    environmentId: HUB_ENVIRONMENT,
    threads,
    worktrees: [],
    autoSettleAfterDays: undefined,
    nowMs,
  });

describe("countNodeAgentActivity", () => {
  it("counts running, waiting and recent results by the card's rule", () => {
    const result = count([
      thread("a"),
      thread("b", { hasPendingApprovals: true }),
      finished("c", "2026-10-28T11:55:00.000Z"),
      finished("d", "2026-10-28T11:30:00.000Z"),
    ]);
    // d ended 30 minutes ago: past the 15-minute result window.
    expect(result.counts).toEqual({ running: 1, needsYou: 1, failed: 0, done: 1 });
    // c ages out 15 minutes after it ended.
    expect(result.nextChangeAtMs).toBe(Date.parse("2026-10-28T12:10:00.000Z") + 1);
  });

  it("never counts settled, snoozed, archived or rows read under another id", () => {
    const result = count([
      finished("a", "2026-10-28T11:58:00.000Z", {
        settledOverride: "settled",
        settledAt: "2026-10-28T11:59:00.000Z",
      }),
      finished("b", "2026-10-28T11:58:00.000Z", {
        snoozedAt: "2026-10-28T11:59:00.000Z",
        snoozedUntil: "2026-10-28T13:00:00.000Z",
      }),
      thread("c", { archivedAt: "2026-10-28T11:00:00.000Z" }),
      // The shell's rows carry no environment id; they are this node's all the same.
      thread("d", { environmentId: "" as EnvironmentId }),
    ]);
    expect(result.counts).toEqual({ running: 1, needsYou: 0, failed: 0, done: 0 });
    // Nothing counted ages out; the snooze wakes at 13:00.
    expect(result.nextChangeAtMs).toBe(Date.parse("2026-10-28T13:00:00.000Z"));
  });
});

describe("planActivityRecipients", () => {
  const counts = { running: 1, needsYou: 0, failed: 0, done: 0 };
  const zero = { running: 0, needsYou: 0, failed: 0, done: 0 };
  const plan = (input: Partial<Parameters<typeof planActivityRecipients>[0]>) =>
    planActivityRecipients({
      registrations: [registration(PHONE)],
      isForeground: () => false,
      sent: new Map(),
      counts,
      nowMs: NOW,
      ...input,
    }).flat();

  it("signals only the devices not in front", () => {
    expect(
      plan({
        registrations: [registration(PHONE), registration(TABLET)],
        isForeground: (id) => id === TABLET,
      }),
    ).toEqual([PHONE]);
  });

  it("sends changes, ends once, refreshes held counts, and tells a new device even zero", () => {
    const sent = (patch: object) =>
      new Map([[PHONE, { counts, atMs: NOW, held: true, resend: false, ...patch }]]);
    expect(plan({ sent: sent({}) })).toEqual([]);
    expect(plan({ sent: sent({}), counts: zero })).toEqual([PHONE]);
    expect(plan({ sent: sent({ counts: zero }), counts: zero })).toEqual([]);
    // Told nothing since this node started: it hears its counts once, zero included, so a Hub
    // still holding what the node sent before a restart can end the card.
    expect(plan({ counts: zero })).toEqual([PHONE]);
    expect(plan({ sent: sent({ resend: true }) })).toEqual([PHONE]);
    expect(plan({ sent: sent({}), nowMs: NOW + ACTIVITY_REFRESH_MS })).toEqual([PHONE]);
    // A pass on the refresh timer a little early still refreshes.
    expect(
      plan({ sent: sent({}), nowMs: NOW + ACTIVITY_REFRESH_MS - ACTIVITY_MIN_INTERVAL_MS }),
    ).toEqual([PHONE]);
    expect(plan({ sent: sent({}), nowMs: NOW + ACTIVITY_REFRESH_MS / 2 })).toEqual([]);
    // Zero counts the Hub took are never refreshed.
    expect(
      plan({ sent: sent({ counts: zero }), counts: zero, nowMs: NOW + ACTIVITY_REFRESH_MS }),
    ).toEqual([]);
    // Nothing held (no card took pushes): unchanged counts are not refreshed.
    expect(plan({ sent: sent({ held: false }), nowMs: NOW + ACTIVITY_REFRESH_MS })).toEqual([]);
  });

  it("splits more than 32 devices over several signals", () => {
    const registrations = Array.from({ length: 40 }, (_, index) =>
      registration(`enr_device${String(index).padStart(17, "0")}`),
    );
    const chunks = planActivityRecipients({
      registrations,
      isForeground: () => false,
      sent: new Map(),
      counts,
      nowMs: NOW,
    });
    expect(chunks.map((chunk) => chunk.length)).toEqual([32, 8]);
  });
});

function harness(
  options: {
    readonly threads?: ReadonlyArray<SidebarThreadSummary>;
    readonly registrations?: ReadonlyArray<PushRegistration>;
    readonly status?: (enrollmentId: string) => PushActivityEntryStatus;
    readonly outcome?: () => ActivitySendOutcome | null;
  } = {},
) {
  const rows = new Map(
    (options.threads ?? [thread("a")]).map((row) => [row.id as string, row] as const),
  );
  let registrations = options.registrations ?? [registration(PHONE)];
  let foreground = new Set<string>();
  let listener: (() => void) | null = null;
  let sequence = 1_000;
  const activity: Array<Omit<PushActivitySignalInput, "proof">> = [];
  const alerts: number[] = [];
  let shellReads = 0;
  const removed: string[][] = [];
  const publisher = startAttentionPublisher({
    environmentId: async () => HUB_ENVIRONMENT,
    isConnectorOnline: () => true,
    readShell: async () => {
      shellReads += 1;
      return { sequence: 1, threads: [...rows.values()] };
    },
    readThread: async (_environmentId, threadId) => rows.get(threadId) ?? null,
    isSnoozed: isThreadSnoozed,
    registrations: async () => registrations,
    foregroundEnrollments: async () => foreground,
    reserveSequence: async () => sequence++,
    removeEnrollments: async (enrollmentIds) => void removed.push([...enrollmentIds]),
    setHubDelivery: () => undefined,
    send: async (signal) => {
      alerts.push(Date.now());
      return {
        kind: "delivered",
        result: { protocolVersion: 1, sequence: signal.sequence, results: [] },
      };
    },
    sendActivity: async (signal) => {
      activity.push(signal);
      return (
        options.outcome?.() ?? {
          kind: "delivered",
          result: {
            protocolVersion: 1,
            sequence: signal.sequence,
            results: signal.activities.map((entry) => ({
              enrollmentId: entry.enrollmentId,
              status: options.status?.(entry.enrollmentId) ?? "accepted",
            })),
          },
        }
      );
    },
    onRegistrationsChanged: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    reportFailure: () => undefined,
  });
  return {
    publisher,
    activity,
    alerts,
    shellReads: () => shellReads,
    removed,
    change: (row: SidebarThreadSummary, at: number) => {
      rows.set(row.id, row);
      publisher.threadChanged(row.id, at);
    },
    remove: (id: string, at: number) => {
      rows.delete(id);
      publisher.threadRemoved(ThreadId.make(id), at);
    },
    setRegistrations: (next: ReadonlyArray<PushRegistration>) => {
      registrations = next;
      listener?.();
    },
    setForeground: (next: ReadonlySet<string>) => {
      foreground = new Set(next);
      listener?.();
    },
    hasListener: () => listener !== null,
  };
}

describe("attention publisher: Live Activity counts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("signals counts only, once, and the end when they reach zero", async () => {
    const test = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.activity).toHaveLength(1);
    const signal = test.activity[0]!;
    expect(signal).toEqual({
      sequence: 1_000,
      issuedAt: NOW,
      activities: [
        { enrollmentId: PHONE, counts: { running: 1, needsYou: 0, failed: 0, done: 0 } },
      ],
    });
    // Counts only: no title, thread id or anything else of the thread.
    expect(JSON.stringify(signal)).not.toMatch(/Secret|thread|turn-|project/u);

    // The same counts again send nothing.
    test.change(thread("a", { updatedAt: "2026-10-28T12:00:01.000Z" }), 2);
    await vi.advanceTimersByTimeAsync(ACTIVITY_MIN_INTERVAL_MS * 2);
    expect(test.activity).toHaveLength(1);

    // An approval: sent, no sooner than the minimum interval after the last signal.
    test.change(thread("a", { hasPendingApprovals: true }), 3);
    await vi.advanceTimersByTimeAsync(ACTIVITY_MIN_INTERVAL_MS);
    expect(test.activity.at(-1)!.activities[0]!.counts).toEqual({
      running: 0,
      needsYou: 1,
      failed: 0,
      done: 0,
    });
    expect(test.activity.at(-1)!.sequence).toBeGreaterThan(signal.sequence);

    // Deleted: zero counts end the card, once.
    test.remove("a", 4);
    await vi.advanceTimersByTimeAsync(ACTIVITY_MIN_INTERVAL_MS);
    const sentBefore = test.activity.length;
    expect(test.activity.at(-1)!.activities[0]!.counts).toEqual({
      running: 0,
      needsYou: 0,
      failed: 0,
      done: 0,
    });
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 2);
    expect(test.activity).toHaveLength(sentBefore);
    await test.publisher.stop();
    expect(test.hasListener()).toBe(false);
  });

  it("coalesces a burst of changes into one signal with the latest counts", async () => {
    const test = harness({ threads: [] });
    await vi.advanceTimersByTimeAsync(0);
    // On start the device hears the node's counts once, zero included.
    expect(test.activity.map((signal) => signal.activities[0]!.counts.running)).toEqual([0]);
    test.change(thread("a"), 2);
    await vi.advanceTimersByTimeAsync(200);
    test.change(thread("b"), 3);
    await vi.advanceTimersByTimeAsync(200);
    test.change(thread("c"), 4);
    await vi.advanceTimersByTimeAsync(ACTIVITY_MIN_INTERVAL_MS * 2);
    // The three changes inside the minimum interval became one signal with the latest counts.
    expect(test.activity.map((signal) => signal.activities[0]!.counts.running)).toEqual([0, 3]);
    await test.publisher.stop();
  });

  it("refreshes held counts before the Hub's stale window while work runs", async () => {
    const test = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.activity).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS);
    expect(test.activity).toHaveLength(2);
    expect(test.activity[1]!.activities[0]!.counts.running).toBe(1);
    await test.publisher.stop();
  });

  it("sends nothing for a device in front and catches it up once it leaves", async () => {
    const test = harness({ threads: [] });
    test.setForeground(new Set([PHONE]));
    await vi.advanceTimersByTimeAsync(0);
    test.change(thread("a", { hasPendingApprovals: true }), 2);
    await vi.advanceTimersByTimeAsync(ACTIVITY_FOREGROUND_RECHECK_MS);
    expect(test.activity).toHaveLength(0);
    test.setForeground(new Set());
    await vi.advanceTimersByTimeAsync(ACTIVITY_MIN_INTERVAL_MS);
    expect(test.activity).toHaveLength(1);
    expect(test.activity[0]!.activities[0]!.counts.needsYou).toBe(1);
    await test.publisher.stop();
  });

  it("starts counting for a device that registers with Live Activity", async () => {
    const test = harness({ registrations: [] });
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS);
    expect(test.activity).toHaveLength(0);
    test.setRegistrations([registration(PHONE)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.activity).toHaveLength(1);
    await test.publisher.stop();
  });

  it("forgets a device the Hub does not authorize and backs off an older Hub", async () => {
    const unauthorized = harness({
      registrations: [registration(PHONE), registration(TABLET)],
      status: (id) => (id === TABLET ? "not-authorized" : "accepted"),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(unauthorized.removed).toEqual([[TABLET]]);
    await unauthorized.publisher.stop();

    const older = harness({ outcome: () => ({ kind: "unsupported" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(older.activity).toHaveLength(1);
    older.change(thread("a", { hasPendingApprovals: true }), 2);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 3);
    expect(older.activity).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ATTENTION_UNSUPPORTED_BACKOFF_MS);
    expect(older.activity.length).toBeGreaterThan(1);
    await older.publisher.stop();
  });

  it("does not refresh counts the Hub kept nothing of", async () => {
    const test = harness({ status: () => "no-token" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 2);
    expect(test.activity).toHaveLength(1);
    await test.publisher.stop();
  });

  it("backs a failing activity route off on its own, without holding up alerts", async () => {
    let failing = true;
    const test = harness({ outcome: () => (failing ? { kind: "failed" } : null) });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.activity).toHaveLength(1);
    // A streaming turn: a change every second for a minute.
    for (let second = 1; second <= 60; second += 1) {
      test.change(thread("a", { updatedAt: new Date(NOW + second * 1_000).toISOString() }), second);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // One attempt per pass, then 5 s, 10 s, 20 s, 40 s apart: never a POST per batch.
    expect(test.activity.length).toBeLessThanOrEqual(5);
    // An alert in the middle of the failures still goes out on its own schedule.
    const before = test.alerts.length;
    test.change(
      thread("a", {
        hasPendingApprovals: true,
        updatedAt: new Date(NOW + 61_000).toISOString(),
      }),
      100,
    );
    await vi.advanceTimersByTimeAsync(ATTENTION_COALESCE_MS + ATTENTION_READ_DEBOUNCE_MS + 50);
    expect(test.alerts.length).toBe(before + 1);
    // Once the Hub answers again, the latest counts go out and the back-off resets.
    failing = false;
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS);
    expect(test.activity.at(-1)!.activities[0]!.counts.needsYou).toBe(1);
    await test.publisher.stop();
  });

  it("tells the Hub zero once after a restart, so it can end a card the node left running", async () => {
    // A fresh process knows nothing it sent before: zero counts still go to the device once.
    const test = harness({ threads: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.activity).toHaveLength(1);
    expect(test.activity[0]!.activities[0]!.counts).toEqual({
      running: 0,
      needsYou: 0,
      failed: 0,
      done: 0,
    });
    await test.publisher.stop();
  });

  it("does no refresh passes while every count is zero", async () => {
    const test = harness({ threads: [] });
    await vi.advanceTimersByTimeAsync(0);
    const reads = test.shellReads();
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 5);
    expect(test.shellReads()).toBe(reads);
    expect(test.activity).toHaveLength(1);
    await test.publisher.stop();
  });
});
