import { SourceControlProviderError } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  latestSourceControlPause,
  noteSourceControlReadOutcome,
  resetSourceControlPausesForTests,
  subscribeSourceControlPauses,
} from "./sourceControlPause";

const NOW = 1_000_000_000_000;

function paused(provider: "github" | "gitlab", retryAt?: number) {
  return new SourceControlProviderError({
    provider,
    operation: "getChangeRequestDetail",
    detail: "requests are paused after a rate limit.",
    reason: "rate-limited",
    ...(retryAt !== undefined ? { retryAt } : {}),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSourceControlPausesForTests();
});

afterEach(() => {
  resetSourceControlPausesForTests();
  vi.useRealTimers();
});

describe("observed source control pauses", () => {
  it("keeps the pause that ends last, and drops each one when it ends", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSourceControlPauses(listener);
    noteSourceControlReadOutcome("a", paused("github", NOW + 60_000), NOW);
    noteSourceControlReadOutcome("b", paused("gitlab", NOW + 300_000), NOW);
    expect(latestSourceControlPause()).toEqual({ provider: "gitlab", retryAt: NOW + 300_000 });

    vi.advanceTimersByTime(300_000);
    expect(latestSourceControlPause()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("clears a read's pause on its next outcome", () => {
    noteSourceControlReadOutcome("a", paused("github", NOW + 60_000), NOW);
    noteSourceControlReadOutcome("a", null, NOW + 1_000);
    expect(latestSourceControlPause()).toBeNull();
    noteSourceControlReadOutcome("a", paused("github", NOW + 60_000), NOW);
    noteSourceControlReadOutcome("a", new Error("timed out"), NOW + 1_000);
    expect(latestSourceControlPause()).toBeNull();
  });

  it("keeps the same object while the same pause is reported again", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSourceControlPauses(listener);
    noteSourceControlReadOutcome("a", paused("github", NOW + 60_000), NOW);
    const first = latestSourceControlPause();
    noteSourceControlReadOutcome("b", paused("github", NOW + 60_000), NOW + 10);
    noteSourceControlReadOutcome("a", paused("github", NOW + 60_000), NOW + 20);
    expect(latestSourceControlPause()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("waits for an end past what one timer can wait for without spinning", () => {
    // A node whose clock runs weeks ahead: one timer cannot wait that long.
    const farOff = NOW + 40 * 24 * 60 * 60_000;
    noteSourceControlReadOutcome("a", paused("github", farOff), NOW);
    vi.advanceTimersByTime(3 * 60 * 60_000);
    expect(latestSourceControlPause()).toEqual({ provider: "github", retryAt: farOff });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("ignores pauses without a known end, ended ones and other failures", () => {
    noteSourceControlReadOutcome("a", paused("github"), NOW);
    noteSourceControlReadOutcome("b", paused("github", NOW - 1), NOW);
    noteSourceControlReadOutcome("c", new Error("API rate limit exceeded"), NOW);
    noteSourceControlReadOutcome("d", null, NOW);
    expect(latestSourceControlPause()).toBeNull();
  });
});
