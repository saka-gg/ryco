import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopHostedIdentityResumeRetry,
  DESKTOP_IDENTITY_RETRY_FOCUS_THROTTLE_MS,
  DESKTOP_IDENTITY_RETRY_INITIAL_MS,
  DESKTOP_IDENTITY_RETRY_MAX_MS,
  type DesktopIdentityResumeOutcome,
  type DesktopIdentityRetryTimers,
} from "./desktopHostedIdentityRetry.ts";

/** Deterministic timers: nothing runs until `advance` moves the clock. */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { due: number; run: () => void }>();
  const timers: DesktopIdentityRetryTimers = {
    setTimeout: (run, ms) => {
      const id = nextId++;
      tasks.set(id, { due: now + ms, run });
      return id;
    },
    clearTimeout: (id) => void tasks.delete(id as number),
  };
  return {
    timers,
    now: () => now,
    delays: () => [...tasks.values()].map((task) => task.due - now),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...tasks.entries()]
          .filter(([, task]) => task.due <= target)
          .toSorted(([, a], [, b]) => a.due - b.due)[0];
        if (!next) break;
        const [id, task] = next;
        now = task.due;
        tasks.delete(id);
        task.run();
        await flush();
      }
      now = target;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeRetry(outcomes: DesktopIdentityResumeOutcome[], canRetry = () => true) {
  const clock = makeClock();
  const resume = vi.fn(async () => outcomes.shift() ?? "unavailable");
  const retry = createDesktopHostedIdentityResumeRetry({
    resume,
    canRetry,
    timers: clock.timers,
    // No jitter: every delay is the middle of its range.
    random: () => 0.5,
    now: clock.now,
  });
  return { clock, resume, retry };
}

describe("desktop hosted identity resume retry", () => {
  it("retries a failed resume on a capped backoff until it is ready", async () => {
    const { clock, resume, retry } = makeRetry([
      "unavailable",
      "unavailable",
      "unavailable",
      "ready",
    ]);
    await retry.restart();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(clock.delays()).toEqual([DESKTOP_IDENTITY_RETRY_INITIAL_MS]);

    await clock.advance(DESKTOP_IDENTITY_RETRY_INITIAL_MS);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(clock.delays()).toEqual([2 * DESKTOP_IDENTITY_RETRY_INITIAL_MS]);

    await clock.advance(2 * DESKTOP_IDENTITY_RETRY_INITIAL_MS);
    await clock.advance(4 * DESKTOP_IDENTITY_RETRY_INITIAL_MS);
    expect(resume).toHaveBeenCalledTimes(4);
    expect(retry.pending()).toBe(false);
    await clock.advance(DESKTOP_IDENTITY_RETRY_MAX_MS * 10);
    expect(resume).toHaveBeenCalledTimes(4);
  });

  it("never waits longer than the ceiling between attempts", async () => {
    const { clock, retry } = makeRetry([]);
    await retry.restart();
    for (let index = 0; index < 12; index += 1) {
      const [delay] = clock.delays();
      expect(delay).toBeLessThanOrEqual(DESKTOP_IDENTITY_RETRY_MAX_MS);
      await clock.advance(delay!);
    }
    expect(clock.delays()).toEqual([DESKTOP_IDENTITY_RETRY_MAX_MS]);
  });

  it.each(["ready", "signed-out"] as const)("stops at %s", async (outcome) => {
    const { clock, resume, retry } = makeRetry([outcome]);
    await retry.restart();
    expect(retry.pending()).toBe(false);
    await clock.advance(DESKTOP_IDENTITY_RETRY_MAX_MS);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not retry without stored session material or once the status moved on", async () => {
    let canRetry = false;
    const { clock, resume, retry } = makeRetry([], () => canRetry);
    await retry.restart();
    expect(retry.pending()).toBe(false);

    canRetry = true;
    await retry.restart();
    expect(retry.pending()).toBe(true);
    // The status settled elsewhere before the timer fired.
    canRetry = false;
    await clock.advance(DESKTOP_IDENTITY_RETRY_INITIAL_MS);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(retry.pending()).toBe(false);
  });

  it("runs a pending retry at once on wake and network return", async () => {
    const { resume, retry } = makeRetry([]);
    await retry.restart();
    retry.nudge("wake");
    await flush();
    expect(resume).toHaveBeenCalledTimes(2);
    retry.nudge("network");
    await flush();
    expect(resume).toHaveBeenCalledTimes(3);
    expect(retry.pending()).toBe(true);
  });

  it("throttles focus retries", async () => {
    const { clock, resume, retry } = makeRetry([]);
    await retry.restart();
    retry.nudge("focus");
    await flush();
    retry.nudge("focus");
    await flush();
    expect(resume).toHaveBeenCalledTimes(2);
    // The backoff timer itself may fire meanwhile.
    await clock.advance(DESKTOP_IDENTITY_RETRY_FOCUS_THROTTLE_MS);
    const before = resume.mock.calls.length;
    retry.nudge("focus");
    await flush();
    expect(resume).toHaveBeenCalledTimes(before + 1);
  });

  it("ignores nudges with nothing pending and while a resume runs", async () => {
    let finish!: (outcome: DesktopIdentityResumeOutcome) => void;
    const clock = makeClock();
    const resume = vi.fn(
      () =>
        new Promise<DesktopIdentityResumeOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const retry = createDesktopHostedIdentityResumeRetry({
      resume,
      canRetry: () => true,
      timers: clock.timers,
      now: clock.now,
    });
    retry.nudge("wake");
    expect(resume).not.toHaveBeenCalled();
    const running = retry.restart();
    retry.nudge("wake");
    expect(resume).toHaveBeenCalledOnce();
    finish("unavailable");
    await running;
    expect(retry.pending()).toBe(true);
  });

  it("drops the answer of a resume that was running when it was stopped", async () => {
    let finish!: (outcome: DesktopIdentityResumeOutcome) => void;
    const clock = makeClock();
    const resume = vi.fn(
      () =>
        new Promise<DesktopIdentityResumeOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const retry = createDesktopHostedIdentityResumeRetry({
      resume,
      canRetry: () => true,
      timers: clock.timers,
      now: clock.now,
    });
    const running = retry.restart();
    // An account revocation lands while the resume is out.
    retry.stop();
    finish("unavailable");
    await running;
    expect(retry.pending()).toBe(false);
    await clock.advance(DESKTOP_IDENTITY_RETRY_MAX_MS);
    retry.nudge("wake");
    expect(resume).toHaveBeenCalledOnce();
  });

  it("ends the series when an interactive Connect settles it", async () => {
    const { clock, resume, retry } = makeRetry([]);
    await retry.restart();
    retry.noteOutcome("unavailable");
    expect(retry.pending()).toBe(true);
    retry.noteOutcome("ready");
    expect(retry.pending()).toBe(false);
    await clock.advance(DESKTOP_IDENTITY_RETRY_MAX_MS);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("treats a rejected resume as unavailable", async () => {
    const clock = makeClock();
    const retry = createDesktopHostedIdentityResumeRetry({
      resume: () => Promise.reject(new Error("offline")),
      canRetry: () => true,
      timers: clock.timers,
      now: clock.now,
    });
    await expect(retry.restart()).resolves.toBeUndefined();
    expect(retry.pending()).toBe(true);
  });
});
