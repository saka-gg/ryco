import {
  excludeFromUpdateEverythingPlan,
  type UpdateEverythingItemKey,
} from "@ryco/client-runtime/updates";
import { useRef, useState } from "react";

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
  updateEverythingSelectionSummary,
  updateEverythingSubtitle,
  type UpdateEverythingRunParticipants,
  type UpdateResultTone,
} from "./updateEverything.logic";

const RESULT_TEXT_CLASS: Readonly<Record<UpdateResultTone, string>> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

const NOTHING_EXCLUDED: ReadonlySet<UpdateEverythingItemKey> = new Set();

/**
 * The plan for every connected device and the one button that runs it, with a
 * checkbox on each one-click update to leave it out (all checked whenever the
 * dialog opens). While a run is active (or finished and not dismissed) the same
 * dialog follows each device's live status instead.
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
  const [excluded, setExcluded] = useState(NOTHING_EXCLUDED);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    // A run keeps what it left out on screen; a new plan starts with everything checked.
    if (open && run === null) setExcluded(NOTHING_EXCLUDED);
  }
  const selected = excludeFromUpdateEverythingPlan(plan, excluded);
  const selectionSummary = updateEverythingSelectionSummary(plan, selected);
  const toggleItem = (key: UpdateEverythingItemKey, include: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(key);
      else next.add(key);
      return next;
    });
  };
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
          <DialogDescription>{updateEverythingSubtitle(selected)}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          {entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No devices connected.</p>
          ) : (
            entries.map((entry) => (
              <UpdateDeviceCard
                key={entry.environmentId}
                view={describeDeviceCard(entry, excluded)}
                {...(run === null ? { onToggleItem: toggleItem } : {})}
              />
            ))
          )}
        </DialogPanel>
        <DialogFooter className="sm:items-center">
          {run === null ? (
            <>
              {selectionSummary === null ? null : (
                <p aria-live="polite" className="min-w-0 text-xs text-muted-foreground sm:mr-auto">
                  {selectionSummary}
                </p>
              )}
              <Button ref={initialFocusRef} variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={!selected.hasWork}
                onClick={() =>
                  selectionSummary === null
                    ? controller.start()
                    : controller.start({ exclude: [...excluded] })
                }
              >
                {selectionSummary === null ? "Update all" : "Update selected"}
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
