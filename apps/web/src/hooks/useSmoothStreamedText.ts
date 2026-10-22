// FILE: useSmoothStreamedText.ts
// Purpose: Reveal streamed assistant text at a steady, adaptive cadence so tokens appear
//          fluidly instead of in the network clumps that land in the store.
// Layer: Web UI streaming primitive
// Exports: useSmoothStreamedText, revealBoundary, stepSmoothReveal, createSmoothRevealState
// Why: Provider deltas reach the store in bursts, so rendering each clump verbatim reads
//      as choppy. This hook drains the already-delivered buffer on requestAnimationFrame
//      at a velocity that adapts to the backlog, low-pass-smooths that velocity so there
//      are no jarring speed jumps, and sleeps between bursts once it catches up. It feeds
//      the text ChatMarkdown already throttles, so markdown re-parse stays coalesced:
//      this hook governs *cadence*, not parse cost.

import { useCallback, useEffect, useRef, useState } from "react";

import { useMediaQuery } from "./useMediaQuery";

// Drain the current backlog over this window. Kept above the network flush interval so a
// small backlog cushion always remains and the reveal tracks inflow without running dry.
const DRAIN_WINDOW_SECONDS = 0.16;
// Hard ceiling so a single huge flush (e.g. a pasted code block) reveals fast but bounded
// rather than snapping in all at once.
const MAX_CHARS_PER_SECOND = 2000;
// Low-pass factor: how aggressively the live velocity chases the target velocity each
// frame. Smaller is smoother but laggier; ~0.15 ≈ a ~110ms time constant at 60fps.
const VELOCITY_LERP = 0.15;
// Clamp per-frame delta so returning from a backgrounded tab (rAF paused) does not dump
// the whole backlog in a single frame.
const MAX_FRAME_SECONDS = 0.05;
// A remainder below this many characters snaps onto the target. Far below one visible
// character, so the reveal cadence is unchanged, but it lets the loop settle and sleep.
const SETTLE_REMAINDER_CHARS = 0.001;

/**
 * Mutable reveal state, owned by the hook through a ref. The stepper mutates it in place
 * so the rAF loop allocates nothing per frame.
 */
export interface SmoothRevealState {
  /** Revealed character count, accumulated as a float across frames. */
  shown: number;
  /** Smoothed reveal velocity in characters per second. */
  velocity: number;
  /** Timestamp (ms) of the previous frame; 0 marks the start of a fresh burst. */
  lastFrameAt: number;
}

export function createSmoothRevealState(shown: number): SmoothRevealState {
  return { shown, velocity: 0, lastFrameAt: 0 };
}

/**
 * Advances the reveal by one animation frame toward `targetLength`, mutating `state`.
 *
 * Returns true while a backlog remains and another frame is needed. Once caught up it
 * resets the velocity and frame clock and returns false, so the loop sleeps until the
 * next flush wakes it.
 */
export function stepSmoothReveal(
  state: SmoothRevealState,
  nowMs: number,
  targetLength: number,
): boolean {
  const previous = state.lastFrameAt;
  const dt = previous ? Math.min((nowMs - previous) / 1000, MAX_FRAME_SECONDS) : 0;
  state.lastFrameAt = nowMs;

  if (state.shown > targetLength) {
    state.shown = targetLength;
  }

  const backlog = targetLength - state.shown;
  if (backlog > 0) {
    const targetVelocity = Math.min(MAX_CHARS_PER_SECOND, backlog / DRAIN_WINDOW_SECONDS);
    state.velocity += (targetVelocity - state.velocity) * VELOCITY_LERP;
    const next = Math.min(targetLength, state.shown + state.velocity * dt);
    // At high refresh rates the damped tail approaches the target without reaching it
    // until the step drops below float precision, leaving the last character hidden and
    // rAF running every frame. Settle a sub-character remainder, or a step that no longer
    // moves the float, onto the target.
    const stalled = dt > 0 && next === state.shown;
    state.shown = stalled || targetLength - next < SETTLE_REMAINDER_CHARS ? targetLength : next;
  }

  if (targetLength - state.shown > 0) {
    return true;
  }
  state.velocity = 0;
  state.lastFrameAt = 0;
  return false;
}

/**
 * Pulls a reveal position back off the seam of a surrogate pair.
 *
 * Astral characters (emoji, many CJK extensions) occupy two UTF-16 units, and
 * slicing between them renders U+FFFD. The reveal can sit on one position for
 * several frames when the backlog is small, so the broken glyph would be
 * visible rather than instantaneous.
 *
 * This deliberately stops at code points rather than grapheme clusters:
 * splitting a ZWJ sequence briefly shows a valid, complete emoji, whereas
 * segmenting the whole string every frame would be O(n) on a hot path.
 */
export function revealBoundary(text: string, count: number): number {
  if (count <= 0 || count >= text.length) {
    return count;
  }
  const previous = text.charCodeAt(count - 1);
  const isHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  return isHighSurrogate ? count - 1 : count;
}

/**
 * Smoothly reveal `text` while `isStreaming` is true.
 *
 * - Returns `text` unchanged when not streaming or under prefers-reduced-motion, so
 *   completed messages and reduced-motion users see the exact text with zero animation.
 * - Snaps to the full text the instant streaming ends (no trailing typewriter once the
 *   agent is done), and whenever the text changes in a non-append way (e.g. a rewrite).
 * - Text already present on mount is shown immediately; only newly-arriving deltas animate.
 */
export function useSmoothStreamedText(text: string, isStreaming: boolean): string {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const animate = isStreaming && !reduceMotion;

  const [revealed, setRevealed] = useState(text);

  // Latest full text, mirrored post-commit so the rAF loop always reads the current value
  // without re-subscribing the animation effect on every delta.
  const targetRef = useRef(text);
  const revealRef = useRef(createSmoothRevealState(text.length));
  // Character count last pushed to React state — guards against redundant setState when the
  // floored count has not advanced.
  const emittedRef = useRef(text.length);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<(now: number) => void>(() => undefined);

  const cancelFrame = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const scheduleFrame = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = requestAnimationFrame((now) => {
      rafRef.current = null;
      tickRef.current(now);
    });
  }, []);

  // Installed in an effect rather than during render; the tick reads everything
  // through refs, so a mount-time install stays permanently fresh.
  useEffect(() => {
    tickRef.current = (now: number) => {
      const target = targetRef.current;
      const pending = stepSmoothReveal(revealRef.current, now, target.length);

      const nextCount = revealBoundary(target, Math.floor(revealRef.current.shown));
      if (nextCount !== emittedRef.current) {
        emittedRef.current = nextCount;
        setRevealed(nextCount >= target.length ? target : target.slice(0, nextCount));
      }

      // Sleep once caught up; the text-update effect wakes the loop on the next flush.
      if (pending) {
        scheduleFrame();
      }
    };
  }, [scheduleFrame]);

  useEffect(() => {
    const previousTarget = targetRef.current;
    const isAppendOnly = text.length >= previousTarget.length && text.startsWith(previousTarget);
    targetRef.current = text;

    if (!animate || !isAppendOnly) {
      cancelFrame();
      revealRef.current = createSmoothRevealState(text.length);
      emittedRef.current = text.length;
      setRevealed(text);
      return;
    }

    if (text.length > revealRef.current.shown) {
      scheduleFrame();
    }
  }, [animate, cancelFrame, scheduleFrame, text]);

  useEffect(() => cancelFrame, [cancelFrame]);

  return animate ? revealed : text;
}
