import { describe, expect, it } from "vite-plus/test";

import { makeTabSwitchMarkName, makeTimelineRevealMarkName } from "./tabSwitchInstrumentation";
import { observeTimelineReveal, type TimelineRevealTarget } from "./timelineRevealObserver";

// The test plays the hook's part: it sets the mount mark first and says whether the mount claimed
// a session-tab click (the claim rules are covered in tabSwitchInstrumentation.test.ts).

interface RecordedEntry {
  readonly name: string;
  readonly startTime: number;
}

function createPerformance() {
  let clock = 0;
  const marks: RecordedEntry[] = [];
  const measures: { name: string; start: string; end: string }[] = [];
  const performance = {
    mark(name: string) {
      clock += 1;
      const entry = { name, startTime: clock };
      marks.push(entry);
      return entry as unknown as PerformanceMark;
    },
    measure(name: string, start?: string | PerformanceMeasureOptions, end?: string) {
      if (typeof start !== "string" || typeof end !== "string") throw new Error("named marks only");
      if (!marks.some((mark) => mark.name === start)) throw new Error(`no mark ${start}`);
      measures.push({ name, start, end });
      return {} as PerformanceMeasure;
    },
    getEntriesByName(name: string) {
      return marks.filter((mark) => mark.name === name) as unknown as PerformanceEntryList;
    },
  };
  return { performance, marks, measures, markNames: () => marks.map((mark) => mark.name) };
}

function createFrames() {
  let nextHandle = 1;
  const queue = new Map<number, () => void>();
  return {
    requestFrame(callback: () => void) {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelFrame(handle: number) {
      queue.delete(handle);
    },
    pending: () => queue.size,
    flush(count = 1) {
      for (let index = 0; index < count; index += 1) {
        const callbacks = [...queue.values()];
        queue.clear();
        for (const callback of callbacks) callback();
      }
    },
  };
}

function createTarget(visible = false) {
  const listeners = new Set<(ready: boolean) => void>();
  const state = { visible };
  const target: TimelineRevealTarget = {
    listen(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    isVisible: () => state.visible,
  };
  return {
    target,
    state,
    listeners,
    emit(ready: boolean) {
      for (const listener of listeners) listener(ready);
    },
  };
}

function observe(
  key: string,
  options: {
    readonly target: () => TimelineRevealTarget | null;
    readonly perf: ReturnType<typeof createPerformance>;
    readonly frames: ReturnType<typeof createFrames>;
    readonly durations?: number[];
    readonly measureTabSwitchClick?: boolean;
  },
) {
  let now = 100;
  // useTimelineRevealMark sets the mount mark itself, synchronously in the mount's layout effect.
  const mountName = makeTimelineRevealMarkName("mount", key, 7);
  options.perf.performance.mark(mountName);
  const cleanup = observeTimelineReveal({
    key,
    sequence: 7,
    mountName,
    mountedAt: now,
    measureTabSwitchClick: options.measureTabSwitchClick ?? false,
    resolveTarget: options.target,
    performance: options.perf.performance,
    requestFrame: options.frames.requestFrame,
    cancelFrame: options.frames.cancelFrame,
    now: () => (now += 16),
    onVisible: (durationMs) => options.durations?.push(durationMs),
  });
  return cleanup;
}

describe("observeTimelineReveal", () => {
  it("marks the mount, then the first frame the transcript is visible", () => {
    const perf = createPerformance();
    const frames = createFrames();
    const list = createTarget(false);
    const durations: number[] = [];
    const cleanup = observe("env:reveal", { target: () => list.target, perf, frames, durations });

    expect(perf.markNames()).toEqual(["ryco:timeline-reveal:mount:env:reveal:7"]);
    frames.flush(3);
    expect(perf.markNames()).toHaveLength(1);

    list.state.visible = true;
    list.emit(true);
    frames.flush();
    expect(perf.markNames()).toEqual([
      "ryco:timeline-reveal:mount:env:reveal:7",
      "ryco:timeline-reveal:visible:env:reveal:7",
    ]);
    expect(perf.measures).toEqual([
      {
        name: "ryco:timeline-reveal:env:reveal:7",
        start: "ryco:timeline-reveal:mount:env:reveal:7",
        end: "ryco:timeline-reveal:visible:env:reveal:7",
      },
    ]);
    expect(durations).toHaveLength(1);
    expect(durations[0]).toBeGreaterThan(0);
    cleanup();
  });

  it("sees a list that became visible before it subscribed", () => {
    const perf = createPerformance();
    const frames = createFrames();
    const list = createTarget(true);
    observe("env:early", { target: () => list.target, perf, frames });

    frames.flush();
    expect(perf.markNames()).toContain("ryco:timeline-reveal:visible:env:early:7");
  });

  it("keeps checking for a few frames when the items fade in after the ready signal", () => {
    const perf = createPerformance();
    const frames = createFrames();
    const list = createTarget(false);
    observe("env:lag", { target: () => list.target, perf, frames });
    frames.flush();

    list.emit(true);
    frames.flush(2);
    expect(perf.markNames()).not.toContain("ryco:timeline-reveal:visible:env:lag:7");
    list.state.visible = true;
    frames.flush();
    expect(perf.markNames()).toContain("ryco:timeline-reveal:visible:env:lag:7");
    expect(frames.pending()).toBe(0);
  });

  it("measures the claimed tab-switch click to the reveal", () => {
    const perf = createPerformance();
    const frames = createFrames();
    perf.performance.mark(makeTabSwitchMarkName("click", "env:click"));
    const list = createTarget(true);
    const durations: number[] = [];
    observe("env:click", {
      target: () => list.target,
      perf,
      frames,
      durations,
      measureTabSwitchClick: true,
    });
    frames.flush();
    expect(perf.measures.map((measure) => measure.name)).toEqual([
      "ryco:timeline-reveal:env:click:7",
      "ryco:tab-switch-reveal:env:click",
    ]);
    expect(perf.measures[1]).toMatchObject({
      start: "ryco:tab-switch:click:env:click",
      end: "ryco:timeline-reveal:visible:env:click:7",
    });
    expect(durations).toHaveLength(1);
  });

  it("measures no tab switch for a mount that claimed no click, even with a click mark", () => {
    const perf = createPerformance();
    const frames = createFrames();
    perf.performance.mark(makeTabSwitchMarkName("click", "env:noclick"));
    const list = createTarget(true);
    observe("env:noclick", { target: () => list.target, perf, frames });
    frames.flush();
    expect(perf.measures.map((measure) => measure.name)).toEqual([
      "ryco:timeline-reveal:env:noclick:7",
    ]);
  });

  it("still reveals when a claimed click mark was cleared", () => {
    const perf = createPerformance();
    const frames = createFrames();
    const list = createTarget(true);
    const durations: number[] = [];
    observe("env:cleared", {
      target: () => list.target,
      perf,
      frames,
      durations,
      measureTabSwitchClick: true,
    });
    frames.flush();
    expect(perf.markNames()).toContain("ryco:timeline-reveal:visible:env:cleared:7");
    expect(perf.measures.map((measure) => measure.name)).toEqual([
      "ryco:timeline-reveal:env:cleared:7",
    ]);
    expect(durations).toHaveLength(1);
  });

  it("marks a transcript that hides again after its reveal, once", () => {
    const perf = createPerformance();
    const frames = createFrames();
    const list = createTarget(true);
    observe("env:rehide", { target: () => list.target, perf, frames });
    frames.flush();

    list.state.visible = false;
    list.emit(false);
    frames.flush();
    list.state.visible = true;
    list.emit(true);
    frames.flush();
    list.state.visible = false;
    list.emit(false);
    frames.flush(3);
    expect(
      perf.markNames().filter((name) => name.startsWith("ryco:timeline-reveal:rehidden:")),
    ).toEqual(["ryco:timeline-reveal:rehidden:env:rehide:7"]);
  });

  it("waits a few frames for the list ref, then gives up", () => {
    const perf = createPerformance();
    const frames = createFrames();
    let attempts = 0;
    observe("env:missing", {
      target: () => {
        attempts += 1;
        return null;
      },
      perf,
      frames,
    });
    frames.flush(30);
    expect(attempts).toBe(12);
    expect(frames.pending()).toBe(0);
  });

  it("cancels its frame and unsubscribes on cleanup", () => {
    const perf = createPerformance();
    const frames = createFrames();
    const list = createTarget(false);
    const cleanup = observe("env:cleanup", { target: () => list.target, perf, frames });
    frames.flush();
    expect(list.listeners.size).toBe(1);
    expect(frames.pending()).toBe(1);

    cleanup();
    expect(list.listeners.size).toBe(0);
    expect(frames.pending()).toBe(0);
    list.state.visible = true;
    list.emit(true);
    frames.flush();
    expect(perf.markNames()).not.toContain("ryco:timeline-reveal:visible:env:cleanup:7");
  });
});
