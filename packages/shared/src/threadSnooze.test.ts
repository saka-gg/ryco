import { describe, expect, it } from "vite-plus/test";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "./restartContinuation.ts";
import { isThreadSnoozed, resolveSnoozePresets } from "./threadSnooze.ts";

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
    { session: { status: "error", updatedAt: "2026-09-06T11:00:00.000Z" } },
  ])("wakes for new actionable activity: %j", (activity) => {
    expect(isThreadSnoozed({ ...snoozed, ...activity }, now)).toBe(false);
  });
  it("allows running work and previously seen errors to stay deferred", () => {
    expect(
      isThreadSnoozed({ ...snoozed, session: { status: "running", updatedAt: since } }, now),
    ).toBe(true);
    expect(
      isThreadSnoozed({ ...snoozed, session: { status: "error", updatedAt: since } }, now),
    ).toBe(true);
  });
  it("stays deferred when a server restart releases the session", () => {
    const released = {
      status: "error",
      lastError: ORPHANED_PROVIDER_SESSION_ERROR,
      updatedAt: "2026-09-06T11:00:00.000Z",
    };
    expect(isThreadSnoozed({ ...snoozed, session: released }, now)).toBe(true);
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
