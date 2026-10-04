import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, DesktopHubLaunchConfig } from "@ryco/contracts";

import {
  countActiveDesktopTurns,
  describeActiveDesktopTurns,
} from "../../desktopRelaunchGuard.logic";
import {
  createDesktopRelaunchScheduler,
  type DesktopRelaunchChange,
} from "../../desktopRelaunchScheduler";
import { readPrimaryEnvironmentDescriptor } from "../../environments/primary";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Agent turns on this desktop's own backend; remote environments keep running.
 * `null` until the local environment is known: ask rather than assume none.
 */
function readActiveDesktopTurnCount(): number | null {
  return countActiveDesktopTurns(
    selectSidebarThreadsAcrossEnvironments(useStore.getState()),
    readPrimaryEnvironmentDescriptor()?.environmentId ?? null,
  );
}

function reportRelaunchFailure(error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Ryco could not restart",
      description:
        error instanceof Error
          ? error.message
          : "Your saved change applies the next time Ryco starts.",
    }),
  );
}

let waitingToastId: ReturnType<typeof toastManager.add> | null = null;

/**
 * However the operator dismisses the waiting notice (its close button, a swipe,
 * or Escape), the wait stops. Removing the notice itself is not a dismissal.
 */
function handleWaitingNoticeClosed(): void {
  if (waitingToastId === null) return;
  waitingToastId = null;
  desktopRelaunchScheduler.cancel();
}

async function restartDesktop(): Promise<void> {
  const restartApp = window.desktopBridge?.restartApp;
  if (!restartApp) throw new Error("Desktop restart is unavailable.");
  await restartApp();
}

/** One app-wide relaunch, so a change deferred from one settings page survives leaving it. */
export const desktopRelaunchScheduler = createDesktopRelaunchScheduler({
  readActiveTurns: readActiveDesktopTurnCount,
  subscribe: (listener) => useStore.subscribe(listener),
  restart: restartDesktop,
  present: (waiting) => {
    if (waiting === null) {
      const toastId = waitingToastId;
      waitingToastId = null;
      if (toastId !== null) toastManager.close(toastId);
      return;
    }
    const notice = stackedThreadToast({
      type: "info",
      title: "Ryco restarts when its agents finish",
      description: `${describeActiveDesktopTurns(waiting.activeTurns)}. Your change is saved and applies when Ryco restarts; dismiss this to restart later yourself.`,
      timeout: 0,
      actionProps: {
        children: "Restart now",
        onClick: () => void desktopRelaunchScheduler.relaunchNow().catch(reportRelaunchFailure),
      },
    });
    // The manager's own close callback, unlike the close button's, also runs
    // for a swipe or Escape.
    const options = { ...notice, onClose: handleWaitingNoticeClosed };
    if (waitingToastId === null) waitingToastId = toastManager.add(options);
    else toastManager.update(waitingToastId, options);
  },
  onError: reportRelaunchFailure,
});

export type DesktopRelaunchOutcome = "relaunched" | "scheduled" | "cancelled";

/** The relaunch for changes Desktop has already saved: nothing is left to save. */
export function savedChangeRelaunch(restartApp: () => Promise<void>): DesktopRelaunchChange {
  return async (timing) => {
    if (timing === "now") await restartApp();
  };
}

/** Save a Hub launch change; Desktop relaunches now, or waits when deferred. */
export function hubLaunchChange(
  bridge: Pick<DesktopBridge, "setHubLaunchConfig">,
  input: Omit<Parameters<DesktopBridge["setHubLaunchConfig"]>[0], "deferRelaunch">,
): DesktopRelaunchChange {
  return (timing) =>
    bridge.setHubLaunchConfig(timing === "deferred" ? { ...input, deferRelaunch: true } : input);
}

type GuardRelaunch = (
  change: DesktopRelaunchChange,
  options?: { readonly beforePrompt?: () => void },
) => Promise<DesktopRelaunchOutcome>;

/**
 * Finish account setup when it saved Hub settings the running backend lacks.
 *
 * A standby connector serves account setup in place, so this is normally a
 * no-op. Only a connector the operator had turned off needs a relaunch, and it
 * goes through the same running-turn question as every other relaunch.
 */
export async function relaunchIfHubRestartRequired(input: {
  readonly bridge: Pick<DesktopBridge, "getHubLaunchConfig" | "restartApp">;
  readonly guardRelaunch: GuardRelaunch;
}): Promise<DesktopHubLaunchConfig | null> {
  let config: DesktopHubLaunchConfig;
  try {
    config = await input.bridge.getHubLaunchConfig();
  } catch {
    return null;
  }
  const restartApp = input.bridge.restartApp;
  // Main already saved the change; only the relaunch is left to time.
  if (config.restartRequired === true && restartApp) {
    await input.guardRelaunch(savedChangeRelaunch(restartApp));
  }
  return config;
}

interface PendingRelaunch {
  readonly activeTurns: number | null;
  readonly change: DesktopRelaunchChange;
  readonly resolve: (outcome: DesktopRelaunchOutcome) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Ask before a desktop relaunch would stop running agent turns.
 *
 * `guardRelaunch` applies the change and relaunches at once when nothing is
 * running. Otherwise it asks whether to restart now, save the change and
 * restart once the turns finish, or keep the current configuration. It
 * resolves with what happened and rejects only when the change could not be
 * saved or a relaunch that ran now failed, so callers keep their own error
 * handling.
 * Render `dialog` once in the calling component.
 */
export function useDesktopRelaunchGuard(): {
  readonly guardRelaunch: GuardRelaunch;
  readonly dialog: ReactNode;
} {
  const [pending, setPendingState] = useState<PendingRelaunch | null>(null);
  const [answering, setAnswering] = useState<"now" | "deferred" | null>(null);
  // Event handlers and the unmount cleanup read the question they answer here.
  const pendingRef = useRef<PendingRelaunch | null>(null);
  const setPending = useCallback((next: PendingRelaunch | null) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  // A component that unmounts mid-question has nobody left to answer it.
  useEffect(() => () => pendingRef.current?.resolve("cancelled"), []);

  const guardRelaunch = useCallback(
    async (
      change: DesktopRelaunchChange,
      options?: { readonly beforePrompt?: () => void },
    ): Promise<DesktopRelaunchOutcome> => {
      const activeTurns = readActiveDesktopTurnCount();
      if (activeTurns === 0) {
        await desktopRelaunchScheduler.relaunchNow(change);
        return "relaunched";
      }
      options?.beforePrompt?.();
      return new Promise<DesktopRelaunchOutcome>((resolve, reject) => {
        setPending({ activeTurns, change, resolve, reject });
      });
    },
    [setPending],
  );

  const settle = useCallback(
    (outcome: DesktopRelaunchOutcome) => {
      pendingRef.current?.resolve(outcome);
      setPending(null);
    },
    [setPending],
  );

  const answer = async (timing: "now" | "deferred") => {
    const current = pendingRef.current;
    if (current === null) return;
    setAnswering(timing);
    try {
      if (timing === "now") {
        await desktopRelaunchScheduler.relaunchNow(current.change);
        current.resolve("relaunched");
      } else {
        // Saved before waiting, so quitting or crashing first cannot drop it.
        await desktopRelaunchScheduler.scheduleAfterActiveTurns(current.change);
        current.resolve("scheduled");
      }
    } catch (error) {
      current.reject(error);
    } finally {
      setAnswering(null);
      setPending(null);
    }
  };

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && answering === null) settle("cancelled");
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart while agents are working?</AlertDialogTitle>
          <AlertDialogDescription>
            {pending === null
              ? null
              : `${describeActiveDesktopTurns(pending.activeTurns)} on this computer. Applying this change restarts Ryco, which stops ${pending.activeTurns === 1 ? "it" : "them"}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={answering !== null}
            render={<Button variant="outline" disabled={answering !== null} />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant="outline"
            disabled={answering !== null}
            onClick={() => void answer("deferred")}
          >
            Restart after they finish
          </Button>
          <Button
            variant="destructive"
            disabled={answering !== null}
            onClick={() => void answer("now")}
          >
            {answering === "now" ? "Restarting…" : "Restart now"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return { guardRelaunch, dialog };
}
