/**
 * The dialog's small controls: lab-sized buttons that stay focusable when
 * off (`aria-disabled`, so the reason can be read), and tooltips.
 */
import type { TooltipRootChangeEventDetails } from "@base-ui/react/tooltip";
import type { AutomationCentreRun } from "@ryco/contracts";
import type { MouseEvent, ReactElement, ReactNode, Ref } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { DialogRow } from "./dialogModel.logic";

/**
 * Everything the list and detail can ask the dialog to do. Each member keeps
 * its identity across renders (the dialog builds them from `useEvent`s), so
 * the object only changes when the dialog's own handlers do.
 */
export interface ScheduleDialogActions {
  readonly edit: (item: DialogRow, focus: "title" | "model") => void;
  readonly pause: (item: DialogRow) => void;
  readonly resume: (item: DialogRow) => void;
  readonly cancel: (item: DialogRow) => void;
  readonly approveRun: (item: DialogRow) => void;
  readonly rejectRun: (item: DialogRow) => void;
  readonly approveProposal: (item: DialogRow) => void;
  readonly rejectProposal: (item: DialogRow) => void;
  readonly repropose: (item: DialogRow, origin: HTMLElement) => void;
  readonly dismissLapsed: (item: DialogRow) => void;
  readonly retry: (item: DialogRow, entry: AutomationCentreRun) => void;
  readonly setUnread: (item: DialogRow, entry: AutomationCentreRun, unread: boolean) => void;
  readonly openThread: (item: DialogRow, entry: AutomationCentreRun) => void;
  readonly toggleHistory: (key: string) => void;
  readonly togglePrompt: (key: string) => void;
  readonly focusRun: (key: string, runId: string) => void;
}

/**
 * Tips are passive, like the lab's: one shown on keyboard focus never takes
 * the Escape meant for the layer under it (the editor, then the dialog). It
 * still hides, and the key goes on.
 */
function passEscapeThrough(open: boolean, details: TooltipRootChangeEventDetails) {
  if (!open && details.reason === "escape-key") details.allowPropagation();
}

/** A tooltip around one control; no label, no tooltip. */
export function Tip(props: {
  readonly label: string | null | undefined;
  readonly children: ReactElement;
  readonly side?: "top" | "bottom";
}) {
  if (!props.label) return props.children;
  return (
    <Tooltip onOpenChange={passEscapeThrough}>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side={props.side ?? "bottom"}>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

type Tone = "plain" | "primary" | "quiet";

/**
 * A lab button: `plain` (hairline), `primary` (filled) or `quiet` (ghost,
 * muted until hovered); `sm` or `xs`. Off with a reason, it stays focusable
 * and says why.
 */
export function DialogButton({
  ref,
  ...props
}: {
  readonly ref?: Ref<HTMLButtonElement> | undefined;
  readonly tone?: Tone | undefined;
  readonly size?: "sm" | "xs" | undefined;
  readonly icon?: boolean | undefined;
  /** Off but focusable (`aria-disabled`). */
  readonly off?: boolean | undefined;
  readonly offReason?: string | null | undefined;
  /** Really disabled (out of the tab order). */
  readonly disabled?: boolean | undefined;
  readonly tip?: string | null | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
  readonly onAction: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly ariaLabel?: string | undefined;
  readonly ariaDescribedBy?: string | undefined;
  readonly ariaDescription?: string | undefined;
  readonly ariaHasPopup?: "menu" | "dialog" | undefined;
  /** The control's shortcut for assistive tech ("E", "Meta+Enter Control+Enter"). */
  readonly ariaKeyShortcuts?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly dataAct?: string | undefined;
}) {
  const tone = props.tone ?? "plain";
  const off = props.off === true || !!props.offReason;
  const button = (
    <Button
      ref={ref}
      variant={tone === "primary" ? "default" : tone === "quiet" ? "ghost" : "outline"}
      size={props.icon ? (props.size === "xs" ? "icon-xs" : "icon-sm") : (props.size ?? "sm")}
      className={cn(
        "ad-btn",
        props.size === "xs" && "ad-btn-xs",
        props.icon && "ad-btn-icon",
        tone === "quiet" && "ad-btn-quiet",
        props.className,
      )}
      disabled={props.disabled}
      aria-disabled={off || undefined}
      aria-label={props.ariaLabel}
      aria-describedby={props.ariaDescribedBy}
      aria-description={props.ariaDescription}
      aria-haspopup={props.ariaHasPopup}
      aria-keyshortcuts={props.ariaKeyShortcuts}
      tabIndex={props.tabIndex}
      data-act={props.dataAct}
      onClick={(event) => {
        if (off) return;
        props.onAction(event);
      }}
    >
      {props.children}
    </Button>
  );
  return <Tip label={props.offReason ?? props.tip}>{button}</Tip>;
}
