// The confirmation that stands between a click on a row of near-identical nodes
// and an irreversible Hub-side revocation.
//
// It holds no copy and makes no decision of its own — every sentence, the
// failure mapping, and whether a failure leaves anything worth retrying come
// from `@ryco/client-runtime/machineAccess/hostedNodeRevoke`, so they stay reachable by the node suite's
// prohibited-phrase scan. What lives here is only the shape: the node it names,
// the busy states, and where the error goes when the mutation is refused. The
// mutation itself, and the reason code it carries, belong to the directory.

import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { HostedHubNode } from "../../hostedHub/types";
import { Button } from "../ui/button";
import { DataList, DataListItem } from "../ui/data-list";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  hostedNodeRevokeConfirmation,
  hostedNodeRevokeFailure,
  hostedNodeRevokeRetryable,
  type HostedNodeRevokeFailure,
} from "@ryco/client-runtime/machineAccess/hostedNodeRevoke";
import { platformLabel } from "./HostedNodeDisplay.logic";

export function HostedNodeRevokeDialog({
  node,
  open,
  onOpenChange,
  onRevoke,
}: {
  readonly node: HostedHubNode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Performs the revocation and resolves once the Hub has confirmed it.
   *
   * It must NOT resolve optimistically. The row is removed by the directory
   * re-reading itself after this settles, so a promise that resolves before the
   * Hub answered would take the row away and put it back — and a row that
   * vanishes and returns is a worse report than a spinner that stayed.
   */
  readonly onRevoke: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<HostedNodeRevokeFailure | null>(null);
  const confirmation = hostedNodeRevokeConfirmation(node);
  const retryable = hostedNodeRevokeRetryable(failure);

  // Guarded on `!pending` as well as on `open`. Without it a reopen while a
  // request is still in flight resets `pending` to false, which both un-greys
  // the confirm button and disarms the `if (pending) return` guard below — a
  // second POST for the same node out of one owner's two clicks.
  useEffect(() => {
    if (!open || pending) return;
    setPending(false);
    setFailure(null);
    // `pending` is deliberately absent from the deps: this resets a FRESH
    // confirmation, and re-running it as `pending` falls back to false at the
    // end of a failed submit would wipe the failure that submit just reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, open]);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onRevoke();
      onOpenChange(false);
    } catch (cause) {
      // The dialog stays up and keeps naming the node. Closing it on failure
      // would leave the owner looking at a list that still has the row, with the
      // only account of what happened already dismissed.
      setFailure(hostedNodeRevokeFailure(cause));
      setPending(false);
    }
  };

  return (
    // Not dismissible while the request is in flight, by any route. The busy
    // intent was already expressed twice — `showCloseButton={!pending}` and a
    // disabled Cancel — but neither reaches Base UI's Escape handling or its
    // backdrop, whose defaults are both "dismiss". An Escape mid-flight closed
    // the dialog while the POST continued, so a 403 or 429 landed on a component
    // nobody could see: no account whatsoever of a refused irreversible action,
    // and a row that just stayed — identical to having cancelled.
    //
    // The `onOpenChange` guard is what holds it, and it holds for every reason
    // Base UI can close on — `escapeKey`, `outsidePress`, `focusOut` — because
    // `open` is controlled from here and a change this never forwards never
    // happens. `disablePointerDismissal` is the matching declaration on the
    // backdrop, so the press is not attempted in the first place. The detail
    // sheet underneath carries its own half of this: it is a sibling Base UI
    // root, so one Escape reached both.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
      disablePointerDismissal={pending}
    >
      <DialogPopup className="max-w-md" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{confirmation.title}</DialogTitle>
          <DialogDescription>{confirmation.subjectPrompt}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {/* The identifier the label cannot supply, in the same mono treatment
              the detail sheet's own "Node ID" row uses — the value an owner
              would be comparing against is rendered the same way in both. It
              comes off the confirmation rather than off `node` again, so the one
              value that tells two identically-named machines apart is something
              the node suite can assert on. */}
          <DataList>
            <DataListItem term="Node">{node.label}</DataListItem>
            <DataListItem term="Node ID" mono>
              {confirmation.subjectId}
            </DataListItem>
            <DataListItem term="Platform">
              {`${platformLabel(node.platformOs)} · ${node.platformArch}`}
            </DataListItem>
          </DataList>
          <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            {confirmation.consequences.map((consequence) => (
              <li key={consequence.id}>{consequence.text}</li>
            ))}
          </ul>
          {failure ? (
            <p
              role="alert"
              className="flex items-start gap-2 text-xs leading-relaxed text-destructive"
            >
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {failure.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {/* The escape stops saying "Cancel" once there is nothing left to
              cancel: after an outcome this surface could not read, or a node the
              Hub no longer has, "Cancel" reads as an offer to undo. */}
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {retryable ? confirmation.cancelLabel : confirmation.dismissLabel}
          </Button>
          {/* Withdrawn rather than disabled. A greyed destructive button leaves
              the owner looking for the state that re-enables it, and there is
              none — the answer to both of these is in the list behind this. */}
          {retryable ? (
            <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
              {pending ? confirmation.pendingLabel : confirmation.confirmLabel}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
