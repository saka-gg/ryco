/**
 * The supervisor's `subscribeNetworkChange` seam, bound to the mobile
 * lifecycle's `network-changed` (Wi-Fi to cellular and back while online).
 *
 * The lifecycle adapter is imported on first subscribe, so expo-network stays
 * off the launch path; a path change in the first moments after launch is
 * covered by the connect that is still running then.
 */
export function subscribeNetworkPathChange(listener: () => void): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  void import("../platform/appLifecycle")
    .then(({ mobileAppLifecycle }) => {
      if (stopped) return;
      unsubscribe = mobileAppLifecycle.subscribe((event) => {
        if (event === "network-changed") listener();
      });
    })
    .catch((error: unknown) => console.warn("Network path changes are not observed.", error));
  return () => {
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
  };
}
