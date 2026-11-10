import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { ApprovalRequestId, EnvironmentId, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import type { PushAlertExcerpt } from "@ryco/contracts/push-alert";
import {
  PUSH_SEALED_LEGACY_MAX_LENGTH,
  PUSH_SEALED_MAX_LENGTH,
  type PushAttentionSignalInput,
} from "@ryco/contracts/push-hub";
import { openPushPayload, pushSealAssociatedData } from "@ryco/shared/pushSeal";
import { e2eeX25519KeyPair } from "@ryco/shared/relayE2eeKeys";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ATTENTION_COALESCE_MS,
  ATTENTION_READ_DEBOUNCE_MS,
  ATTENTION_RETRY_DELAY_MS,
  type AttentionSendOutcome,
  startAttentionPublisher,
} from "./attentionPublisher.ts";
import type { PushRegistration } from "./pushRegistrations.ts";

const HUB_ENVIRONMENT = "env_hubEnvironment000000";
const threadId = ThreadId.make("thread-1");
const deviceKey = e2eeX25519KeyPair();

function summary(patch: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: threadId,
    environmentId: EnvironmentId.make(HUB_ENVIRONMENT),
    projectId: ProjectId.make("project"),
    title: "Fix the login race",
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-28T10:00:00.000Z",
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: "2026-10-28T10:00:00.000Z",
      startedAt: "2026-10-28T10:00:00.000Z",
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

const completed = () =>
  summary({
    latestTurn: {
      ...summary().latestTurn!,
      state: "completed",
      completedAt: "2026-10-28T11:00:00.000Z",
    },
  });

function registration(patch: Partial<PushRegistration> = {}): PushRegistration {
  return {
    enrollmentId: "enr_device00000000000000000",
    keyId: "AAAAAAAAAAAAAAAAAAAAAA",
    publicKey: Buffer.from(deviceKey.publicKey).toString("base64url"),
    role: "owner",
    kinds: ["approval", "input", "plan-ready", "completed", "failed", "stopped"],
    sound: true,
    collapseSalt: "s".repeat(43),
    createdAt: 0,
    refreshedAt: 0,
    ...patch,
  };
}

function harness(
  options: {
    readonly registrations?: ReadonlyArray<PushRegistration>;
    readonly foreground?: ReadonlySet<string>;
    readonly online?: boolean;
    readonly send?: (signal: Omit<PushAttentionSignalInput, "proof">) => AttentionSendOutcome;
    readonly readExcerpt?: () => Promise<PushAlertExcerpt | null>;
    /** What the Hub's answers say it takes; absent like an older Hub. */
    readonly sealedMaxLength?: number;
  } = {},
) {
  let row = summary();
  let sequence = 1_000;
  const sent: Array<Omit<PushAttentionSignalInput, "proof">> = [];
  const removed: string[][] = [];
  const delivery: string[] = [];
  const publisher = startAttentionPublisher({
    environmentId: async () => HUB_ENVIRONMENT,
    isConnectorOnline: () => options.online ?? true,
    readShell: async () => ({ sequence: 1, threads: [row] }),
    readThread: async () => row,
    isSnoozed: isThreadSnoozed,
    readExcerpt: options.readExcerpt,
    registrations: async () => options.registrations ?? [registration()],
    foregroundEnrollments: async () => options.foreground ?? new Set(),
    reserveSequence: async () => sequence++,
    removeEnrollments: async (enrollmentIds) => void removed.push([...enrollmentIds]),
    setHubDelivery: (value) => void delivery.push(value),
    send: async (signal) => {
      sent.push(signal);
      return (
        options.send?.(signal) ?? {
          kind: "delivered",
          result: {
            protocolVersion: 1,
            sequence: signal.sequence,
            ...(options.sealedMaxLength === undefined
              ? {}
              : { sealedMaxLength: options.sealedMaxLength }),
            results: signal.deliveries.map((item) => ({
              enrollmentId: item.enrollmentId,
              status: "sent" as const,
            })),
          },
        }
      );
    },
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    reportFailure: () => undefined,
  });
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(ATTENTION_READ_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(ATTENTION_COALESCE_MS);
  };
  return {
    publisher,
    sent,
    removed,
    delivery,
    settle,
    update: async (next: SidebarThreadSummary, at: number) => {
      row = next;
      publisher.threadChanged(threadId, at);
    },
  };
}

const open = (signal: Omit<PushAttentionSignalInput, "proof">, index = 0) => {
  const delivery = signal.deliveries[index]!;
  const plaintext = openPushPayload({
    recipientSecretKey: deviceKey.secretKey,
    sealed: Uint8Array.from(Buffer.from(delivery.sealed, "base64url")),
    associatedData: pushSealAssociatedData({
      environmentId: HUB_ENVIRONMENT,
      sequence: signal.sequence,
      enrollmentId: delivery.enrollmentId,
    }),
  });
  return plaintext === null ? null : JSON.parse(new TextDecoder().decode(plaintext));
};

describe("attention publisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-28T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seals a completed turn to the device and signals the Hub once", async () => {
    const test = harness();
    await vi.advanceTimersByTimeAsync(0);
    await test.update(completed(), 2);
    await test.settle();
    expect(test.sent).toHaveLength(1);
    const signal = test.sent[0]!;
    expect(signal.deliveries).toHaveLength(1);
    expect(open(signal)).toMatchObject({
      v: 1,
      k: "completed",
      t: "Fix the login race",
      e: HUB_ENVIRONMENT,
      th: "thread-1",
      tu: "turn-1",
      q: signal.sequence,
      // A finished turn waits on nobody.
      b: 0,
    });
    expect(test.delivery).toContain("available");
    await test.publisher.stop();
  });

  it("names an approval alert's request, so the phone answers that approval only", async () => {
    const test = harness();
    await vi.advanceTimersByTimeAsync(0);
    await test.update(
      summary({
        hasPendingApprovals: true,
        pendingApprovalRequestId: ApprovalRequestId.make("approval-a"),
      }),
      2,
    );
    await test.settle();
    // The thread waiting on the person is the node's one "needs you": the badge count.
    expect(open(test.sent[0]!)).toMatchObject({
      k: "approval",
      tu: "turn-1",
      rq: "approval-a",
      b: 1,
    });
    // A newer approval in the same turn gets its own alert, with its own request.
    await test.update(
      summary({
        hasPendingApprovals: true,
        pendingApprovalRequestId: ApprovalRequestId.make("approval-b"),
      }),
      3,
    );
    await test.settle();
    expect(test.sent).toHaveLength(2);
    expect(open(test.sent[1]!)).toMatchObject({ k: "approval", rq: "approval-b" });
    // An id too long to seal is left out: the phone then answers nothing from the alert.
    await test.update(
      summary({
        hasPendingApprovals: true,
        pendingApprovalRequestId: ApprovalRequestId.make("x".repeat(200)),
      }),
      4,
    );
    await test.settle();
    expect(open(test.sent[2]!)).not.toHaveProperty("rq");
    await test.publisher.stop();
  });

  it("never replays what the shell already showed when it started", async () => {
    const test = harness();
    await test.update(completed(), 1);
    await vi.advanceTimersByTimeAsync(0);
    await test.settle();
    expect(test.sent).toEqual([]);
    await test.publisher.stop();
  });

  it("sends one alert for an approval answered and completed within the coalescing window", async () => {
    const test = harness();
    await vi.advanceTimersByTimeAsync(0);
    await test.update(summary({ hasPendingApprovals: true }), 2);
    await vi.advanceTimersByTimeAsync(ATTENTION_READ_DEBOUNCE_MS);
    await test.update(completed(), 3);
    await test.settle();
    expect(test.sent).toHaveLength(1);
    expect(open(test.sent[0]!)).toMatchObject({ k: "completed" });
    await test.publisher.stop();
  });

  it("skips devices in front and action alerts for viewers", async () => {
    const test = harness({
      registrations: [
        registration({ enrollmentId: "enr_inFront0000000000000000" }),
        registration({ enrollmentId: "enr_viewer00000000000000000", role: "viewer" }),
      ],
      foreground: new Set(["enr_inFront0000000000000000"]),
    });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(summary({ hasPendingApprovals: true }), 2);
    await test.settle();
    expect(test.sent).toEqual([]);
    await test.update(completed(), 3);
    await test.settle();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]!.deliveries.map((delivery) => delivery.enrollmentId)).toEqual([
      "enr_viewer00000000000000000",
    ]);
    await test.publisher.stop();
  });

  it("retries a failed signal once with the same sequence, then drops it", async () => {
    const test = harness({ send: () => ({ kind: "failed" }) });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(completed(), 2);
    await test.settle();
    await vi.advanceTimersByTimeAsync(ATTENTION_RETRY_DELAY_MS);
    expect(test.sent).toHaveLength(2);
    expect(test.sent[1]).toEqual(test.sent[0]);
    await vi.advanceTimersByTimeAsync(ATTENTION_RETRY_DELAY_MS * 3);
    expect(test.sent).toHaveLength(2);
    await test.publisher.stop();
  });

  it("stops asking a Hub without the route and says so", async () => {
    const test = harness({ send: () => ({ kind: "unsupported" }) });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(completed(), 2);
    await test.settle();
    await test.update(summary({ hasPendingUserInput: true }), 3);
    await test.settle();
    expect(test.sent).toHaveLength(1);
    expect(test.delivery).toEqual(["hub-unsupported"]);
    await test.publisher.stop();
  });

  it("forgets devices the Hub no longer authorizes", async () => {
    const test = harness({
      send: (signal) => ({
        kind: "delivered",
        result: {
          protocolVersion: 1,
          sequence: signal.sequence,
          results: signal.deliveries.map((item) => ({
            enrollmentId: item.enrollmentId,
            status: "not-authorized" as const,
          })),
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(completed(), 2);
    await test.settle();
    expect(test.removed).toEqual([["enr_device00000000000000000"]]);
    await test.publisher.stop();
  });

  it("sends nothing while the connector is offline", async () => {
    const test = harness({ online: false });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(completed(), 2);
    await test.settle();
    expect(test.sent).toEqual([]);
    expect(test.delivery).toEqual(["offline"]);
    await test.publisher.stop();
  });

  it("splits more than 32 deliveries across signals with their own sequences", async () => {
    const registrations = Array.from({ length: 40 }, (_, index) =>
      registration({ enrollmentId: `enr_device${String(index).padStart(17, "0")}` }),
    );
    const test = harness({ registrations });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(completed(), 2);
    await test.settle();
    expect(test.sent.map((signal) => signal.deliveries.length)).toEqual([32, 8]);
    expect(test.sent[0]!.sequence).not.toBe(test.sent[1]!.sequence);
    expect(open(test.sent[1]!)).toMatchObject({ q: test.sent[1]!.sequence });
    await test.publisher.stop();
  });

  it("carries the approval's excerpt, at the legacy size until the Hub says it takes more", async () => {
    const command = `deploy ${"--flag value ".repeat(150)}`;
    const reads: string[] = [];
    const test = harness({
      sealedMaxLength: PUSH_SEALED_MAX_LENGTH,
      readExcerpt: async () => {
        reads.push("read");
        return { a: { k: "command", d: command } };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(
      summary({
        hasPendingApprovals: true,
        pendingApprovalRequestId: ApprovalRequestId.make("approval-a"),
      }),
      2,
    );
    await test.settle();
    const first = test.sent[0]!;
    expect(first.deliveries[0]!.sealed.length).toBeLessThanOrEqual(PUSH_SEALED_LEGACY_MAX_LENGTH);
    const firstExcerpt = open(first).x.a.d as string;
    expect(firstExcerpt.endsWith("…")).toBe(true);
    // The Hub's answer named a larger size: the next alert carries more of the command.
    await test.update(
      summary({
        hasPendingApprovals: true,
        pendingApprovalRequestId: ApprovalRequestId.make("approval-b"),
      }),
      3,
    );
    await test.settle();
    const second = test.sent[1]!;
    expect(second.deliveries[0]!.sealed.length).toBeGreaterThan(PUSH_SEALED_LEGACY_MAX_LENGTH);
    expect(second.deliveries[0]!.sealed.length).toBeLessThanOrEqual(PUSH_SEALED_MAX_LENGTH);
    expect((open(second).x.a.d as string).length).toBeGreaterThan(firstExcerpt.length);
    // One read per alert; a completion reads nothing.
    await test.update(completed(), 4);
    await test.settle();
    expect(open(test.sent[2]!)).not.toHaveProperty("x");
    expect(reads).toHaveLength(2);
    await test.publisher.stop();
  });

  it("still sends an alert whose excerpt could not be read, without one", async () => {
    const test = harness({
      readExcerpt: async () => {
        throw new Error("database busy");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(summary({ hasPendingUserInput: true }), 2);
    await test.settle();
    expect(test.sent).toHaveLength(1);
    expect(open(test.sent[0]!)).toMatchObject({ k: "input" });
    expect(open(test.sent[0]!)).not.toHaveProperty("x");
    await test.publisher.stop();
  });

  it("splits signals of large payloads so each body stays under the Hub's limit", async () => {
    const registrations = Array.from({ length: 40 }, (_, index) =>
      registration({ enrollmentId: `enr_device${String(index).padStart(17, "0")}` }),
    );
    const test = harness({ registrations, sealedMaxLength: PUSH_SEALED_MAX_LENGTH });
    await vi.advanceTimersByTimeAsync(0);
    await test.update(completed(), 2);
    await test.settle();
    // The first pass still uses the legacy size: the Hub has not answered yet.
    expect(test.sent.map((signal) => signal.deliveries.length)).toEqual([32, 8]);
    await test.update(summary({ hasPendingUserInput: true }), 3);
    await test.settle();
    expect(test.sent.slice(2).map((signal) => signal.deliveries.length)).toEqual([19, 19, 2]);
    for (const signal of test.sent) {
      expect(JSON.stringify(signal).length).toBeLessThan(64 * 1_024);
    }
    await test.publisher.stop();
  });
});
