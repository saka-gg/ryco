import { describe, expect, it, vi } from "vite-plus/test";

import {
  AGENT_ACTIVITY_STALE_AFTER_MS,
  type AgentActivityContentState,
} from "../liveActivity/agentActivityModel";
import { buildAgentWidgetTimeline, startAgentWidgetRuntime } from "./agentWidgetTimeline";
import { AGENT_WIDGET_KIND, WIDGET_KINDS } from "./widgetKinds";

const NOW = 1_800_000_000_000;

function state(title: string, updatedAt = NOW): AgentActivityContentState {
  return {
    v: 1,
    origin: "local",
    counts: { running: 1, needsYou: 0, failed: 0, done: 0 },
    rows: [
      {
        title,
        project: "ryco",
        model: "Opus 5.5",
        phase: "running",
        status: "Working",
        since: NOW - 60_000,
        url: "ryco://threads/env/t1",
      },
    ],
    url: "ryco://",
    updatedAt,
  };
}

function harness() {
  let now = NOW;
  const native = {
    writeTimeline: vi.fn(async (_kind: string, _json: string) => undefined),
    clear: vi.fn(async (_kind: string) => undefined),
  };
  const runtime = startAgentWidgetRuntime({ native, now: () => now });
  return { native, runtime, advance: (ms: number) => (now += ms) };
}

describe("the agent widget", () => {
  it("is emptied with the others on the sign-in screen", () => {
    expect(WIDGET_KINDS).toContain(AGENT_WIDGET_KIND);
  });

  it("shows the state now and the same state out of date at the card's stale date", () => {
    expect(buildAgentWidgetTimeline(state("A"), NOW)).toEqual([
      { at: NOW, content: { state: state("A"), stale: false } },
      { at: NOW + AGENT_ACTIVITY_STALE_AFTER_MS, content: { state: state("A"), stale: true } },
    ]);
  });

  it("writes when what it shows changes, and again before the written one goes stale", async () => {
    const test = harness();
    test.runtime.setState(state("A"));
    test.runtime.setState(state("A", NOW + 5_000));
    await test.runtime.settled();
    expect(test.native.writeTimeline).toHaveBeenCalledTimes(1);
    expect(test.native.writeTimeline.mock.calls[0]?.[0]).toBe(AGENT_WIDGET_KIND);

    test.runtime.setState(state("B"));
    await test.runtime.settled();
    expect(test.native.writeTimeline).toHaveBeenCalledTimes(2);

    test.advance(AGENT_ACTIVITY_STALE_AFTER_MS);
    test.runtime.setState(state("B"));
    await test.runtime.settled();
    expect(test.native.writeTimeline).toHaveBeenCalledTimes(3);
  });

  it("writes nothing while no machine is live, and empties itself when it stops for a sign-out", async () => {
    const test = harness();
    test.runtime.setState(null);
    await test.runtime.settled();
    expect(test.native.writeTimeline).not.toHaveBeenCalled();
    await test.runtime.stop({ clear: true });
    expect(test.native.clear).toHaveBeenCalledWith(AGENT_WIDGET_KIND);
    test.runtime.setState(state("A"));
    await test.runtime.settled();
    expect(test.native.writeTimeline).not.toHaveBeenCalled();
  });

  it("tries a failed write again with the next state", async () => {
    const test = harness();
    test.native.writeTimeline.mockRejectedValueOnce(new Error("disk"));
    const onError = vi.fn();
    const runtime = startAgentWidgetRuntime({ native: test.native, now: () => NOW, onError });
    runtime.setState(state("A"));
    await runtime.settled();
    expect(onError).toHaveBeenCalledOnce();
    runtime.setState(state("A"));
    await runtime.settled();
    expect(test.native.writeTimeline).toHaveBeenCalledTimes(2);
  });
});
