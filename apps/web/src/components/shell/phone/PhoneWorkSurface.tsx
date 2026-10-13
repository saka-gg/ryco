import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode } from "react";

import { resolveInactivePanelContentVisibilityStyle } from "../../../lib/perf/motion";
import { Button } from "../../ui/button";
import { Sheet, SheetPopup } from "../../ui/sheet";

/**
 * Full-screen phone work-surface presentation (L3 of the phone navigation
 * stack). The popup covers the entire viewport — including the thread app bar
 * and composer — so the surface's own bar is the app bar while it is open.
 * The bottom padding composes the safe-area inset with the keyboard inset
 * published by the visual-viewport adapter, keeping surface content (for
 * example the terminal toolbar) above an open software keyboard.
 */
const PHONE_WORK_SURFACE_CLASS_NAME =
  "w-full min-w-0 max-w-none border-s-0 p-0 pt-[env(safe-area-inset-top)] pl-safe pr-safe pb-[max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px))] wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

/**
 * Full-screen pushed surface over the thread on the phone tier. Mirrors the
 * `RightPanelSheet` contract (kept mounted, content-visibility gated) so panel
 * state — terminal sessions, opened tabs — survives close/reopen exactly like
 * the desktop sheet presentation. Closing always goes through `onClose`
 * (router navigation clearing the panel search params), never local state, so
 * browser history exits the surface before exiting the thread.
 */
export function PhoneWorkSurfaceSheet(props: {
  children: ReactNode;
  label: string;
  open: boolean;
  onClose: () => void;
}) {
  const panelContentVisibilityStyle = resolveInactivePanelContentVisibilityStyle({
    active: props.open,
    containIntrinsicSize: "100vw 100vh",
  });

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        aria-label={props.label}
        className={PHONE_WORK_SURFACE_CLASS_NAME}
      >
        <div className="flex min-h-0 w-full flex-1" style={panelContentVisibilityStyle}>
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

/**
 * Full-screen phone surface for panels that carry no surface bar of their own
 * (currently the overview panel): back affordance to the thread plus a bounded
 * title, consistent with the workspace surface bar.
 */
export function PhoneSurfaceScaffold(props: {
  title: string;
  backLabel: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-card/40 px-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label={props.backLabel}
          className="shrink-0"
          onClick={props.onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</p>
      </div>
      <div className="flex min-h-0 w-full min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

/**
 * The thread overview as a phone work surface: `PhoneWorkSurfaceSheet` around
 * `PhoneSurfaceScaffold`, one component so ChatView can load both lazily.
 */
export function PhoneOverviewSheet(props: {
  children: ReactNode;
  label: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <PhoneWorkSurfaceSheet label={props.label} open={props.open} onClose={props.onClose}>
      <PhoneSurfaceScaffold title={props.label} backLabel="Back to thread" onBack={props.onClose}>
        {props.children}
      </PhoneSurfaceScaffold>
    </PhoneWorkSurfaceSheet>
  );
}
