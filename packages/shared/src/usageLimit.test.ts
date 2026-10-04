import {
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ThreadUsageLimit,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  USAGE_LIMIT_AUTO_RESUME_MAX_LATENESS_MS,
  USAGE_LIMIT_HOLD_RELEASE_MS,
  USAGE_LIMIT_RESUME_GRACE_MS,
  applicableUsageLimit,
  effectiveUsageLimitAutoResume,
  isUsageLimitQueueHeld,
  isUsageLimitResetFresh,
  usageLimitAutoResumeBlocker,
  usageLimitHoldReleaseAtMs,
  usageLimitIdForTurn,
  usageLimitPhase,
  usageLimitRecordCommandId,
  usageLimitResetFillCommandId,
  usageLimitResumeIds,
  usageLimitSnoozeCommandId,
  type UsageLimitAutoResumeThread,
} from "./usageLimit.ts";

const LIMITED_AT = "2026-10-04T10:00:00.000Z";
const RESET_AT = "2026-10-04T15:00:00.000Z";
const RESET_MS = Date.parse(RESET_AT);

function limit(overrides: Partial<ThreadUsageLimit> = {}): ThreadUsageLimit {
  return {
    limitId: "usage-limit:thread-1:turn-1",
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    turnId: TurnId.make("turn-1"),
    message: "Claude usage limit reached.",
    limitedAt: LIMITED_AT,
    resetAt: RESET_AT,
    autoResume: null,
    updatedAt: LIMITED_AT,
    ...overrides,
  };
}

function thread(overrides: Partial<UsageLimitAutoResumeThread> = {}): UsageLimitAutoResumeThread {
  return {
    usageLimit: limit(),
    modelSelection: { instanceId: "claudeAgent" },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: { status: "error" },
    latestTurn: { state: "error" },
    ...overrides,
  };
}

describe("usage-limit ids", () => {
  it("are deterministic per thread, turn and limit", () => {
    const limitId = usageLimitIdForTurn("thread-1", "turn-1");
    expect(limitId).toBe("usage-limit:thread-1:turn-1");
    expect(usageLimitRecordCommandId(limitId)).toBe(
      "usage-limit-record:usage-limit:thread-1:turn-1",
    );
    expect(usageLimitResetFillCommandId(limitId)).toBe(
      "usage-limit-reset:usage-limit:thread-1:turn-1",
    );
    expect(usageLimitSnoozeCommandId(limitId, RESET_AT)).toBe(
      `usage-limit-snooze:usage-limit:thread-1:turn-1:${RESET_MS}`,
    );
    expect(usageLimitResumeIds(limitId)).toEqual({
      commandId: "usage-limit-resume:usage-limit:thread-1:turn-1",
      messageId: "usage-limit-resume:usage-limit:thread-1:turn-1",
    });
  });
});

describe("effectiveUsageLimitAutoResume", () => {
  it("follows the node setting when unset and lets an override win", () => {
    expect(effectiveUsageLimitAutoResume(limit({ autoResume: null }), true)).toBe(true);
    expect(effectiveUsageLimitAutoResume(limit({ autoResume: null }), false)).toBe(false);
    expect(effectiveUsageLimitAutoResume(limit({ autoResume: false }), true)).toBe(false);
    expect(effectiveUsageLimitAutoResume(limit({ autoResume: true }), false)).toBe(true);
  });
});

describe("applicableUsageLimit", () => {
  it("ignores a limit recorded for another provider instance", () => {
    expect(applicableUsageLimit(thread())).not.toBeNull();
    expect(applicableUsageLimit(thread({ modelSelection: { instanceId: "codex" } }))).toBeNull();
    expect(applicableUsageLimit(thread({ usageLimit: null }))).toBeNull();
  });
});

describe("usageLimitPhase and freshness", () => {
  it("switches to reset at the reported time and stays limited when unknown", () => {
    expect(usageLimitPhase(limit(), RESET_MS - 1)).toBe("limited");
    expect(usageLimitPhase(limit(), RESET_MS)).toBe("reset");
    expect(usageLimitPhase(limit({ resetAt: null }), RESET_MS + 1e9)).toBe("limited");
    expect(isUsageLimitResetFresh(limit())).toBe(true);
    expect(isUsageLimitResetFresh(limit({ resetAt: LIMITED_AT }))).toBe(false);
    expect(isUsageLimitResetFresh(limit({ resetAt: null }))).toBe(false);
  });
});

describe("isUsageLimitQueueHeld and usageLimitHoldReleaseAtMs", () => {
  it("holds with no release time while the reset is unknown", () => {
    const unknown = thread({ usageLimit: limit({ resetAt: null }) });
    expect(isUsageLimitQueueHeld(unknown, RESET_MS + 1e9)).toBe(true);
    expect(usageLimitHoldReleaseAtMs(unknown, RESET_MS)).toBeNull();
  });

  it("holds before the reset and until two minutes after it", () => {
    const release = RESET_MS + USAGE_LIMIT_HOLD_RELEASE_MS;
    expect(isUsageLimitQueueHeld(thread(), RESET_MS - 1)).toBe(true);
    expect(usageLimitHoldReleaseAtMs(thread(), RESET_MS - 1)).toBe(release);
    expect(isUsageLimitQueueHeld(thread(), RESET_MS + 60_000)).toBe(true);
    expect(usageLimitHoldReleaseAtMs(thread(), RESET_MS + 60_000)).toBe(release);
  });

  it("releases two minutes after the reset", () => {
    const release = RESET_MS + USAGE_LIMIT_HOLD_RELEASE_MS;
    expect(isUsageLimitQueueHeld(thread(), release)).toBe(false);
    expect(usageLimitHoldReleaseAtMs(thread(), release)).toBeNull();
  });

  it("never holds for a non-applicable limit", () => {
    const other = thread({ modelSelection: { instanceId: "codex" } });
    expect(isUsageLimitQueueHeld(other, RESET_MS - 1)).toBe(false);
  });
});

describe("usageLimitAutoResumeBlocker", () => {
  const eligibleNow = RESET_MS + USAGE_LIMIT_RESUME_GRACE_MS;
  const blocker = (
    overrides: Partial<UsageLimitAutoResumeThread>,
    options: { nodeSetting?: boolean; nowMs?: number } = {},
  ) =>
    usageLimitAutoResumeBlocker({
      thread: thread(overrides),
      nodeSetting: options.nodeSetting ?? true,
      nowMs: options.nowMs ?? eligibleNow,
    });

  it("allows an armed, idle, fresh limit after the grace", () => {
    expect(blocker({})).toBeNull();
  });

  it("reports every blocking reason", () => {
    expect(blocker({ usageLimit: null })).toBe("not-limited");
    expect(blocker({ modelSelection: { instanceId: "codex" } })).toBe("instance-mismatch");
    expect(blocker({}, { nodeSetting: false })).toBe("not-armed");
    expect(blocker({ usageLimit: limit({ autoResume: false }) })).toBe("not-armed");
    expect(blocker({ usageLimit: limit({ resetAt: null }) })).toBe("reset-unknown");
    expect(blocker({ usageLimit: limit({ resetAt: LIMITED_AT }) })).toBe("reset-stale");
    expect(blocker({}, { nowMs: RESET_MS })).toBe("before-reset");
    expect(blocker({}, { nowMs: eligibleNow - 1 })).toBe("before-reset");
    expect(blocker({}, { nowMs: RESET_MS + USAGE_LIMIT_AUTO_RESUME_MAX_LATENESS_MS + 1 })).toBe(
      "too-late",
    );
    expect(blocker({ archivedAt: LIMITED_AT })).toBe("archived");
    expect(blocker({ deletedAt: LIMITED_AT })).toBe("archived");
    expect(blocker({ settledOverride: "settled" })).toBe("settled");
    expect(blocker({ snoozedUntil: new Date(eligibleNow + 60_000).toISOString() })).toBe("snoozed");
    expect(blocker({ hasPendingApprovals: true })).toBe("pending-request");
    expect(blocker({ hasPendingUserInput: true })).toBe("pending-request");
    expect(blocker({ session: { status: "running" } })).toBe("busy");
    expect(blocker({ session: { status: "starting" } })).toBe("busy");
    expect(blocker({ latestTurn: { state: "running" } })).toBe("busy");
  });

  it("lets an explicit override arm a thread while the node setting is off", () => {
    expect(blocker({ usageLimit: limit({ autoResume: true }) }, { nodeSetting: false })).toBeNull();
  });

  it("ignores a snooze that already ended at the reset", () => {
    expect(blocker({ snoozedUntil: RESET_AT })).toBeNull();
  });
});
