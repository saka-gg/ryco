import { bindClientVisibility } from "@ryco/client-runtime/rpc";

let bound = false;

/**
 * Tells connected nodes when the app goes to the background (and back), so they hold terminal
 * output nobody can see while the connection stays open for a moment. The lifecycle adapter is
 * imported on first use, so expo-network stays off the launch path.
 */
export function bindMobileClientVisibility(): void {
  if (bound) return;
  bound = true;
  void import("../platform/appLifecycle")
    .then(({ mobileAppLifecycle }) => {
      bindClientVisibility(mobileAppLifecycle);
    })
    .catch((error: unknown) => console.warn("App visibility is not reported to nodes.", error));
}
