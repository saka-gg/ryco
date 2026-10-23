import {
  STOP_BACKGROUND_WORK_CONFIRM_LABEL,
  STOP_BACKGROUND_WORK_TITLE,
  describeModelSwitchBlockedByBackgroundWork,
  type CommitSendTurnDispatchInput,
} from "@ryco/client-runtime/state/composer";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { mountDialog } from "./mountDialog";

/**
 * The "Stop tasks and switch" choice of a send whose model switch the
 * thread's background tasks hold back. Dismissing the dialog cancels.
 */
export const confirmStopBackgroundWorkDialog: NonNullable<
  CommitSendTurnDispatchInput["confirmStopBackgroundWork"]
> = (blocked) =>
  new Promise((resolve) => {
    mountDialog((close) => {
      const choose = (stop: boolean) => {
        resolve(stop);
        close();
      };
      return (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) choose(false);
          }}
        >
          <DialogPopup bottomStickOnMobile={false}>
            <div className="space-y-4 p-6">
              <DialogTitle>{STOP_BACKGROUND_WORK_TITLE}</DialogTitle>
              <DialogDescription>
                {describeModelSwitchBlockedByBackgroundWork(blocked)}
              </DialogDescription>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => choose(true)}>{STOP_BACKGROUND_WORK_CONFIRM_LABEL}</Button>
                <Button variant="ghost" onClick={() => choose(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </DialogPopup>
        </Dialog>
      );
    });
  });
