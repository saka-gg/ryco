"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  DIALOG_MORPH_POPUP_CLASS_NAME,
  DIALOG_MORPH_PROFILE,
  type SurfaceMorphProp,
  useSurfaceMorphRef,
} from "./surfaceMorph";

const DialogCreateHandle = DialogPrimitive.createHandle;

const Dialog = DialogPrimitive.Root;

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 transition-all duration-(--app-motion-duration-pop) data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        // The scrim follows the dialog's open state, not its mount: it fades
        // in as the dialog starts opening and out as soon as it starts
        // closing, even while a morphing popup keeps the viewport mounted.
        "app-dialog-viewport-scrim pointer-events-auto fixed inset-0 z-50 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4 transition-[background-color] duration-(--app-motion-duration-pop) ease-(--app-motion-ease) data-ending-style:bg-transparent data-starting-style:bg-transparent",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  onKeyDown,
  showCloseButton = true,
  bottomStickOnMobile = true,
  surface = "default",
  morph = "auto",
  ref,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  surface?: "default" | "glass";
  /**
   * Grow out of (and fold back into) a control; see `surfaceMorph.ts`.
   * Defaults to `"auto"`: a dialog grows out of whatever opened it (a button,
   * a menu item, a list row) and simply fades when nothing just did (a prompt
   * raised by the app). Pass anchors to land somewhere specific, or `false`.
   */
  morph?: SurfaceMorphProp;
}) {
  const popupRef = useSurfaceMorphRef(morph, ref, { profile: DIALOG_MORPH_PROFILE });
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogViewport
        className={cn(
          surface === "glass" && "bg-transparent dark:bg-transparent",
          // Bottom-stuck phone-tier dialogs pad by the keyboard inset
          // published by the visual-viewport adapter so their action rows stay
          // above an open software keyboard; the variable is unset (0)
          // otherwise.
          bottomStickOnMobile &&
            "phone:grid-rows-[1fr_auto] phone:p-0 phone:pt-12 phone:pb-[var(--app-keyboard-inset,0px)]",
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            "pointer-events-auto -translate-y-[calc(1.25rem*var(--nested-dialogs))] relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-[min(var(--radius-2xl),1.25rem)] border text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] transition-[scale,opacity,translate] duration-(--app-motion-duration-pop) ease-(--app-motion-spring-gentle) will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:translate-y-2 data-starting-style:translate-y-3 data-ending-style:scale-97 data-starting-style:scale-96 data-ending-style:opacity-0 data-starting-style:opacity-0",
            surface === "glass"
              ? "selection-glass-surface"
              : "app-surface not-dark:bg-clip-padding shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(min(var(--radius-2xl),1.25rem)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            bottomStickOnMobile &&
              "phone:max-w-none phone:rounded-none phone:border-x-0 phone:border-t phone:border-b-0 phone:opacity-[calc(1-min(var(--nested-dialogs),1))] phone:data-ending-style:translate-y-4 phone:data-starting-style:translate-y-4 phone:before:hidden phone:before:rounded-none",
            morph && DIALOG_MORPH_POPUP_CLASS_NAME,
            className,
          )}
          data-slot="dialog-popup"
          ref={popupRef}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            event.stopPropagation();
          }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2 z-20"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(min(var(--radius-2xl),1.25rem)-1px)]",
        variant === "default" && "app-muted-surface border-t py-4",
        variant === "bare" &&
          "in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pt-3 pt-4 pb-6",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("font-heading font-semibold text-xl leading-none", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollFade = true,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  DialogCreateHandle,
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
