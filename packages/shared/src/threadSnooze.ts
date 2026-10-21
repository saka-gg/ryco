import { canSettleThread, type ThreadSettlementInput } from "./threadSettlement.ts";

export interface ThreadSnoozeState {
  readonly snoozedUntil?: string | null | undefined;
  readonly snoozedAt?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly latestTurn?:
    | { readonly state?: string | undefined; readonly completedAt?: string | null | undefined }
    | null
    | undefined;
}

/** Running work can be deferred; requests waiting on the user and undelivered work cannot. */
export function canSnoozeThread(input: ThreadSettlementInput) {
  const eligibility = canSettleThread({
    ...input,
    sessionStatus:
      input.sessionStatus === "running" || input.sessionStatus === "starting"
        ? null
        : input.sessionStatus,
  });
  return { canSnooze: eligibility.canSettle, blocker: eligibility.blocker };
}

/**
 * Derived from timestamps, so suspended clients and restarted servers need no timer event.
 *
 * A session error is not read here. The node decides whether an error wakes the thread and
 * clears the snooze when it does; every node that can snooze does that for provider errors. A
 * thread the node keeps snoozed through an error it decided on itself (a restart release, a
 * context handoff rollback) shows snoozed, as it is on the node.
 */
export function isThreadSnoozed(thread: ThreadSnoozeState, nowMs: number): boolean {
  const until = Date.parse(thread.snoozedUntil ?? "");
  const since = Date.parse(thread.snoozedAt ?? "");
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(until) ||
    !Number.isFinite(since) ||
    until <= nowMs
  )
    return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (Date.parse(thread.latestUserMessageAt ?? "") > since) return false;
  if (Date.parse(thread.latestTurn?.completedAt ?? "") > since) return false;
  return true;
}

export interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly snoozedUntil: string;
}

/** Calendar choices use the user's local timezone and preserve local morning across DST. */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      snoozedUntil: new Date(now.getTime() + 3_600_000).toISOString(),
    },
  ];
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() > now.getTime())
    presets.push({ id: "evening", label: "This evening", snoozedUntil: evening.toISOString() });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  presets.push({ id: "tomorrow", label: "Tomorrow morning", snoozedUntil: tomorrow.toISOString() });
  const monday = new Date(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  presets.push({ id: "next-week", label: "Next week", snoozedUntil: monday.toISOString() });
  return presets.filter(
    (preset, index) =>
      presets.findIndex((other) => other.snoozedUntil === preset.snoozedUntil) === index,
  );
}
