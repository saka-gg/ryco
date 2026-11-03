import { EDIT_FROM_HERE_COPY } from "@ryco/client-runtime/state/session";
import { CopyIcon, Undo2Icon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { MobileListRow } from "../mobile/MobileListRow";
import {
  MobileSheet,
  MobileSheetDescription,
  MobileSheetHeader,
  MobileSheetPanel,
  MobileSheetTitle,
} from "../mobile/MobileSheet";

export interface MessageActionsSheetTarget {
  readonly role: "user" | "assistant";
  readonly copyText: string | null;
  readonly canRevert: boolean;
}

/**
 * Phone bottom-sheet for message actions opened by long-pressing a message.
 * Mirrors the hover-revealed desktop row exactly: copy (user), copy response
 * (assistant), and Edit from here (user, when a checkpoint exists) — all
 * dispatched through the same handlers the desktop buttons use.
 */
export function MessageActionsSheet({
  target,
  onOpenChange,
  revertDisabled,
  onRevert,
}: {
  readonly target: MessageActionsSheetTarget | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly revertDisabled: boolean;
  readonly onRevert: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Copied to clipboard" });
    },
    onError: (error: Error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy",
          description: error.message,
        }),
      );
    },
  });

  return (
    <MobileSheet open={target !== null} onOpenChange={onOpenChange} label="Message actions">
      <MobileSheetHeader>
        <MobileSheetTitle>Message actions</MobileSheetTitle>
        <MobileSheetDescription className="sr-only">
          Actions for the selected message
        </MobileSheetDescription>
      </MobileSheetHeader>
      <MobileSheetPanel>
        <div role="group" aria-label="Message actions" className="space-y-0.5">
          {target?.copyText ? (
            <MobileListRow
              label={target.role === "assistant" ? "Copy response" : "Copy message"}
              icon={<CopyIcon aria-hidden className="size-4 shrink-0" />}
              onClick={() => {
                onOpenChange(false);
                copyToClipboard(target.copyText ?? "");
              }}
            />
          ) : null}
          {target?.role === "user" && target.canRevert ? (
            <MobileListRow
              label={EDIT_FROM_HERE_COPY.action}
              icon={<Undo2Icon aria-hidden className="size-4 shrink-0" />}
              disabled={revertDisabled}
              disabledReason="Reverting is unavailable while the session is busy."
              onClick={() => {
                onOpenChange(false);
                onRevert();
              }}
            />
          ) : null}
        </div>
      </MobileSheetPanel>
    </MobileSheet>
  );
}
