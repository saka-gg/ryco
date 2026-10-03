import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATIC_ACTIVE_REFRESH_MS,
  AUTOMATIC_DISCOVERY_REFRESH_MS,
  AUTOMATIC_SLOW_WATCH_REFRESH_MS,
  AUTOMATIC_WATCH_REFRESH_MS,
  POST_PUSH_DISCOVERY_WINDOW_MS,
  REDUCED_ACTIVE_REFRESH_MS,
  REDUCED_DISCOVERY_REFRESH_MS,
  REDUCED_SLOW_WATCH_REFRESH_MS,
  REDUCED_WATCH_REFRESH_MS,
  SOURCE_CONTROL_MAX_BACKOFF_MS,
  resolveSourceControlFailureDelay,
  resolveSourceControlRefreshDelay,
  resolveWorkflowRunJobsPhase,
  shouldRefreshSourceControlOnLifecycle,
  workflowRunJobsContradictRun,
} from "./sourceControlRefreshPolicy";

describe("source-control refresh policy", () => {
  it("uses adaptive automatic and reduced cadence", () => {
    expect(resolveSourceControlRefreshDelay({ mode: "automatic", phase: "discovery" })).toBe(
      AUTOMATIC_DISCOVERY_REFRESH_MS,
    );
    expect(resolveSourceControlRefreshDelay({ mode: "reduced", phase: "discovery" })).toBe(
      REDUCED_DISCOVERY_REFRESH_MS,
    );
    expect(resolveSourceControlRefreshDelay({ mode: "automatic", phase: "active" })).toBe(
      AUTOMATIC_ACTIVE_REFRESH_MS,
    );
    expect(resolveSourceControlRefreshDelay({ mode: "reduced", phase: "active" })).toBe(
      REDUCED_ACTIVE_REFRESH_MS,
    );
  });

  it("watches idle open items at a slower cadence than active ones", () => {
    expect(resolveSourceControlRefreshDelay({ mode: "automatic", phase: "watching" })).toBe(
      AUTOMATIC_WATCH_REFRESH_MS,
    );
    expect(resolveSourceControlRefreshDelay({ mode: "reduced", phase: "watching" })).toBe(
      REDUCED_WATCH_REFRESH_MS,
    );
    expect(resolveSourceControlRefreshDelay({ mode: "manual", phase: "watching" })).toBe(false);
    expect(AUTOMATIC_WATCH_REFRESH_MS).toBe(60_000);
    expect(REDUCED_WATCH_REFRESH_MS).toBe(120_000);
    expect(AUTOMATIC_WATCH_REFRESH_MS).toBeGreaterThan(AUTOMATIC_ACTIVE_REFRESH_MS);
    expect(REDUCED_WATCH_REFRESH_MS).toBeGreaterThan(REDUCED_ACTIVE_REFRESH_MS);
  });

  it("watches idle items on process-heavy hosts at a much slower cadence", () => {
    expect(resolveSourceControlRefreshDelay({ mode: "automatic", phase: "watching-slow" })).toBe(
      AUTOMATIC_SLOW_WATCH_REFRESH_MS,
    );
    expect(resolveSourceControlRefreshDelay({ mode: "reduced", phase: "watching-slow" })).toBe(
      REDUCED_SLOW_WATCH_REFRESH_MS,
    );
    expect(resolveSourceControlRefreshDelay({ mode: "manual", phase: "watching-slow" })).toBe(
      false,
    );
    expect(AUTOMATIC_SLOW_WATCH_REFRESH_MS).toBeGreaterThan(AUTOMATIC_WATCH_REFRESH_MS);
    expect(REDUCED_SLOW_WATCH_REFRESH_MS).toBeGreaterThan(REDUCED_WATCH_REFRESH_MS);
  });

  it("starts no timer for manual or settled state", () => {
    expect(resolveSourceControlRefreshDelay({ mode: "manual", phase: "active" })).toBe(false);
    expect(resolveSourceControlRefreshDelay({ mode: "automatic", phase: "settled" })).toBe(false);
  });

  it("stops post-push discovery at the fixed deadline", () => {
    const startedAtMs = 1_000;
    const discoveryExpiresAtMs = startedAtMs + POST_PUSH_DISCOVERY_WINDOW_MS;
    expect(
      resolveSourceControlRefreshDelay({
        mode: "automatic",
        phase: "discovery",
        nowMs: discoveryExpiresAtMs - 1,
        discoveryExpiresAtMs,
      }),
    ).toBe(AUTOMATIC_DISCOVERY_REFRESH_MS);
    expect(
      resolveSourceControlRefreshDelay({
        mode: "automatic",
        phase: "discovery",
        nowMs: discoveryExpiresAtMs,
        discoveryExpiresAtMs,
      }),
    ).toBe(false);
  });

  it("refreshes stale or invalidated automatic state on lifecycle recovery", () => {
    expect(
      shouldRefreshSourceControlOnLifecycle({
        mode: "automatic",
        hasData: true,
        invalidated: false,
        lastFetchedAtMs: 1_000,
        staleTimeMs: 60_000,
        nowMs: 61_000,
      }),
    ).toBe(true);
    expect(
      shouldRefreshSourceControlOnLifecycle({
        mode: "automatic",
        hasData: true,
        invalidated: true,
        lastFetchedAtMs: 60_000,
        staleTimeMs: 60_000,
        nowMs: 61_000,
      }),
    ).toBe(true);
    expect(
      shouldRefreshSourceControlOnLifecycle({
        mode: "manual",
        hasData: false,
        invalidated: true,
        lastFetchedAtMs: 0,
        staleTimeMs: 60_000,
        nowMs: 61_000,
      }),
    ).toBe(false);
  });

  it("backs off exponentially, caps delay, and honors retry hints", () => {
    expect(resolveSourceControlFailureDelay({ baseDelayMs: 10_000, consecutiveFailures: 1 })).toBe(
      10_000,
    );
    expect(resolveSourceControlFailureDelay({ baseDelayMs: 10_000, consecutiveFailures: 3 })).toBe(
      40_000,
    );
    expect(resolveSourceControlFailureDelay({ baseDelayMs: 60_000, consecutiveFailures: 9 })).toBe(
      SOURCE_CONTROL_MAX_BACKOFF_MS,
    );
    expect(
      resolveSourceControlFailureDelay({
        baseDelayMs: 10_000,
        consecutiveFailures: 4,
        retryAfterMs: 45_000,
      }),
    ).toBe(45_000);
  });
});

describe("workflow run jobs cadence", () => {
  const running = [{ status: "completed" }, { status: "in_progress" }];
  const finished = [{ status: "completed" }, { status: "COMPLETED" }];

  it("follows every incomplete run and any run whose jobs still show work", () => {
    expect(resolveWorkflowRunJobsPhase({ runIncomplete: true, jobs: null })).toBe("active");
    expect(resolveWorkflowRunJobsPhase({ runIncomplete: true, jobs: finished })).toBe("active");
    // The run finished but its cached jobs predate that: one more (final) read.
    expect(resolveWorkflowRunJobsPhase({ runIncomplete: false, jobs: running })).toBe("active");
  });

  it("settles a finished run once its jobs agree", () => {
    expect(resolveWorkflowRunJobsPhase({ runIncomplete: false, jobs: finished })).toBe("settled");
    expect(resolveWorkflowRunJobsPhase({ runIncomplete: false, jobs: [] })).toBe("settled");
    expect(resolveWorkflowRunJobsPhase({ runIncomplete: false, jobs: null })).toBe("settled");
  });

  it("flags cached jobs that contradict a run's new status", () => {
    // Finished, jobs still running: take the final read now.
    expect(workflowRunJobsContradictRun({ runIncomplete: false, jobs: running })).toBe(true);
    // Re-run (or queued with no jobs yet), jobs all finished: start following it.
    expect(workflowRunJobsContradictRun({ runIncomplete: true, jobs: finished })).toBe(true);
    expect(workflowRunJobsContradictRun({ runIncomplete: true, jobs: [] })).toBe(true);
    // Agreement needs no read.
    expect(workflowRunJobsContradictRun({ runIncomplete: false, jobs: finished })).toBe(false);
    expect(workflowRunJobsContradictRun({ runIncomplete: true, jobs: running })).toBe(false);
  });
});
