// Adapted from pingdotgg/t3code commit 6577c6b6 (MIT); see THIRD_PARTY_NOTICES.md.

/**
 * Renders at most once per display frame, and only when something asked for
 * it: a new video frame, motion still settling, or a resize. A still device
 * costs nothing between frames.
 */
export function createRenderScheduler(
  render: () => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let pending: number | null = null;
  let disposed = false;
  return {
    invalidate() {
      if (disposed || pending !== null) return;
      pending = request(() => {
        pending = null;
        if (!disposed) render();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
