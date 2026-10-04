import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, DesktopHubLaunchConfig } from "@ryco/contracts";

import {
  countActiveDesktopTurns,
  describeActiveDesktopTurns,
} from "../../desktopRelaunchGuard.logic";
import {
  createDesktopRelaunchScheduler,
  type DesktopRelaunch,
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

/** Agent turns on this desktop's own backend; remote environments keep running. */
function readActiveDesktopTurnCount(): number {
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
      description: error instanceof Error ? error.message : "The change was not applied.",
    }),
  );
}

let waitingToastId: ReturnType<typeof toastManager.add> | null = null;

/** One app-wide queue, so a change deferred from one settings page survives leaving it. */
export const desktopRelaunchScheduler = createDesktopRelaunchScheduler({
  readActiveTurns: readActiveDesktopTurnCount,
  subscribe: (listener) => useStore.subscribe(listener),
  present: (waiting) => {
    if (waiting === null) {
      if (waitingToastId !== null) toastManager.close(waitingToastId);
      waitingToastId = null;
      return;
    }
    const options = stackedThreadToast({
      type: "info",
      title: "Ryco restarts when its agents finish",
      description: `${describeActiveDesktopTurns(waiting.activeTurns)}. Your change applies with the restart; dismiss this to cancel it.`,
      timeout: 0,
      actionProps: {
        children: "Restart now",
        onClick: () => void desktopRelaunchScheduler.relaunchNow().catch(reportRelaunchFailure),
      },
      data: { onClose: () => desktopRelaunchScheduler.cancel() },
    });
    if (waitingToastId === null) waitingToastId = toastManager.add(options);
    else toastManager.update(waitingToastId, options);
  },
  onError: reportRelaunchFailure,
});

export type DesktopRelaunchOutcome = "relaunched" | "scheduled" | "cancelled";

type GuardRelaunch = (
  relaunch: DesktopRelaunch,
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
  if (config.restartRequired === true && restartApp) await input.guardRelaunch(restartApp);
  return config;
}

interface PendingRelaunch {
  readonly activeTurns: number;
  readonly relaunch: DesktopRelaunch;
  readonly resolve: (outcome: DesktopRelaunchOutcome) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Ask before a desktop relaunch would stop running agent turns.
 *
 * `guardRelaunch` runs the relaunch at once when nothing is running. Otherwise
 * it asks whether to restart now, restart once the turns finish, or keep the
 * current configuration. It resolves with what happened and rejects only when
 * a relaunch that ran now failed, so callers keep their own error handling.
 * Render `dialog` once in the calling component.
 */
export function useDesktopRelaunchGuard(): {
  readonly guardRelaunch: GuardRelaunch;
  readonly dialog: ReactNode;
} {
  const [pending, setPendingState] = useState<PendingRelaunch | null>(null);
  const [restarting, setRestarting] = useState(false);
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
      relaunch: DesktopRelaunch,
      options?: { readonly beforePrompt?: () => void },
    ): Promise<DesktopRelaunchOutcome> => {
      const activeTurns = readActiveDesktopTurnCount();
      if (activeTurns === 0) {
        await desktopRelaunchScheduler.relaunchNow(relaunch);
        return "relaunched";
      }
      options?.beforePrompt?.();
      return new Promise<DesktopRelaunchOutcome>((resolve, reject) => {
        setPending({ activeTurns, relaunch, resolve, reject });
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

  const restartNow = async () => {
    const current = pendingRef.current;
    if (current === null) return;
    setRestarting(true);
    try {
      await desktopRelaunchScheduler.relaunchNow(current.relaunch);
      current.resolve("relaunched");
    } catch (error) {
      current.reject(error);
    } finally {
      setRestarting(false);
      setPending(null);
    }
  };

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !restarting) settle("cancelled");
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
            disabled={restarting}
            render={<Button variant="outline" disabled={restarting} />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant="outline"
            disabled={restarting}
            onClick={() => {
              const current = pendingRef.current;
              if (current === null) return;
              desktopRelaunchScheduler.scheduleAfterActiveTurns(current.relaunch);
              settle("scheduled");
            }}
          >
            Restart after they finish
          </Button>
          <Button variant="destructive" disabled={restarting} onClick={() => void restartNow()}>
            {restarting ? "Restarting…" : "Restart now"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return { guardRelaunch, dialog };
}
