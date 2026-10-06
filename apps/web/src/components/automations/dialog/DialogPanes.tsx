/**
 * The detail column's quieter panes: an empty project, a project whose
 * devices can't be read, and the bar that keeps a discarded draft one click
 * (or ⌘Z) away until the next edit starts.
 */
import { CalendarClockIcon, CircleAlertIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback } from "react";

import { isMacPlatform } from "../../../lib/utils";
import { DialogButton } from "./dialogControls";
import { DIALOG_EASE, dialogMotionOn } from "./paneMotion";

/** The empty state's "New schedule": default focus, and where a new draft folds back. */
export const EMPTY_NEW_SELECTOR = '.ad-empty [data-act="new"]';

export function EmptyProjectState(props: {
  readonly projectName: string;
  /** The checkout path a schedule runs in ("~/Code/ryco"). */
  readonly path: string | null;
  readonly newOff: boolean;
  readonly newOffReason: string | null;
  readonly onNew: (origin: HTMLElement) => void;
}) {
  return (
    <div className="ad-empty">
      <span className="ad-empty-ic" aria-hidden="true">
        <CalendarClockIcon />
      </span>
      <h3>No schedules in {props.projectName}</h3>
      <p>
        A schedule runs a prompt in <span className="ad-path">{props.path ?? "this checkout"}</span>{" "}
        at the times you pick. Every run waits for your approval before it starts a thread.
      </p>
      <DialogButton
        tone="primary"
        off={props.newOff}
        offReason={props.newOffReason}
        ariaKeyShortcuts="N"
        dataAct="new"
        onAction={(event) => props.onNew(event.currentTarget)}
      >
        <PlusIcon />
        New schedule
      </DialogButton>
    </div>
  );
}

/** No device of the project could be read. */
export function UnavailableState(props: { readonly message: string }) {
  return (
    <div className="ad-empty" role="status">
      <span className="ad-empty-ic" aria-hidden="true">
        <CircleAlertIcon />
      </span>
      <h3>Automations are unavailable</h3>
      <p>{props.message}</p>
    </div>
  );
}

/** After a discard: recovery stays inside the dialog, reachable by Tab (and ⌘Z). */
export function UndoBar(props: { readonly onRestore: () => void; readonly onDismiss: () => void }) {
  const enter = useCallback((node: HTMLDivElement | null) => {
    if (!node || !dialogMotionOn()) return;
    node.animate(
      [
        { opacity: 0, translate: "0 6px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: 220, easing: DIALOG_EASE },
    );
  }, []);
  const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  return (
    <div ref={enter} className="ad-undo" role="status">
      <span>Draft discarded.</span>
      <button
        type="button"
        className="ad-link"
        data-act="restore"
        aria-keyshortcuts="Meta+Z Control+Z"
        onClick={props.onRestore}
      >
        Restore
      </button>
      <kbd aria-hidden="true">{mac ? "⌘Z" : "Ctrl Z"}</kbd>
      <span className="ad-sp" />
      <DialogButton
        tone="quiet"
        size="xs"
        icon
        ariaLabel="Dismiss"
        dataAct="undo-dismiss"
        onAction={props.onDismiss}
      >
        <XIcon />
      </DialogButton>
    </div>
  );
}
