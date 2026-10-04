import {
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ThreadUsageLimit,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveUsageLimitBanner, deriveUsageLimitStatus } from "./usageLimit.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const LIMITED_AT = "2026-10-04T10:00:00.000Z";
const RESET_AT = "2026-10-04T15:00:00.000Z";
const RESET_MS = Date.parse(RESET_AT);
const BEFORE = RESET_MS - 3_600_000;

function limit(overrides: Partial<ThreadUsageLimit> = {}): ThreadUsageLimit {
  return {
    limitId: "usage-limit:thread-1:turn-1",
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: claude,
    turnId: TurnId.make("turn-1"),
    message: "Claude usage limit reached.",
    limitedAt: LIMITED_AT,
    resetAt: RESET_AT,
    autoResume: null,
    updatedAt: LIMITED_AT,
    ...overrides,
  };
}

const thread = (overrides: Partial<ThreadUsageLimit> = {}, snoozedUntil: string | null = null) => ({
  usageLimit: limit(overrides),
  modelSelection: { instanceId: claude },
  snoozedUntil,
});

const banner = (
  options: {
    readonly limit?: Partial<ThreadUsageLimit>;
    readonly snoozedUntil?: string | null;
    readonly nodeAutoResume?: boolean | null;
    readonly recoverySupported?: boolean;
    readonly canSnooze?: boolean;
    readonly dispatchAllowed?: boolean;
    readonly nowMs?: number;
  } = {},
) =>
  deriveUsageLimitBanner({
    thread: thread(options.limit, options.snoozedUntil ?? null),
    nodeAutoResume: options.nodeAutoResume === undefined ? false : options.nodeAutoResume,
    recoverySupported: options.recoverySupported ?? true,
    snoozeEligibility: { canSnooze: options.canSnooze ?? true },
    snoozeSupported: true,
    dispatchAllowed: options.dispatchAllowed ?? true,
    nowMs: options.nowMs ?? BEFORE,
  });

describe("deriveUsageLimitStatus", () => {
  it("switches from Limited to Limit reset at the reset", () => {
    expect(deriveUsageLimitStatus(thread(), BEFORE)?.label).toBe("Limited");
    expect(deriveUsageLimitStatus(thread(), RESET_MS)?.label).toBe("Limit reset");
    expect(deriveUsageLimitStatus(thread({ resetAt: null }), RESET_MS + 1e9)?.label).toBe(
      "Limited",
    );
    expect(
      deriveUsageLimitStatus({ ...thread(), modelSelection: { instanceId: "codex" } }, BEFORE),
    ).toBeNull();
  });
});

describe("deriveUsageLimitBanner", () => {
  it("offers every action before a fresh reset on a capable server", () => {
    expect(banner()).toMatchObject({
      title: "Claude usage limit reached",
      description: "resets-at",
      refreshAtMs: RESET_MS,
      actions: { resumeNow: true, autoResume: { scheduled: false }, snoozeUntilReset: true },
    });
  });

  it("describes a scheduled resume from the node setting or an override", () => {
    expect(banner({ nodeAutoResume: true })).toMatchObject({
      description: "resuming-at-reset",
      actions: { autoResume: { scheduled: true } },
    });
    expect(banner({ nodeAutoResume: true, limit: { autoResume: false } })).toMatchObject({
      description: "resets-at",
      actions: { autoResume: { scheduled: false } },
    });
    expect(banner({ nodeAutoResume: null })?.actions.autoResume).toEqual({ scheduled: false });
    expect(
      banner({ nodeAutoResume: null, limit: { autoResume: true } })?.actions.autoResume,
    ).toEqual({ scheduled: true });
  });

  it("hides scheduling and snoozing without the server capability", () => {
    expect(banner({ recoverySupported: false })?.actions).toEqual({
      resumeNow: true,
      autoResume: null,
      snoozeUntilReset: false,
    });
  });

  it("offers only Resume now for an unknown, stale or passed reset", () => {
    expect(banner({ limit: { resetAt: null } })).toMatchObject({
      description: "unknown-reset",
      refreshAtMs: null,
      actions: { resumeNow: true, autoResume: null, snoozeUntilReset: false },
    });
    expect(banner({ limit: { resetAt: LIMITED_AT } })?.actions.autoResume).toBeNull();
    expect(banner({ nowMs: RESET_MS + 1 })).toMatchObject({
      title: "Usage limit reset",
      description: "reset-passed",
      actions: { resumeNow: true, autoResume: null, snoozeUntilReset: false },
    });
  });

  it("respects snooze eligibility and an existing snooze to the reset", () => {
    expect(banner({ canSnooze: false })?.actions.snoozeUntilReset).toBe(false);
    expect(banner({ snoozedUntil: RESET_AT })?.actions.snoozeUntilReset).toBe(false);
  });

  it("disables every action when dispatch is not allowed", () => {
    expect(banner({ dispatchAllowed: false })?.actions).toEqual({
      resumeNow: false,
      autoResume: null,
      snoozeUntilReset: false,
    });
  });
});
