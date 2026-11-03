import { describe, expect, it } from "vite-plus/test";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "./restartContinuation.ts";
import {
  formatSnoozeCountdown,
  isThreadSnoozed,
  isThreadWokeUnseen,
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  resolveSnoozePresets,
  threadSnoozeWokeAt,
} from "./threadSnooze.ts";

const since = "2026-09-06T10:00:00.000Z";
const until = "2026-09-07T09:00:00.000Z";
const now = Date.parse("2026-09-06T12:00:00.000Z");
const snoozed = { snoozedAt: since, snoozedUntil: until };

describe("snooze visibility", () => {
  it("wakes at the exact deadline without a server event", () => {
    expect(isThreadSnoozed(snoozed, now)).toBe(true);
    expect(isThreadSnoozed(snoozed, Date.parse(until))).toBe(false);
    expect(isThreadSnoozed(snoozed, Date.parse(until) + 1)).toBe(false);
  });
  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { latestUserMessageAt: "2026-09-06T11:00:00.000Z" },
    { latestTurn: { completedAt: "2026-09-06T11:00:00.000Z" } },
  ])("wakes for new actionable activity: %j", (activity) => {
    expect(isThreadSnoozed({ ...snoozed, ...activity }, now)).toBe(false);
  });

  describe("follows the node on session errors", () => {
    const failedAfterSnooze = (lastError: string) => ({
      status: "error",
      lastError,
      updatedAt: "2026-09-06T11:00:00.000Z",
    });
    it.each([
      ORPHANED_PROVIDER_SESSION_ERROR,
      "The target provider did not accept the context handoff.",
    ])("stays snoozed while the node keeps the snooze through %j", (lastError) => {
      // Current nodes keep a thread snoozed through a restart release or a handoff rollback.
      const thread = { ...snoozed, session: failedAfterSnooze(lastError) };
      expect(isThreadSnoozed(thread, now)).toBe(true);
    });
    it("wakes once the node clears the snooze for an error", () => {
      // Every node clears the snooze for a provider error, and older nodes also for a
      // restart release or a handoff rollback.
      const thread = {
        snoozedAt: null,
        snoozedUntil: null,
        session: failedAfterSnooze("The provider crashed."),
      };
      expect(isThreadSnoozed(thread, now)).toBe(false);
    });
  });
  it.each([
    {},
    { snoozedUntil: until },
    { ...snoozed, snoozedAt: "invalid" },
    { ...snoozed, snoozedUntil: "invalid" },
  ])("does not hide missing or invalid state: %j", (thread) => {
    expect(isThreadSnoozed(thread, now)).toBe(false);
  });
});

describe("snooze presets", () => {
  it("offers one hour, three hours, evening, tomorrow and next week in the morning", () => {
    // Wednesday 2026-04-08 10:00 local.
    const presets = resolveSnoozePresets(new Date(2026, 3, 8, 10));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    const threeHours = presets.find((preset) => preset.id === "three-hours");
    expect(threeHours?.label).toBe("In 3 hours");
    expect(threeHours?.snoozedUntil).toBe(new Date(2026, 3, 8, 13).toISOString());
  });
  it("keeps three hours once the evening has passed", () => {
    expect(resolveSnoozePresets(new Date(2026, 3, 8, 21)).map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });
  it("offers only distinct future instants even when tomorrow is Monday", () => {
    const date = new Date(2026, 8, 6, 17, 0);
    const choices = resolveSnoozePresets(date);
    expect(new Set(choices.map((p) => p.snoozedUntil)).size).toBe(choices.length);
    expect(choices.every((p) => Date.parse(p.snoozedUntil) > date.getTime())).toBe(true);
    const morning = new Date(choices.find((p) => p.id === "tomorrow")!.snoozedUntil);
    expect(morning.getHours()).toBe(9);
    expect(morning.getDate()).toBe(7);
  });
  it("omits an evening that has already passed", () => {
    expect(resolveSnoozePresets(new Date(2026, 8, 8, 23, 30)).some((p) => p.id === "evening")).toBe(
      false,
    );
  });
});

describe("custom snooze", () => {
  const at = new Date(2026, 8, 14, 14, 30);

  it("converts a local date and time to an absolute wake time", () => {
    expect(resolveCustomSnooze({ mode: "date", date: "2026-09-15", time: "09:15" }, at)).toBe(
      new Date(2026, 8, 15, 9, 15).toISOString(),
    );
  });

  it.each([
    ["2026-09-14", "14:30"],
    ["2026-09-13", "09:00"],
    ["2027-02-29", "09:00"],
    ["2026-13-01", "09:00"],
    ["2026-09-15", "24:00"],
    ["2026-09-15", "09:60"],
    ["", "09:00"],
    ["2026-09-15", ""],
  ])("rejects invalid or past calendar input %s %s", (date, time) => {
    expect(resolveCustomSnooze({ mode: "date", date, time }, at)).toBeNull();
  });

  it.each([
    ["minutes", "45", 45 * 60_000],
    ["hours", "1.5", 90 * 60_000],
    ["days", "2", 48 * 3_600_000],
  ] as const)("counts %s from the confirmation time", (unit, amount, elapsed) => {
    const confirmedAt = new Date(at.getTime() + 5 * 60_000);
    expect(resolveCustomSnooze({ mode: "duration", amount, unit }, confirmedAt)).toBe(
      new Date(confirmedAt.getTime() + elapsed).toISOString(),
    );
  });

  it.each(["", " ", "0", "-1", "NaN", "Infinity", "1e300"])("rejects the duration %j", (amount) => {
    expect(resolveCustomSnooze({ mode: "duration", amount, unit: "hours" }, at)).toBeNull();
  });

  it("formats local field values without converting to UTC", () => {
    const date = new Date(2026, 0, 2, 3, 4);
    expect(localSnoozeDate(date)).toBe("2026-01-02");
    expect(localSnoozeTime(date)).toBe("03:04");
  });
});

describe("woke from snooze", () => {
  it("wakes by its timer at the snooze time, and not before", () => {
    expect(threadSnoozeWokeAt(snoozed, now)).toBeNull();
    expect(threadSnoozeWokeAt(snoozed, Date.parse(until))).toBe(until);
    expect(threadSnoozeWokeAt(snoozed, Date.parse(until) + 60_000)).toBe(until);
  });

  it.each([
    { snoozedAt: null, snoozedUntil: null },
    { snoozedAt: since, snoozedUntil: null },
    { snoozedAt: null, snoozedUntil: until },
    { snoozedAt: since, snoozedUntil: "not a date" },
  ])("has no wake without a recorded snooze: %j", (thread) => {
    expect(threadSnoozeWokeAt(thread, Date.parse(until) + 1)).toBeNull();
  });

  it("shows Woke until a visit after the wake", () => {
    expect(isThreadWokeUnseen({ wokeAt: until, lastVisitedAt: undefined })).toBe(true);
    expect(isThreadWokeUnseen({ wokeAt: until, lastVisitedAt: since })).toBe(true);
    expect(isThreadWokeUnseen({ wokeAt: until, lastVisitedAt: until })).toBe(false);
    expect(isThreadWokeUnseen({ wokeAt: null, lastVisitedAt: undefined })).toBe(false);
  });
});

describe("snooze countdown", () => {
  const wake = Date.parse(until);
  it.each([
    [28 * 60_000 + 59_000, "28 min left"],
    [88 * 60_000, "1 hr 28 min left"],
    [2 * 3_600_000, "2 hr left"],
    [49 * 3_600_000 + 5 * 60_000, "2 days 1 hr left"],
    [24 * 3_600_000 + 30 * 60_000, "1 day left"],
    [59_000, "Less than a minute left"],
    [0, "Returning…"],
    [-60_000, "Returning…"],
  ])("with %d ms to go reads %j", (remainingMs, text) => {
    expect(formatSnoozeCountdown(until, wake - remainingMs)).toBe(text);
  });
});
