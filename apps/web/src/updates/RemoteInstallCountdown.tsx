import { useEffect } from "react";

import { setDesktopUpdateState, useDesktopUpdateState } from "../rpc/desktopUpdateAtoms";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  describeRemoteInstallCountdown,
  remoteInstallSecondsLeft,
  selectRemoteInstallCountdown,
} from "./remoteInstallCountdown.logic";

const TICK_MS = 1_000;

function respond(action: "now" | "postpone"): void {
  const bridge = window.desktopBridge;
  if (!bridge) return;
  void bridge
    .respondToRemoteInstall(action)
    .then(setDesktopUpdateState)
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: action === "now" ? "Couldn't restart Ryco" : "Couldn't postpone the update",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
}

/**
 * While another device's "Update everything" counts down to this desktop app's
 * relaunch, one persistent notice shows the seconds left with "Restart now"
 * and "Postpone". It closes as soon as the countdown ends either way. Mount
 * once, in the desktop app only.
 */
export function RemoteInstallCountdown() {
  const countdown = selectRemoteInstallCountdown(useDesktopUpdateState());
  const requestId = countdown?.requestId ?? null;
  const targetVersion = countdown?.targetVersion ?? null;
  const restartAt = countdown?.restartAt ?? null;

  useEffect(() => {
    if (requestId === null || targetVersion === null) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    // However the notice goes (its close button, a swipe, Escape), it stops ticking.
    const stopTicking = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const options = () => {
      const view = describeRemoteInstallCountdown({
        targetVersion,
        secondsLeft: remoteInstallSecondsLeft(restartAt, Date.now()),
      });
      return {
        ...stackedThreadToast({
          type: "info",
          title: view.title,
          description: view.description,
          timeout: 0,
          actionProps: { children: "Restart now", onClick: () => respond("now") },
          data: {
            hideCopyButton: true,
            secondaryActionProps: { children: "Postpone", onClick: () => respond("postpone") },
            secondaryActionVariant: "outline",
          },
        }),
        onClose: stopTicking,
      };
    };
    const toastId = toastManager.add(options());
    timer = setInterval(() => toastManager.update(toastId, options()), TICK_MS);
    return () => {
      stopTicking();
      toastManager.close(toastId);
    };
  }, [requestId, restartAt, targetVersion]);

  return null;
}
