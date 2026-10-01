import { useEffect } from "react";

import { hostedHubController, useHostedHubStore } from "./state";
import { setHostedWorkspaceBackgrounded } from "./hostedConnectionCoordinator";

/**
 * The single hosted browser lifecycle wiring: visibilitychange / offline /
 * online / pageshow drive `suspendBrowser` / `resumeBrowser` while the hosted
 * account is authenticated. Mounted exactly once at the hosted root, above the
 * presentation-tier seam, so it stays active for every authenticated hosted
 * state — including the pre-session directory, recovery-code, connecting, and
 * failure surfaces — and is unaffected by tier changes. The tier shells mount
 * no lifecycle listeners of their own.
 */
export function useHostedBrowserLifecycle(): void {
  const accountStatus = useHostedHubStore((state) => state.accountStatus);

  useEffect(() => {
    if (accountStatus !== "authenticated" && accountStatus !== "unavailable") return;
    const resumeIfVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        if (accountStatus === "unavailable") {
          void hostedHubController.bootstrap();
          return;
        }
        void hostedHubController.resumeBrowser().then(() => setHostedWorkspaceBackgrounded(false));
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        void setHostedWorkspaceBackgrounded(true);
        hostedHubController.suspendBrowser("hidden");
      } else resumeIfVisible();
    };
    const onOffline = () => {
      void setHostedWorkspaceBackgrounded(true);
      hostedHubController.suspendBrowser("offline");
    };
    const onOnline = () => resumeIfVisible();
    const onPageShow = () => resumeIfVisible();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    if (!navigator.onLine) onOffline();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [accountStatus]);
}
