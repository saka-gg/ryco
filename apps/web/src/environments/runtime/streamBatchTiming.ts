/**
 * When a stream batch (thread-detail events, shell items) commits to the store.
 *
 * A visible document commits once per animation frame. A hidden one paints
 * nothing and runs no frames, so it commits on a timer instead, long enough to
 * fold a streaming thread's ~30 deltas a second into a couple of commits. The
 * frame callback stays queued while hidden: the browser runs it on the first
 * frame after the document becomes visible again, before that frame paints, so
 * a returning user never sees the stale state. Any other store write applies
 * the buffer first (the batcher is a store mutation barrier).
 */
import { webFrameScheduler } from "../../platform";

/** A visible document's fallback when no frame runs (as the shared batcher's default). */
export const VISIBLE_STREAM_BATCH_FALLBACK_MS = 100;
/**
 * A hidden document's commit interval. Browsers align hidden-page timers to
 * whole seconds, so anything up to 1 s costs no extra wake-ups.
 */
export const HIDDEN_STREAM_BATCH_DELAY_MS = 500;

function documentIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Frame callbacks a hidden document holds for its next visible frame. Each
 * batcher's run is superseded by its next one (an older run finds nothing to
 * apply), so only the most recent few are kept rather than one per batch for
 * as long as the document stays hidden.
 */
const HIDDEN_FRAME_CALLBACKS_KEPT = 8;
let hiddenFrameCallbacks: Array<() => void> = [];
let hiddenFrameRequested = false;

export function scheduleStreamBatchFrame(callback: () => void): void {
  if (!documentIsHidden()) {
    webFrameScheduler.scheduleFrame(callback);
    return;
  }
  hiddenFrameCallbacks.push(callback);
  if (hiddenFrameCallbacks.length > HIDDEN_FRAME_CALLBACKS_KEPT) hiddenFrameCallbacks.shift();
  if (hiddenFrameRequested) return;
  hiddenFrameRequested = true;
  webFrameScheduler.scheduleFrame(() => {
    hiddenFrameRequested = false;
    const due = hiddenFrameCallbacks;
    hiddenFrameCallbacks = [];
    for (const run of due) run();
  });
}

export function readStreamBatchFallbackDelayMs(): number {
  return documentIsHidden() ? HIDDEN_STREAM_BATCH_DELAY_MS : VISIBLE_STREAM_BATCH_FALLBACK_MS;
}

/** Drops held frame callbacks and the pending request (tests replace the frame scheduler). */
export function resetStreamBatchTimingForTests(): void {
  hiddenFrameCallbacks = [];
  hiddenFrameRequested = false;
}
