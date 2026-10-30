import { afterEach, describe, expect, it } from "vitest";

import {
  NOTICEABLE_STALL_MAX_AGE_MS,
  noteEventLoopStall,
  readNoticeableStall,
  resetNoticeableStallForTests,
} from "./NoticeableStall.ts";

const AT = Date.parse("2026-10-30T14:02:00.000Z");

afterEach(() => resetNoticeableStallForTests());

describe("noticeable event-loop stall", () => {
  it("keeps a stall of five seconds or more for five minutes, as the config carries it", () => {
    noteEventLoopStall({ startedAtMs: AT, durationMs: 4_999, loadAverage1m: 3, cpuCount: 8 });
    expect(readNoticeableStall(AT + 10_000)).toBeUndefined();

    noteEventLoopStall({ startedAtMs: AT, durationMs: 7_250.4, loadAverage1m: 22.34, cpuCount: 8 });
    expect(readNoticeableStall(AT + 10_000)).toEqual({
      startedAt: "2026-10-30T14:02:00.000Z",
      durationMs: 7_250,
      loadAverage1m: 22.3,
      cpuCount: 8,
    });
    expect(readNoticeableStall(AT + NOTICEABLE_STALL_MAX_AGE_MS + 1)).toBeUndefined();
  });

  it("leaves out a load average the platform does not have", () => {
    noteEventLoopStall({
      startedAtMs: AT,
      durationMs: 6_000,
      loadAverage1m: undefined,
      cpuCount: 4,
    });
    expect(readNoticeableStall(AT)).toEqual({
      startedAt: "2026-10-30T14:02:00.000Z",
      durationMs: 6_000,
      cpuCount: 4,
    });
  });

  it("does not let a shorter stall hide a longer one still being reported", () => {
    noteEventLoopStall({ startedAtMs: AT, durationMs: 12_000, loadAverage1m: 9, cpuCount: 8 });
    noteEventLoopStall({
      startedAtMs: AT + 60_000,
      durationMs: 5_500,
      loadAverage1m: 2,
      cpuCount: 8,
    });
    expect(readNoticeableStall(AT + 61_000)?.durationMs).toBe(12_000);

    // Once the long one has aged out, a newer one replaces it.
    noteEventLoopStall({
      startedAtMs: AT + NOTICEABLE_STALL_MAX_AGE_MS + 1,
      durationMs: 5_500,
      loadAverage1m: 2,
      cpuCount: 8,
    });
    expect(readNoticeableStall(AT + NOTICEABLE_STALL_MAX_AGE_MS + 2)?.durationMs).toBe(5_500);
  });
});
