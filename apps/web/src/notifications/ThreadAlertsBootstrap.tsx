import type { ScopedThreadRef } from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { visiblePaneThreads } from "../chatPanes.logic";
import { useChatPanesStore } from "../chatPanesStore";
import {
  stackedThreadToast,
  toastManager,
  useActiveThreadRefFromRoute,
} from "../components/ui/toast";
import { readThreadNotificationSource } from "../environments/runtime";
import {
  addClientSettingsHydrationListener,
  addClientSettingsListener,
  getClientSettingsHydratedSnapshot,
  getClientSettingsSnapshot,
} from "../hooks/clientSettingsStore";
import { scheduleIdleTask } from "../lib/idleTask";
import { getPresentationTier } from "../lib/presentationTier";
import { selectEnvironmentState, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { ThreadAlerts } from "./threadAlerts";

const THREAD_ALERTS_IDLE_TIMEOUT_MS = 2_000;

/**
 * Starts thread alerts once the shell is idle. The alerts load lazily; this
 * only hands them the app's singletons, and they wait for client settings to
 * load, so a saved Off never alerts. Desktop notification clicks are routed
 * here, for as long as the shell is mounted.
 */
export function ThreadAlertsBootstrap() {
  const router = useRouter();
  const routeThreadRef = useActiveThreadRefFromRoute();
  const paneRoot = useChatPanesStore((state) => state.root);
  const visibleThreadRefs = useMemo(
    () => visiblePaneThreads(paneRoot, routeThreadRef),
    [paneRoot, routeThreadRef],
  );
  const visibleThreadRefsRef = useRef(visibleThreadRefs);
  const alertsRef = useRef<ThreadAlerts | null>(null);

  const navigateToThread = useCallback(
    (ref: ScopedThreadRef) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
    },
    [router],
  );

  // A thread that comes on screen answers its own toast.
  useEffect(() => {
    visibleThreadRefsRef.current = visibleThreadRefs;
    alertsRef.current?.syncVisibleThreads();
  }, [visibleThreadRefs]);

  useEffect(() => {
    let disposed = false;
    const cancelIdleStart = scheduleIdleTask(() => {
      void import("./threadAlerts")
        .then(({ startThreadAlerts }) => {
          if (disposed) return;
          alertsRef.current = startThreadAlerts({
            source: readThreadNotificationSource(),
            readEnvironmentThreads: (environmentId) =>
              Object.values(
                selectEnvironmentState(useStore.getState(), environmentId).sidebarThreadSummaryById,
              ),
            isThreadSnoozed,
            readSettings: () =>
              getClientSettingsHydratedSnapshot() ? getClientSettingsSnapshot() : null,
            subscribeSettings: (listener) => {
              const unsubscribeChanges = addClientSettingsListener(listener);
              const unsubscribeHydration = addClientSettingsHydrationListener(listener);
              return () => {
                unsubscribeChanges();
                unsubscribeHydration();
              };
            },
            toastManager,
            stackedThreadToast,
            navigateToThread,
            readVisibleThreadRefs: () => visibleThreadRefsRef.current,
            isPhoneTier: () => getPresentationTier() === "phone",
          });
        })
        .catch((error: unknown) => console.warn("Thread alerts failed to load.", error));
    }, THREAD_ALERTS_IDLE_TIMEOUT_MS);
    return () => {
      disposed = true;
      cancelIdleStart();
      alertsRef.current?.stop();
      alertsRef.current = null;
    };
  }, [navigateToThread]);

  // The main process reveals the window; the renderer opens the thread.
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onTurnCompleteNotificationActivated) return;
    return bridge.onTurnCompleteNotificationActivated((notification) => {
      if (!notification.environmentId) return;
      navigateToThread(scopeThreadRef(notification.environmentId, notification.threadId));
    });
  }, [navigateToThread]);

  return null;
}
