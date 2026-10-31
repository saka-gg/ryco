import type { AgentActivitySummary } from "@ryco/client-runtime/state/threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AGENT_ACTIVITY_COALESCE_MS,
  AGENT_ACTIVITY_DISMISS_AFTER_MS,
  AGENT_ACTIVITY_STALE_AFTER_MS,
} from "./agentActivityModel";
import { startLiveActivityRuntime, type LiveActivityNative } from "./liveActivityRuntime";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const LINKS = {
  inbox: "ryco-dev://",
  thread: (environmentId: string, threadId: string) =>
    `ryco-dev://threads/${environmentId}/${threadId}`,
};

function summary(
  running: number,
  needsYou = 0,
  title = "Fix the flaky test",
): AgentActivitySummary {
  return {
    counts: { running, needsYou, failed: 0, done: running + needsYou === 0 ? 1 : 0 },
    rows: [
      {
        key: "env:t1",
        environmentId: "env",
        threadId: "t1",
        title,
        projectName: null,
        phase: needsYou > 0 ? "approval" : running > 0 ? "running" : "done",
      },
    ],
    settled: running + needsYou === 0,
  };
}

function harness(
  options: {
    readonly left?: ReadonlyArray<{ id: string; updatedAt: number; staleAt?: number }>;
  } = {},
) {
  let active = true;
  const listeners = new Set<(active: boolean) => void>();
  let nextId = 0;
  const native = {
    activitiesEnabled: vi.fn(() => true),
    startAgentActivity: vi.fn(async (_state: string, _stale: number) => `card-${(nextId += 1)}`),
    updateAgentActivity: vi.fn(
      async (_id: string, _state: string, _stale: number, _timestamp: number) => undefined,
    ),
    endAgentActivity: vi.fn(
      async (_id: string, _state: string | null, _dismissAt: number | null) => undefined,
    ),
    listAgentActivities: vi.fn(async () => options.left ?? []),
    dismissAgentActivities: vi.fn(async (_endedOnly: boolean) => undefined),
  } satisfies LiveActivityNative;
  const runtime = startLiveActivityRuntime({
    native,
    links: LINKS,
    appState: {
      isActive: () => active,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    now: () => Date.now(),
    onError: () => undefined,
  });
  const setActive = (next: boolean) => {
    active = next;
    for (const listener of listeners) listener(next);
  };
  return { native, runtime, setActive, listeners };
}

/** Lets the coalescing timer fire and the native calls it started finish. */
async function flush(runtime: { settled: () => Promise<void> }, ms = AGENT_ACTIVITY_COALESCE_MS) {
  await vi.advanceTimersByTimeAsync(ms);
  await runtime.settled();
}

describe("the Live Activity runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts nothing until the switch is on", async () => {
    const h = harness();
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    expect(h.native.startAgentActivity).not.toHaveBeenCalled();

    h.runtime.setEnabled(true);
    await flush(h.runtime);
    expect(h.native.startAgentActivity).toHaveBeenCalledTimes(1);
    const [state, staleAt] = h.native.startAgentActivity.mock.calls[0]!;
    const started = JSON.parse(state);
    expect(started).toMatchObject({ counts: { running: 1 }, rows: [{ phase: "running" }] });
    expect(staleAt).toBe(started.updatedAt + AGENT_ACTIVITY_STALE_AFTER_MS);
    await h.runtime.stop();
  });

  it("makes one update of changes within a second, and none for the same state", async () => {
    const h = harness();
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    h.runtime.setSummary(summary(1, 1), true, null);
    await vi.advanceTimersByTimeAsync(300);
    h.runtime.setSummary(summary(2, 1), true, null);
    await vi.advanceTimersByTimeAsync(300);
    h.runtime.setSummary(summary(2, 1, "Renamed"), true, null);
    await flush(h.runtime);
    expect(h.native.updateAgentActivity).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.native.updateAgentActivity.mock.calls[0]![1])).toMatchObject({
      counts: { running: 2, needsYou: 1 },
      rows: [{ title: "Renamed" }],
    });
    h.runtime.setSummary(summary(2, 1, "Renamed"), true, null);
    await flush(h.runtime);
    expect(h.native.updateAgentActivity).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });

  it("ends the card once everything settled, with fifteen minutes of results", async () => {
    const h = harness();
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    h.runtime.setSummary(summary(0), true, null);
    await flush(h.runtime);
    expect(h.native.endAgentActivity).toHaveBeenCalledTimes(1);
    const [id, final, dismissAt] = h.native.endAgentActivity.mock.calls[0]!;
    expect(id).toBe("card-1");
    const ended = JSON.parse(final!);
    expect(ended).toMatchObject({ counts: { running: 0, done: 1 }, rows: [{ phase: "done" }] });
    expect(dismissAt).toBe(ended.updatedAt + AGENT_ACTIVITY_DISMISS_AFTER_MS);
    await h.runtime.stop();
    // Stopping (sign-out) also takes the card that still shows its results, titles and all.
    expect(h.native.endAgentActivity).toHaveBeenCalledTimes(1);
    expect(h.native.dismissAgentActivities).toHaveBeenLastCalledWith(false);
  });

  it("removes a card still showing its results before work that starts again gets one", async () => {
    const h = harness();
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    h.runtime.setSummary(summary(0), true, null);
    await flush(h.runtime);
    h.native.dismissAgentActivities.mockClear();
    // Five minutes later, well within the results' fifteen minutes, work runs again.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    expect(h.native.startAgentActivity).toHaveBeenCalledTimes(2);
    expect(h.native.dismissAgentActivities.mock.calls).toEqual([[true]]);
    expect(h.native.dismissAgentActivities.mock.invocationCallOrder[0]!).toBeLessThan(
      h.native.startAgentActivity.mock.invocationCallOrder[1]!,
    );
    await h.runtime.stop();
  });

  it("ends the card once no machine was live for the stale window, counting again after a return", async () => {
    const h = harness();
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    // Every machine drops; the feed's clock keeps asking every minute.
    for (let minute = 0; minute < 9; minute += 1) {
      h.runtime.setSummary(summary(1), false, null);
      await flush(h.runtime, 60_000);
    }
    expect(h.native.endAgentActivity).not.toHaveBeenCalled();
    // Ryco was away and comes back: its machines get the whole window again.
    h.setActive(false);
    h.setActive(true);
    await flush(h.runtime, 0);
    for (let minute = 0; minute < 10; minute += 1) {
      h.runtime.setSummary(summary(1), false, null);
      await flush(h.runtime, 60_000);
    }
    expect(h.native.endAgentActivity).not.toHaveBeenCalled();
    // Ten minutes since the return, still nothing live: the card goes at once.
    h.runtime.setSummary(summary(1), false, null);
    await flush(h.runtime);
    expect(h.native.endAgentActivity).toHaveBeenCalledWith("card-1", null, null);
    await h.runtime.stop();
  });

  it("never starts in the background, and starts when Ryco comes back with work running", async () => {
    const h = harness();
    h.setActive(false);
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    expect(h.native.startAgentActivity).not.toHaveBeenCalled();
    h.setActive(true);
    await flush(h.runtime, 0);
    expect(h.native.startAgentActivity).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });

  it("ends every card at once on sign-out and on an account switch", async () => {
    const h = harness();
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, "account-a");
    await flush(h.runtime);
    h.runtime.setSummary(summary(1), true, "account-b");
    await flush(h.runtime);
    // Every Ryco card goes, also one this launch never knew.
    expect(h.native.dismissAgentActivities).toHaveBeenCalledWith(false);
    // The new account's work gets a card of its own.
    expect(h.native.startAgentActivity).toHaveBeenCalledTimes(2);
    h.native.dismissAgentActivities.mockClear();
    await h.runtime.stop();
    expect(h.native.dismissAgentActivities.mock.calls).toEqual([[false]]);
    expect(h.listeners.size).toBe(0);
  });

  it("ends the card when the switch goes off, and keeps one card of those an earlier launch left", async () => {
    const h = harness({
      left: [
        { id: "left-1", updatedAt: NOW - 60_000, staleAt: NOW + 60_000 },
        { id: "left-2", updatedAt: NOW - 30_000, staleAt: NOW + 90_000 },
      ],
    });
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    expect(h.native.endAgentActivity).toHaveBeenCalledWith("left-1", null, null);
    expect(h.native.startAgentActivity).not.toHaveBeenCalled();
    expect(h.native.updateAgentActivity).toHaveBeenCalledTimes(1);
    const [id, state, staleAt, timestamp] = h.native.updateAgentActivity.mock.calls[0]!;
    expect(id).toBe("left-2");
    expect(JSON.parse(state).updatedAt).toBe(timestamp);
    expect(staleAt).toBe(timestamp + AGENT_ACTIVITY_STALE_AFTER_MS);
    h.runtime.setEnabled(false);
    await flush(h.runtime, 0);
    // Off means no card at all, also one still showing its results.
    expect(h.native.dismissAgentActivities).toHaveBeenLastCalledWith(false);
    expect(h.native.updateAgentActivity).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });

  it("does not start again a card iOS refused until Ryco comes to the foreground again", async () => {
    const h = harness();
    h.native.startAgentActivity.mockRejectedValueOnce(new Error("refused"));
    h.runtime.setEnabled(true);
    h.runtime.setSummary(summary(1), true, null);
    await flush(h.runtime);
    h.runtime.setSummary(summary(2), true, null);
    await flush(h.runtime);
    expect(h.native.startAgentActivity).toHaveBeenCalledTimes(1);
    h.setActive(false);
    h.setActive(true);
    await flush(h.runtime, 0);
    expect(h.native.startAgentActivity).toHaveBeenCalledTimes(2);
    await h.runtime.stop();
  });
});
