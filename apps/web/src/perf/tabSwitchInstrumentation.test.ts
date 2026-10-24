import { describe, expect, it } from "vite-plus/test";
import {
  SIDEBAR_EXPAND_MARK_PREFIX,
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
  // Each test owns its ledger and runs the deferred drops by hand.
  function createLedger() {
    const deferred: (() => void)[] = [];
    const ledger = createTabSwitchClickLedger((callback) => {
      deferred.push(callback);
    });
    const runDeferred = () => {
      for (const callback of deferred.splice(0)) callback();
    };
    return { ledger, runDeferred };
  }

  it("gives a click to the next mount of its thread, once", () => {
    const { ledger } = createLedger();
    ledger.note("env:a");
    expect(ledger.claim("env:a")).toEqual({ key: "env:a" });
    expect(ledger.claim("env:a")).toBeNull();
  });

  it("drops a click when another thread mounts first", () => {
    const { ledger } = createLedger();
    ledger.note("env:a");
    expect(ledger.claim("env:b")).toBeNull();
    expect(ledger.claim("env:a")).toBeNull();
  });

  it("forgets a click on a tab whose mount never revealed once a newer click comes in", () => {
    const { ledger, runDeferred } = createLedger();
    ledger.note("env:a");
    const claim = ledger.claim("env:a");
    ledger.note("env:b");
    if (claim) ledger.release(claim);
    runDeferred();
    expect(ledger.claim("env:b")).toEqual({ key: "env:b" });
    // Opening the first thread later, without a click, measures nothing.
    expect(ledger.claim("env:a")).toBeNull();
  });

  it("hands a released click to an immediate re-run of the same mount (StrictMode)", () => {
    const { ledger, runDeferred } = createLedger();
    ledger.note("env:a");
    const claim = ledger.claim("env:a");
    if (claim) ledger.release(claim);
    expect(ledger.claim("env:a")).toBe(claim);
    runDeferred();
  });

  it("drops a released click that no re-run claimed", () => {
    const { ledger, runDeferred } = createLedger();
    ledger.note("env:a");
    const claim = ledger.claim("env:a");
    if (claim) ledger.release(claim);
    runDeferred();
    expect(ledger.claim("env:a")).toBeNull();
  });
});
