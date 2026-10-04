import { PROVIDER_DISPLAY_NAMES, type ThreadUsageLimit } from "@ryco/contracts";
import {
  applicableUsageLimit,
  effectiveUsageLimitAutoResume,
  isUsageLimitResetFresh,
  usageLimitPhase,
  type UsageLimitPhase,
  type UsageLimitThreadInput,
} from "@ryco/shared/usageLimit";

export {
  USAGE_LIMIT_HOLD_RELEASE_MS,
  USAGE_LIMIT_RESUME_MESSAGE,
  applicableUsageLimit,
  effectiveUsageLimitAutoResume,
  isUsageLimitQueueHeld,
  isUsageLimitResetFresh,
  usageLimitHoldReleaseAtMs,
  usageLimitPhase,
  usageLimitResumeIds,
  type UsageLimitPhase,
  type UsageLimitThreadInput,
} from "@ryco/shared/usageLimit";

export interface UsageLimitStatus {
  readonly label: "Limited" | "Limit reset";
  readonly resetAt: string | null;
  readonly phase: UsageLimitPhase;
  readonly limit: ThreadUsageLimit;
}

/** Inbox and sidebar status for a thread stopped by a usage limit; null when not limited. */
export function deriveUsageLimitStatus(
  thread: UsageLimitThreadInput,
  nowMs: number,
): UsageLimitStatus | null {
  const limit = applicableUsageLimit(thread);
  if (limit === null) return null;
  const phase = usageLimitPhase(limit, nowMs);
  return {
    label: phase === "limited" ? "Limited" : "Limit reset",
    resetAt: limit.resetAt,
    phase,
    limit,
  };
}

const RESET_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/** "Thu 15:40" in the viewer's timezone; the day keeps multi-day weekly resets unambiguous. */
export function formatUsageLimitReset(resetAt: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, RESET_TIME_FORMAT).format(new Date(resetAt));
}

export type UsageLimitBannerDescription =
  | "resets-at"
  | "resuming-at-reset"
  | "unknown-reset"
  | "reset-passed";

export interface UsageLimitBannerModel {
  readonly limit: ThreadUsageLimit;
  readonly phase: UsageLimitPhase;
  readonly title: string;
  readonly description: UsageLimitBannerDescription;
  readonly resetAt: string | null;
  /** Milliseconds at which the banner must re-render (the reset), if any. */
  readonly refreshAtMs: number | null;
  readonly actions: {
    readonly resumeNow: boolean;
    /** null when the toggle is not offered; `scheduled` = a resume at reset is armed. */
    readonly autoResume: { readonly scheduled: boolean } | null;
    readonly snoozeUntilReset: boolean;
  };
}

export function usageLimitProviderLabel(limit: Pick<ThreadUsageLimit, "provider">): string {
  return PROVIDER_DISPLAY_NAMES[limit.provider] ?? limit.provider;
}

/**
 * The composer banner for a limited thread: copy and which actions to offer. Scheduling
 * and snoozing need a server that runs the recovery worker; Resume now only needs a
 * mutation-ready connection.
 */
export function deriveUsageLimitBanner(input: {
  readonly thread: UsageLimitThreadInput & { readonly snoozedUntil?: string | null | undefined };
  /** The node's `autoResumeLimitedThreads`; null when unknown. */
  readonly nodeAutoResume: boolean | null;
  readonly recoverySupported: boolean;
  readonly snoozeEligibility: { readonly canSnooze: boolean };
  readonly snoozeSupported: boolean;
  readonly dispatchAllowed: boolean;
  readonly nowMs: number;
}): UsageLimitBannerModel | null {
  const limit = applicableUsageLimit(input.thread);
  if (limit === null) return null;
  const phase = usageLimitPhase(limit, input.nowMs);
  const resetMs = limit.resetAt === null ? null : Date.parse(limit.resetAt);
  const resetAhead = resetMs !== null && resetMs > input.nowMs;
  // With the node setting unknown, only an explicit per-thread override counts.
  const scheduled =
    input.nodeAutoResume === null
      ? limit.autoResume === true
      : effectiveUsageLimitAutoResume(limit, input.nodeAutoResume);
  const autoResume =
    input.recoverySupported && isUsageLimitResetFresh(limit) && resetAhead ? { scheduled } : null;
  const description: UsageLimitBannerDescription =
    limit.resetAt === null
      ? "unknown-reset"
      : phase === "reset"
        ? "reset-passed"
        : autoResume?.scheduled === true
          ? "resuming-at-reset"
          : "resets-at";
  return {
    limit,
    phase,
    title:
      phase === "reset"
        ? "Usage limit reset"
        : `${usageLimitProviderLabel(limit)} usage limit reached`,
    description,
    resetAt: limit.resetAt,
    refreshAtMs: resetAhead ? resetMs : null,
    actions: {
      resumeNow: input.dispatchAllowed,
      autoResume: input.dispatchAllowed ? autoResume : null,
      snoozeUntilReset:
        input.dispatchAllowed &&
        input.recoverySupported &&
        input.snoozeSupported &&
        input.snoozeEligibility.canSnooze &&
        resetAhead &&
        input.thread.snoozedUntil !== limit.resetAt,
    },
  };
}
