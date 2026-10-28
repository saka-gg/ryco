import { describe, expect, it } from "vite-plus/test";
import {
  SIDEBAR_EXPAND_MARK_PREFIX,
  TAB_SWITCH_CLICK_MAX_AGE_MS,
  TAB_SWITCH_MARK_PREFIX,
  TAB_SWITCH_REVEAL_MEASURE_PREFIX,
  TIMELINE_REVEAL_MARK_PREFIX,
  createTabSwitchClickLedger,
  makeSidebarExpandMarkName,
  makeTabSwitchMarkName,
  makeTabSwitchRevealMeasureName,
  makeTimelineRevealMarkName,
  makeTimelineRevealMeasureName,
} from "./tabSwitchInstrumentation";

describe("makeTabSwitchMarkName", () => {
  it("encodes phase and key", () => {
    expect(makeTabSwitchMarkName("click", "env:thr_1")).toBe(
      `${TAB_SWITCH_MARK_PREFIX}click:env:thr_1`,
    );
    expect(makeTabSwitchMarkName("first-paint", "env:thr_1")).toBe(
      `${TAB_SWITCH_MARK_PREFIX}first-paint:env:thr_1`,
    );
  });

  it("rejects unsafe keys (no colons in key suffix)", () => {
    expect(() => makeTabSwitchMarkName("click", "")).toThrow();
  });
});

describe("makeSidebarExpandMarkName", () => {
  it("encodes phase and key", () => {
    expect(makeSidebarExpandMarkName("click", "project-a")).toBe(
      `${SIDEBAR_EXPAND_MARK_PREFIX}click:project-a`,
    );
    expect(makeSidebarExpandMarkName("first-paint", "project-a")).toBe(
      `${SIDEBAR_EXPAND_MARK_PREFIX}first-paint:project-a`,
    );
  });

  it("rejects empty keys", () => {
    expect(() => makeSidebarExpandMarkName("click", "")).toThrow();
  });
});

describe("timeline reveal mark names", () => {
  it("encodes phase, key and mount sequence", () => {
    expect(makeTimelineRevealMarkName("mount", "env:thr_1", 3)).toBe(
      `${TIMELINE_REVEAL_MARK_PREFIX}mount:env:thr_1:3`,
    );
    expect(makeTimelineRevealMarkName("visible", "env:thr_1", 3)).toBe(
      "ryco:timeline-reveal:visible:env:thr_1:3",
    );
    expect(makeTimelineRevealMarkName("rehidden", "env:thr_1", 3)).toBe(
      "ryco:timeline-reveal:rehidden:env:thr_1:3",
    );
  });

  it("names the mount-to-visible and click-to-visible measures", () => {
    expect(makeTimelineRevealMeasureName("env:thr_1", 3)).toBe("ryco:timeline-reveal:env:thr_1:3");
    expect(makeTabSwitchRevealMeasureName("env:thr_1")).toBe(
      `${TAB_SWITCH_REVEAL_MEASURE_PREFIX}env:thr_1`,
    );
  });

  it("rejects empty keys", () => {
    expect(() => makeTimelineRevealMarkName("mount", "", 1)).toThrow();
    expect(() => makeTimelineRevealMeasureName("", 1)).toThrow();
    expect(() => makeTabSwitchRevealMeasureName("")).toThrow();
  });
});

describe("createTabSwitchClickLedger", () => {
  // Each test owns its ledger and clock, and runs the deferred drops by hand.
  function createLedger() {
    const deferred: (() => void)[] = [];
    const clock = { time: 0 };
    const ledger = createTabSwitchClickLedger({
      defer: (callback) => {
        deferred.push(callback);
      },
      now: () => clock.time,
    });
    const runDeferred = () => {
      for (const callback of deferred.splice(0)) callback();
    };
    return { ledger, clock, runDeferred };
  }

  it("gives a click to the next mount of its thread, once", () => {
    const { ledger } = createLedger();
    ledger.note("env:a");
    expect(ledger.claim("env:a", true)).toEqual({ key: "env:a", at: 0 });
    expect(ledger.claim("env:a", true)).toBeNull();
  });

  it("drops a click when another thread mounts first", () => {
    const { ledger } = createLedger();
    ledger.note("env:a");
    expect(ledger.claim("env:b", true)).toBeNull();
    ledger.close("env:b");
    expect(ledger.claim("env:a", true)).toBeNull();
  });

  it("forgets a click on a tab whose mount never revealed once a newer click comes in", () => {
    const { ledger, runDeferred } = createLedger();
    ledger.note("env:a");
    const claim = ledger.claim("env:a", true);
    ledger.note("env:b");
    ledger.close("env:a");
    if (claim) ledger.release(claim);
    runDeferred();
    expect(ledger.claim("env:b", true)).toEqual({ key: "env:b", at: 0 });
    ledger.close("env:b");
    // Opening the first thread later, without a click, measures nothing.
    expect(ledger.claim("env:a", true)).toBeNull();
  });

  it("hands a released click to an immediate re-run of the same mount (StrictMode)", () => {
    const { ledger, runDeferred } = createLedger();
    ledger.note("env:a");
    const claim = ledger.claim("env:a", true);
    ledger.close("env:a");
    if (claim) ledger.release(claim);
    expect(ledger.claim("env:a", true)).toBe(claim);
    runDeferred();
  });

  it("drops a released click that no re-run claimed", () => {
    const { ledger, runDeferred } = createLedger();
    ledger.note("env:a");
    const claim = ledger.claim("env:a", true);
    ledger.close("env:a");
    if (claim) ledger.release(claim);
    runDeferred();
    expect(ledger.claim("env:a", true)).toBeNull();
  });

  it("spends a click on an empty thread, whose timeline mounts without a list", () => {
    const { ledger } = createLedger();
    ledger.note("env:b");
    expect(ledger.claim("env:b", false)).toBeNull();
    // The first send mounts the list later: that reveal was not opened by the click.
    ledger.close("env:b");
    expect(ledger.claim("env:b", true)).toBeNull();
  });

  it("keeps no click on the thread already open, as it remounts nothing", () => {
    const { ledger } = createLedger();
    expect(ledger.claim("env:a", true)).toBeNull();
    ledger.note("env:a");
    // Leaving for a route without a timeline, then opening the thread again without a click.
    ledger.close("env:a");
    expect(ledger.claim("env:a", true)).toBeNull();
    ledger.close("env:a");
    // Once the thread is closed, a click on its tab counts again.
    ledger.note("env:a");
    expect(ledger.claim("env:a", true)).toEqual({ key: "env:a", at: 0 });
  });

  it("counts a thread open until its last timeline closes", () => {
    const { ledger } = createLedger();
    ledger.claim("env:a", true);
    ledger.claim("env:a", true);
    ledger.close("env:a");
    ledger.note("env:a");
    ledger.close("env:a");
    expect(ledger.claim("env:a", true)).toBeNull();
  });

  it("drops a click that no timeline claimed within the max age", () => {
    const { ledger, clock } = createLedger();
    ledger.note("env:a");
    clock.time = TAB_SWITCH_CLICK_MAX_AGE_MS;
    expect(ledger.claim("env:a", true)).toEqual({ key: "env:a", at: 0 });
    ledger.close("env:a");

    ledger.note("env:b");
    clock.time += TAB_SWITCH_CLICK_MAX_AGE_MS + 1;
    expect(ledger.claim("env:b", true)).toBeNull();
  });
});
