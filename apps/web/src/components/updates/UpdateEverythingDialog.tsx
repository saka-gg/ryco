import { useRef } from "react";

import type { UpdateEverythingController } from "../../updates/useUpdateEverything";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { UpdateDeviceCard } from "./UpdateDeviceCard";
import {
  describeDeviceCard,
  describeRunResult,
  isRunActive,
  runProgress,
  UPDATE_EVERYTHING_TITLE,
  updateEverythingDeviceEntries,
  updateEverythingSubtitle,
  type UpdateEverythingRunParticipants,
  type UpdateResultTone,
} from "./updateEverything.logic";

const RESULT_TEXT_CLASS: Readonly<Record<UpdateResultTone, string>> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

/**
 * The plan for every connected device and the one button that runs it. While a
 * run is active (or finished and not dismissed) the same dialog follows each
 * device's live status instead.
 */
export function UpdateEverythingDialog({
  open,
  onOpenChange,
  controller,
  participants = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: UpdateEverythingController;
  /** The devices the run set out to update, when the caller follows them (see the pill). */
  participants?: UpdateEverythingRunParticipants | null;
}) {
  const { plan, run } = controller;
  const entries = updateEverythingDeviceEntries(plan, run);
  const active = isRunActive(run);
  const progress = run !== null && active ? runProgress(run, participants) : null;
  const outcome = run !== null && !active ? describeRunResult(controller.result) : null;
  // The way out, never "Update all": Enter on a focused primary would restart
  // nodes without a look at the plan (and a copy button would pop its tooltip).
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" initialFocus={initialFocusRef}>
        <DialogHeader>
          <DialogTitle>{UPDATE_EVERYTHING_TITLE}</DialogTitle>
          <DialogDescription>{updateEverythingSubtitle(plan)}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          {entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No devices connected.</p>
          ) : (
            entries.map((entry) => (
              <UpdateDeviceCard key={entry.environmentId} view={describeDeviceCard(entry)} />
            ))
          )}
        </DialogPanel>
        <DialogFooter className="sm:items-center">
          {run === null ? (
            <>
              <Button ref={initialFocusRef} variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!plan.hasWork} onClick={() => controller.start()}>
                Update all
              </Button>
            </>
          ) : (
            <>
              <p
                aria-live="polite"
                className={cn(
                  "min-w-0 text-xs sm:mr-auto",
                  outcome ? RESULT_TEXT_CLASS[outcome.tone] : "text-muted-foreground",
                )}
              >
                {progress
                  ? `${progress.done} of ${progress.total} done`
                  : (outcome?.title ?? "Finished")}
              </p>
              {active ? (
                <Button ref={initialFocusRef} variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              ) : (
                <Button
                  ref={initialFocusRef}
                  onClick={() => {
                    controller.dismissRun();
                    onOpenChange(false);
                  }}
                >
                  Done
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
