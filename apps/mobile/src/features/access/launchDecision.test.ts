import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HOSTED_LAUNCH_DECISION_DEADLINE_MS,
  isAppAccessDecided,
  markAppAccessDecided,
  resetAppAccessDecisionForTests,
  shouldHideLaunchSplash,
  SPLASH_ACCESS_DECISION_WAIT_MS,
  subscribeAppAccessDecided,
} from "./launchDecision";

afterEach(() => resetAppAccessDecisionForTests());

describe("launch splash hand-off", () => {
  it("keeps the splash until the gate decides, once preferences are ready", () => {
    expect(
      shouldHideLaunchSplash({
        preferencesReady: true,
        accessDecided: false,
        decisionWaitElapsed: false,
      }),
    ).toBe(false);
    expect(
      shouldHideLaunchSplash({
        preferencesReady: true,
        accessDecided: true,
        decisionWaitElapsed: false,
      }),
    ).toBe(true);
  });

  it("falls back to the gate's own launch surface when the decision is slow", () => {
    expect(
      shouldHideLaunchSplash({
        preferencesReady: true,
        accessDecided: false,
        decisionWaitElapsed: true,
      }),
    ).toBe(true);
  });

  it("never hides before preferences are ready", () => {
    expect(
      shouldHideLaunchSplash({
        preferencesReady: false,
        accessDecided: true,
        decisionWaitElapsed: true,
      }),
    ).toBe(false);
  });

  it("bounds both waits well below the Hub request deadline", () => {
    expect(SPLASH_ACCESS_DECISION_WAIT_MS).toBeLessThanOrEqual(1_000);
    expect(HOSTED_LAUNCH_DECISION_DEADLINE_MS).toBeLessThan(30_000);
  });
});

describe("access decision signal", () => {
  it("publishes the first decision exactly once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppAccessDecided(listener);
    expect(isAppAccessDecided()).toBe(false);

    markAppAccessDecided();
    markAppAccessDecided();

    expect(isAppAccessDecided()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
