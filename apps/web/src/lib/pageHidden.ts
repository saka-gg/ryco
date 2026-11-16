/**
 * Calls flush when the page is hidden or being left; beforeunload is not delivered reliably when a
 * phone browser backgrounds or discards a page.
 */
export function subscribePageHidden(flush: () => void): () => void {
  const onVisibilityChange = () => {
    if (globalThis.document?.visibilityState === "hidden") flush();
  };
  globalThis.window?.addEventListener?.("pagehide", flush);
  globalThis.document?.addEventListener?.("visibilitychange", onVisibilityChange);
  return () => {
    globalThis.window?.removeEventListener?.("pagehide", flush);
    globalThis.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
  };
}
