import { describe, expect, it } from "vite-plus/test";

import { createSmoothRevealState, revealBoundary, stepSmoothReveal } from "./useSmoothStreamedText";

describe("revealBoundary", () => {
  it("never splits a surrogate pair", () => {
    // "a" + 😀 (U+1F600, two UTF-16 units) + "b"
    const text = "a\u{1F600}b";
    expect(text.length).toBe(4);
    // Cutting at 2 would land between the emoji's halves and render U+FFFD.
    expect(revealBoundary(text, 2)).toBe(1);
    expect(revealBoundary(text, 3)).toBe(3);
  });

  it("leaves positions on plain characters untouched", () => {
    const text = "hello";
    expect(revealBoundary(text, 0)).toBe(0);
    expect(revealBoundary(text, 3)).toBe(3);
    expect(revealBoundary(text, 5)).toBe(5);
  });

  it("passes through a position at or past the end", () => {
    const text = "a\u{1F600}";
    expect(revealBoundary(text, text.length)).toBe(text.length);
    expect(revealBoundary(text, 99)).toBe(99);
  });
});

describe("stepSmoothReveal", () => {
  // A paragraph-sized burst with an astral character near the end, so the final
  // reveal also crosses a surrogate pair.
  const text = `${"streamed assistant text ".repeat(4)}\u{1F600}!`;

  // Above ~150 Hz the overdamped tail used to stall a few 1e-14 characters short of
  // the target: the last character stayed hidden and rAF kept running every frame.
  it.each([60, 120, 144, 165, 240, 360])("settles and reveals the full text at %i Hz", (hz) => {
    const state = createSmoothRevealState(0);
    let now = 1_000;
    let emitted = 0;
    let frames = 0;
    let pending = true;
    // Two seconds of frames is far more than a burst this size needs at any rate.
    while (pending && frames < hz * 2) {
      now += 1_000 / hz;
      frames += 1;
      pending = stepSmoothReveal(state, now, text.length);
      const count = revealBoundary(text, Math.floor(state.shown));
      expect(count).toBeGreaterThanOrEqual(emitted);
      emitted = count;
    }

    expect(pending).toBe(false);
    expect(state.shown).toBe(text.length);
    expect(text.slice(0, emitted)).toBe(text);
    // Caught up: the loop sleeps and the next burst starts from a fresh frame clock.
    expect(state.velocity).toBe(0);
    expect(state.lastFrameAt).toBe(0);
    expect(stepSmoothReveal(state, now + 60_000, text.length)).toBe(false);
    expect(stepSmoothReveal(state, now + 60_001, text.length + 10)).toBe(true);
  });

  it("settles a stalled sub-character tail instead of scheduling frames forever", () => {
    const state = { shown: 99.99999999999982, velocity: 1e-12, lastFrameAt: 1_000 };
    expect(stepSmoothReveal(state, 1_004, 100)).toBe(false);
    expect(state.shown).toBe(100);
  });

  it("settles once a frame's step can no longer move the float", () => {
    // Near 2^44 one float step is ~0.004 characters: this remainder is above the settle
    // threshold, yet no increment the velocity can reach would ever advance the reveal.
    const target = 2 ** 44 + 1;
    const state = { shown: target - 2 ** -6, velocity: 0, lastFrameAt: 1_000 };
    expect(stepSmoothReveal(state, 1_016, target)).toBe(false);
    expect(state.shown).toBe(target);
  });

  it("does not snap a meaningful backlog", () => {
    const state = createSmoothRevealState(0);
    // The first frame of a burst has no elapsed time to advance by.
    expect(stepSmoothReveal(state, 1_000, 100)).toBe(true);
    expect(state.shown).toBe(0);
    expect(stepSmoothReveal(state, 1_016, 100)).toBe(true);
    expect(state.shown).toBeGreaterThan(0);
    expect(state.shown).toBeLessThan(100);

    const tail = { shown: 99.9, velocity: 1, lastFrameAt: 1_000 };
    expect(stepSmoothReveal(tail, 1_004, 100)).toBe(true);
    expect(tail.shown).toBeLessThan(100);
  });
});
