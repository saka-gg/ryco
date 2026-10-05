/** Wait through hidden transitions until the browser can run foreground work. */
export function subscribeWebForeground(listener: () => void): () => void {
  const document = globalThis.document;
  const onVisibility = () => {
    if (document?.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisibility);
    listener();
  };
  document?.addEventListener("visibilitychange", onVisibility);
  return () => document?.removeEventListener("visibilitychange", onVisibility);
}
