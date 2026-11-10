/**
 * The toast managers and their payload type, apart from the toast UI
 * (`toast.tsx`). Modules on the boot path raise toasts through these, so
 * importing them must not pull the capsule's rendering into the boot bundle.
 */
import { Toast } from "@base-ui/react/toast";
import type { ScopedThreadRef, ThreadId } from "@ryco/contracts";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type ThreadToastData = {
  threadRef?: ScopedThreadRef | null;
  threadId?: ThreadId | null;
  leadingIcon?: ReactNode;
  tooltipStyle?: boolean;
  onClose?: (() => void) | undefined;
  dismissAfterVisibleMs?: number;
  /**
   * A notice that can wait (an update is available, say): it stays out of
   * sight while a modal dialog or a picker popup is open, rather than covering
   * it, and shows once none is. Leave it off for errors and for news about
   * what the user just did. Time it with `dismissAfterVisibleMs`, not
   * `timeout`, so it does not run out while it waits.
   */
  deferWhileOverlayOpen?: boolean;
  hideCopyButton?: boolean;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  secondaryActionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
  /** Optional extra body shown after toggling “Show details” (e.g. a list of pending RPCs). */
  expandableContent?: ReactNode;
  expandableLabels?: { expand?: string; collapse?: string };
  /** When set with `expandableContent`, the summary + label act as one text disclosure (no separate chevron row). */
  expandableDescriptionTrigger?: boolean;
  actionLayout?: "inline" | "stacked-end";
  actionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
};

export const toastManager = Toast.createToastManager<ThreadToastData>();
export const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
export type ToastId = ReturnType<typeof toastManager.add>;
