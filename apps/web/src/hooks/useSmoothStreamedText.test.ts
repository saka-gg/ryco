import { describe, expect, it } from "vite-plus/test";

import {
  claimRevealEmit,
  createSmoothRevealState,
  MIN_EMIT_INTERVAL_MS,
  revealBoundary,
  stepSmoothReveal,
} from "./useSmoothStreamedText";

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
  // the target: the last character stayed hidden and rAF kept running every frame. Once
  // that settled, it still crept in for up to a second, because the velocity smoothing
  // was applied per frame rather than per second.
  it.each([60, 120, 144, 165, 240, 360, 1_000])(
    "settles and reveals the full text on the same schedule at %i Hz",
    (hz) => {
      const start = 1_000;
      const state = createSmoothRevealState(0);
      let now = start;
      let emitted = 0;
      let frames = 0;
      let pending = true;
      let secondToLastAt: number | null = null;
      // Bounded so a reveal that never settles fails instead of hanging.
      while (pending && frames < hz * 2) {
        now += 1_000 / hz;
        frames += 1;
        pending = stepSmoothReveal(state, now, text.length);
        const count = revealBoundary(text, Math.floor(state.shown));
        expect(count).toBeGreaterThanOrEqual(emitted);
        emitted = count;
        if (secondToLastAt === null && count >= text.length - 1) {
          secondToLastAt = now;
        }
      }

      expect(pending).toBe(false);
      expect(state.shown).toBe(text.length);
      expect(text.slice(0, emitted)).toBe(text);
      // This burst takes ~370-385 ms at every rate (more than a second at 360 Hz before
      // the smoothing became time-based), and the last character lands with the rest.
      expect(now - start).toBeLessThan(450);
      const lastCharacterDelay = secondToLastAt === null ? Infinity : now - secondToLastAt;
      expect(lastCharacterDelay).toBeLessThan(50);
      // Caught up: the loop sleeps and the next burst starts from a fresh frame clock.
      expect(state.velocity).toBe(0);
      expect(state.lastFrameAt).toBe(0);
      expect(stepSmoothReveal(state, now + 60_000, text.length)).toBe(false);
      expect(stepSmoothReveal(state, now + 60_001, text.length + 10)).toBe(true);
    },
  );

  it("settles a sub-character tail instead of scheduling frames forever", () => {
    // The step still moves the float here, so only the remainder threshold settles it.
    const state = { shown: 99.9995, velocity: 0.001, lastFrameAt: 1_000, lastEmitAt: 0 };
    expect(stepSmoothReveal(state, 1_004, 100)).toBe(false);
    expect(state.shown).toBe(100);
  });

  it("settles once a frame's step can no longer move the float", () => {
    // Near 2^44 one float step is ~0.004 characters: this remainder is above the settle
    // threshold, yet no increment the velocity can reach would ever advance the reveal.
    const target = 2 ** 44 + 1;
    const state = { shown: target - 2 ** -6, velocity: 0, lastFrameAt: 1_000, lastEmitAt: 0 };
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

    const tail = { shown: 99.9, velocity: 1, lastFrameAt: 1_000, lastEmitAt: 0 };
    expect(stepSmoothReveal(tail, 1_004, 100)).toBe(true);
    expect(tail.shown).toBeLessThan(100);
  });
});

/**
 * Drives the hook's tick (step, boundary, commit gate) for a stream whose server flushes
 * `charsPerFlush` characters every `flushMs`, as `useSmoothStreamedText` does per rAF frame.
 */
function simulateStream(input: {
  readonly hz: number;
  readonly durationMs: number;
  readonly flushMs: number;
  readonly charsPerFlush: number;
}) {
  const text = "x".repeat(Math.ceil(input.durationMs / input.flushMs) * input.charsPerFlush);
  const state = createSmoothRevealState(0);
  const commits: number[] = [];
  let emitted = 0;
  let target = 0;
  let nextFlushAt = 0;
  for (let now = 1; now <= input.durationMs || state.shown < target; now += 1_000 / input.hz) {
    while (now >= nextFlushAt && nextFlushAt <= input.durationMs) {
      target = Math.min(text.length, target + input.charsPerFlush);
      nextFlushAt += input.flushMs;
    }
    stepSmoothReveal(state, now, target);
    const nextCount = revealBoundary(text, Math.floor(state.shown));
    if (claimRevealEmit(state, now, nextCount, emitted, target)) {
      emitted = nextCount;
      commits.push(now);
    }
  }
  return { commits, emitted, target };
}

describe("claimRevealEmit", () => {
  it("lets the first commit of a reveal through at once", () => {
    const state = createSmoothRevealState(0);
    expect(claimRevealEmit(state, 1_000, 3, 0, 100)).toBe(true);
    expect(state.lastEmitAt).toBe(1_000);
  });

  it("holds an advanced count until the interval has passed", () => {
    const state = { ...createSmoothRevealState(0), lastEmitAt: 1_000 };
    expect(claimRevealEmit(state, 1_000 + MIN_EMIT_INTERVAL_MS - 1, 10, 5, 100)).toBe(false);
    expect(state.lastEmitAt).toBe(1_000);
    expect(claimRevealEmit(state, 1_000 + MIN_EMIT_INTERVAL_MS, 10, 5, 100)).toBe(true);
    expect(state.lastEmitAt).toBe(1_000 + MIN_EMIT_INTERVAL_MS);
  });

  it("commits the catch-up count inside the interval", () => {
    // The last characters of a burst are never held back by the gate.
    const state = { ...createSmoothRevealState(0), lastEmitAt: 1_000 };
    expect(claimRevealEmit(state, 1_004, 100, 98, 100)).toBe(true);
  });

  it("never commits a count that did not advance", () => {
    const state = createSmoothRevealState(0);
    expect(claimRevealEmit(state, 5_000, 7, 7, 100)).toBe(false);
    expect(state.lastEmitAt).toBe(0);
  });
});

describe("streamed reveal commits", () => {
  // Server flushes every 32 ms (ProviderRuntimeIngestion's delta coalescing) at about 1,250
  // characters a second: a fast model.
  const stream = { durationMs: 3_000, flushMs: 32, charsPerFlush: 40 };

  it.each([60, 120, 240])("commits at most 25 times a second at %i Hz", (hz) => {
    const run = simulateStream({ hz, ...stream });

    expect(run.emitted).toBe(run.target);
    // Every commit but the catch-up one keeps the interval (40 ms, 25 a second).
    expect(MIN_EMIT_INTERVAL_MS).toBe(40);
    for (let index = 1; index < run.commits.length - 1; index += 1) {
      expect(run.commits[index]! - run.commits[index - 1]!).toBeGreaterThanOrEqual(40);
    }
    const seconds = (run.commits.at(-1)! - run.commits[0]!) / 1_000;
    expect(run.commits.length / seconds).toBeLessThanOrEqual(26);
  });

  it("keeps the reveal's finish time: the last commit lands with the last frame", () => {
    const run = simulateStream({ hz: 120, ...stream });
    // The final burst drains within the smoothing window after the last flush.
    expect(run.commits.at(-1)!).toBeLessThan(stream.durationMs + 600);
  });
});
