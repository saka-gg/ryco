import {
  USER_ACTION_DECLINE_LABEL,
  USER_ACTION_DONE_LABEL,
} from "@ryco/client-runtime/userActionRequests";
import type { NodeBrowserTab } from "@ryco/contracts/node-browser";
import { useMemo } from "react";

import { NodeBrowserSurface } from "../../browser/NodeBrowserSurface";
import type { NodeBrowserViewerClient } from "../../browser/useBrowserMode";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogPopup, DialogTitle } from "../ui/dialog";

/**
 * A desktop tab an agent handed to the user (a user action request with `remoteView`), viewed and
 * driven from this browser: the node streams it under `userActionRemoteViewTabId` through the
 * handed-off tab's frame socket, and takes clicks and keys for it. The tab stays the desktop's:
 * no history, reload or resize. Done and Won't do answer the request as the card's do; the card
 * unmounts (and with it this dialog) once the request is no longer pending.
 */
export function HandoffTabViewer({
  client,
  tabId,
  label,
  onClose,
  locked,
  sending,
  onAnswer,
  error,
}: {
  /** The connection's node-browser client, streaming through the hand-off frame socket. */
  client: NodeBrowserViewerClient;
  tabId: string;
  label: string;
  onClose: () => void;
  locked: boolean;
  sending: "done" | "declined" | null;
  onAnswer: (answer: "done" | "declined") => void;
  /** The card's last answer failure, repeated here since the dialog covers the card. */
  error: string | null;
}) {
  // The surface only reads this tab's id, title and state; the node keeps the rest.
  const tab = useMemo<NodeBrowserTab>(
    () => ({
      id: tabId,
      scope: "",
      url: "",
      title: label,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      state: "live",
      viewport: null,
      dialog: null,
      error: null,
    }),
    [label, tabId],
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup
        bottomStickOnMobile={false}
        className="h-[min(85vh,56rem)] max-w-[min(96vw,80rem)]"
      >
        <div className="flex items-center px-4 py-3 pe-12">
          <DialogTitle className="truncate text-base">{label}</DialogTitle>
        </div>
        <div className="flex min-h-0 flex-1 flex-col border-y border-border">
          <NodeBrowserSurface client={client} tab={tab} handoff />
        </div>
        <DialogFooter variant="bare" className="items-center pt-3 pb-4">
          {error !== null ? (
            <p role="alert" className="me-auto text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button variant="ghost" disabled={locked} onClick={() => onAnswer("declined")}>
            {sending === "declined" ? "Declining…" : USER_ACTION_DECLINE_LABEL}
          </Button>
          <Button disabled={locked} onClick={() => onAnswer("done")}>
            {sending === "done" ? "Finishing…" : USER_ACTION_DONE_LABEL}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
