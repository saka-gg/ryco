import { describe, expect, it } from "vite-plus/test";

import {
  composerShrinkHeld,
  INITIAL_COMPOSER_SHRINK,
  nextComposerShrink,
  type ComposerShrinkScroll,
  type ComposerShrinkState,
} from "./composerShrinkModel";

// A 2000pt chat in a 600pt feed: the end is at offset 1400.
const scroll = (offsetY: number, extra: Partial<ComposerShrinkScroll> = {}) => ({
  offsetY,
  viewportHeight: 600,
  contentHeight: 2000,
  userScrolling: true,
  composerHeight: 110,
  ...extra,
});
const run = (steps: ReadonlyArray<ReturnType<typeof scroll>>, from = INITIAL_COMPOSER_SHRINK) =>
  steps.reduce<ComposerShrinkState>((state, step) => nextComposerShrink(state, step), from);

describe("composer shrink", () => {
  it("shrinks when the reader scrolls back up, far enough from the end", () => {
    expect(run([scroll(1100), scroll(1000)]).collapsed).toBe(true);
  });

  it("stays while the reader scrolls down, or the feed follows new messages", () => {
    expect(run([scroll(900), scroll(1000)]).collapsed).toBe(false);
    expect(
      run([scroll(1100, { userScrolling: false }), scroll(1000, { userScrolling: false })])
        .collapsed,
    ).toBe(false);
  });

  it("ignores jitter and the first event", () => {
    expect(run([scroll(1000)]).collapsed).toBe(false);
    expect(run([scroll(1000), scroll(999)]).collapsed).toBe(false);
  });

  it("does not shrink near the end, where the grown feed would reach it and toggle back", () => {
    // 1400 - 1230 = 170 from the end, under 40 + 110 + 24.
    expect(run([scroll(1240), scroll(1230)]).collapsed).toBe(false);
    expect(run([scroll(1240), scroll(1200)]).collapsed).toBe(true);
  });

  it("comes back at the end and only there", () => {
    const shrunk = run([scroll(1100), scroll(1000)]);
    expect(nextComposerShrink(shrunk, scroll(1200)).collapsed).toBe(true);
    expect(nextComposerShrink(shrunk, scroll(1365)).collapsed).toBe(false);
    expect(nextComposerShrink(shrunk, scroll(1400, { userScrolling: false })).collapsed).toBe(
      false,
    );
  });

  it("keeps the same state object when nothing changed", () => {
    const state = run([scroll(1000)]);
    expect(nextComposerShrink(state, scroll(1000))).toBe(state);
  });

  it("is held while the reader writes, dictates or picks a command", () => {
    const idle = {
      focused: false,
      hasText: false,
      hasAttachments: false,
      dictating: false,
      commandMenuOpen: false,
    };
    expect(composerShrinkHeld(idle)).toBe(false);
    for (const key of Object.keys(idle) as Array<keyof typeof idle>) {
      expect(composerShrinkHeld({ ...idle, [key]: true })).toBe(true);
    }
  });
});
