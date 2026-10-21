import {
  CircleCheckIcon,
  DownloadIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useDelayedUnmount } from "../../hooks/useDelayedUnmount";
import { useEvent } from "../../hooks/useEvent";
import {
  DISCLOSURE_CLEANUP_BUFFER_MS,
  DISCLOSURE_INNER_CLASS,
  DISCLOSURE_TRANSITION_MS,
  disclosureShellClassName,
} from "../../lib/disclosureMotion";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../rpc/desktopUpdateAtoms";
import { useUpdateEverything } from "../../updates/useUpdateEverything";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UpdateEverythingDialog } from "../updates/UpdateEverythingDialog";
import {
  getUpdatePillView,
  updateEverythingPlanKey,
  type UpdatePillIcon,
  type UpdatePillTone,
  type UpdatePillView,
} from "../updates/updateEverything.logic";
import { useProviderUpdatesInProgress } from "../updates/useProviderUpdatesInProgress";
import { useRunParticipants } from "../updates/useRunParticipants";

const PILL_EXIT_MS = DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS;

const PILL_TONE_CLASS: Readonly<Record<UpdatePillTone, string>> = {
  primary: "bg-primary/15 text-primary has-[[data-pill-main]:hover]:bg-primary/22",
  success: "bg-success/12 text-success has-[[data-pill-main]:hover]:bg-success/18",
  warning: "bg-warning/12 text-warning has-[[data-pill-main]:hover]:bg-warning/18",
  error: "bg-destructive/12 text-destructive has-[[data-pill-main]:hover]:bg-destructive/18",
};

const PILL_ICONS: Readonly<Record<UpdatePillIcon, LucideIcon>> = {
  download: DownloadIcon,
  progress: RefreshCwIcon,
  done: CircleCheckIcon,
  problem: TriangleAlertIcon,
};

/**
 * Keeps the last pill on screen while it collapses, and lets a new one mount
 * collapsed for a frame so it grows in: the footer never jumps.
 */
function usePillPresence(view: UpdatePillView | null): {
  readonly shown: UpdatePillView | null;
  readonly open: boolean;
} {
  const signature = view === null ? null : JSON.stringify(view);
  const [retained, setRetained] = useState<{
    readonly signature: string;
    readonly view: UpdatePillView;
  } | null>(null);
  if (view !== null && signature !== null && signature !== retained?.signature) {
    setRetained({ signature, view });
  }
  const mounted = useDelayedUnmount(view !== null, PILL_EXIT_MS);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!mounted) return;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setEntered(false);
    };
  }, [mounted]);
  return {
    shown: mounted ? (view ?? retained?.view ?? null) : null,
    open: view !== null && entered,
  };
}

function UpdatePill({
  view,
  onOpen,
  onDismiss,
}: {
  view: UpdatePillView;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const Icon = PILL_ICONS[view.icon];
  const percent = view.progress === null ? null : Math.round(view.progress * 100);
  return (
    <div data-slot="update-everything-pill" data-kind={view.kind}>
      <div
        className={cn(
          "relative flex h-7 w-full items-center rounded-lg text-xs font-medium transition-colors duration-200",
          PILL_TONE_CLASS[view.tone],
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-pill-main
                aria-label={[view.title, view.countLabel, view.description]
                  .filter((part) => part !== null)
                  .join(". ")}
                aria-haspopup="dialog"
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onOpen}
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0",
                    view.icon === "progress" &&
                      "animate-spin [animation-duration:2s] motion-reduce:animate-none",
                  )}
                />
                <span className="min-w-0 truncate">{view.title}</span>
                {view.count === null ? null : (
                  <span
                    aria-hidden
                    className="ml-auto shrink-0 text-[11px] tabular-nums opacity-75"
                  >
                    {view.count}
                  </span>
                )}
              </button>
            }
          />
          <TooltipPopup side="top">{view.description}</TooltipPopup>
        </Tooltip>
        {view.dismiss === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Dismiss update notice"
                  className="mr-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-60 outline-hidden transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={onDismiss}
                >
                  <XIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">
              {view.dismiss === "plan" ? "Dismiss until something new is available" : "Dismiss"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      {/* Always reserved, so a bar appearing or leaving never moves the footer. */}
      <div
        {...(percent === null
          ? { "aria-hidden": true }
          : {
              role: "progressbar",
              "aria-label": "Update progress",
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": percent,
            })}
        className={cn(
          "mt-1.5 h-[3px] overflow-hidden rounded-full bg-primary/25 transition-opacity duration-200",
          percent === null && "opacity-0",
        )}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The one sidebar entry for updates: "Update everything" with what one click
 * would update, the live run, its outcome, and this app's own download. A click
 * opens the plan dialog.
 */
export function SidebarUpdateEverythingPill() {
  const controller = useUpdateEverything();
  const desktopUpdate = useDesktopUpdateState();
  const providerUpdatesInProgress = useProviderUpdatesInProgress();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissedPlanKey, setDismissedPlanKey] = useState<string | null>(null);
  const participants = useRunParticipants(controller.run);

  const view = getUpdatePillView({
    plan: controller.plan,
    run: controller.run,
    result: controller.result,
    participants,
    desktopUpdate: isElectron ? desktopUpdate : null,
    providerUpdatesInProgress,
    dismissedPlanKey,
  });
  const { shown, open } = usePillPresence(view);

  const dismissRun = useEvent(() => controller.dismissRun());
  const autoDismissMs = view?.autoDismissMs ?? null;
  useEffect(() => {
    if (autoDismissMs === null || dialogOpen) return;
    const timeoutId = window.setTimeout(dismissRun, autoDismissMs);
    return () => window.clearTimeout(timeoutId);
  }, [autoDismissMs, dialogOpen, dismissRun]);

  const dismiss = () => {
    if (view?.dismiss === "plan") setDismissedPlanKey(updateEverythingPlanKey(controller.plan));
    else if (view?.dismiss === "run") controller.dismissRun();
  };

  return (
    <>
      {shown === null ? null : (
        <div
          data-slot="update-everything-pill-area"
          inert={!open}
          className={disclosureShellClassName(open)}
        >
          <div className={DISCLOSURE_INNER_CLASS}>
            <UpdatePill view={shown} onOpen={() => setDialogOpen(true)} onDismiss={dismiss} />
          </div>
        </div>
      )}
      <UpdateEverythingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        controller={controller}
        participants={participants}
      />
    </>
  );
}
