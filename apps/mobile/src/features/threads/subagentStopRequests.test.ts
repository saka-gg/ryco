import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createStopRequestRegistry,
  STOP_UNCONFIRMED_MS,
} from "@ryco/client-runtime/state/session/subagentStop";
import { OrchestrationStopBackgroundTaskError } from "@ryco/contracts";

import { startSubagentStop, type SubagentStopAlert } from "./subagentStopRequests";

describe("stopping an agent from the phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays pending after the node accepts it, until the shared timeout, then says so", async () => {
    const registry = createStopRequestRegistry(STOP_UNCONFIRMED_MS);
    const alerts: SubagentStopAlert[] = [];
    const unwatch = registry.watch("a");
    const send = vi.fn(() => Promise.resolve());
    expect(startSubagentStop({ registry, key: "a", send, alert: (a) => alerts.push(a) })).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    // Accepted is not stopped: Stop keeps reading "Stopping…" until the agent settles.
    expect(registry.isPending("a")).toBe(true);
    // A second tap, or another sheet, joins the stop on its way.
    expect(startSubagentStop({ registry, key: "a", send, alert: (a) => alerts.push(a) })).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(STOP_UNCONFIRMED_MS);
    expect(registry.isPending("a")).toBe(false);
    expect(alerts).toEqual([
      {
        title: "Stop not confirmed",
        message: "The agent may still be running. You can try again.",
      },
    ]);
    unwatch();
  });

  it("reports nothing when the agent settled, which took its Stop away", async () => {
    const registry = createStopRequestRegistry(STOP_UNCONFIRMED_MS);
    const alert = vi.fn();
    const unwatch = registry.watch("a");
    startSubagentStop({ registry, key: "a", send: () => Promise.resolve(), alert });
    // The row settles: its Stop, and the watch with it, goes.
    unwatch();
    await vi.advanceTimersByTimeAsync(STOP_UNCONFIRMED_MS);
    expect(alert).not.toHaveBeenCalled();
  });

  it("says why the node refused, in web's words, and offers Stop again", async () => {
    const registry = createStopRequestRegistry(STOP_UNCONFIRMED_MS);
    const alerts: SubagentStopAlert[] = [];
    startSubagentStop({
      registry,
      key: "a",
      send: () =>
        Promise.reject(
          new OrchestrationStopBackgroundTaskError({
            reason: "unsupported",
            threadId: "thread-1",
            taskId: "a",
          }),
        ),
      alert: (a) => alerts.push(a),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.isPending("a")).toBe(false);
    expect(alerts).toEqual([
      { title: "Could not stop agent", message: "This provider can't stop a single agent." },
    ]);
  });
});
