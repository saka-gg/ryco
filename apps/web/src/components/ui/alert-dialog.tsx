"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { cn } from "~/lib/utils";
import {
  DIALOG_MORPH_POPUP_CLASS_NAME,
  DIALOG_MORPH_PROFILE,
  type SurfaceMorphProp,
  useSurfaceMorphRef,
} from "./surfaceMorph";

const AlertDialogCreateHandle = AlertDialogPrimitive.createHandle;

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogBackdrop({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 transition-all duration-[240ms] data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="alert-dialog-backdrop"
      {...props}
    />
  );
}

function AlertDialogViewport({ className, ...props }: AlertDialogPrimitive.Viewport.Props) {
  return (
    <AlertDialogPrimitive.Viewport
      className={cn(
        // Pads by the keyboard inset published by the visual-viewport adapter,
        // matching `ui/sheet.tsx` and `ui/dialog.tsx`, so action rows stay
        // above an open software keyboard; the variable is unset (0) otherwise.
        // The scrim follows the open state, not the mount (see `ui/dialog.tsx`).
        "app-dialog-viewport-scrim pointer-events-auto fixed inset-0 z-50 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4 pb-[calc(--spacing(4)+var(--app-keyboard-inset,0px))] transition-[background-color] duration-(--app-motion-duration-pop) ease-(--app-motion-ease) data-ending-style:bg-transparent data-starting-style:bg-transparent",
        className,
      )}
      data-slot="alert-dialog-viewport"
      {...props}
    />
  );
}

function AlertDialogPopup({
  className,
  onKeyDown,
  bottomStickOnMobile = true,
  morph = "auto",
  ref,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  bottomStickOnMobile?: boolean;
  /**
   * Grow out of (and fold back into) a control; see `surfaceMorph.ts`.
   * Confirmations default to `"auto"`: they grow out of the button that asked
   * for them (a Delete button, a menu item) without each caller wiring a ref.
   */
  morph?: SurfaceMorphProp;
}) {
  const popupRef = useSurfaceMorphRef(morph, ref, { profile: DIALOG_MORPH_PROFILE });
  return (
    <AlertDialogPortal>
      <AlertDialogBackdrop />
      <AlertDialogViewport
        className={cn(
          bottomStickOnMobile &&
            "phone:grid-rows-[1fr_auto] phone:p-0 phone:pt-12 phone:pb-[var(--app-keyboard-inset,0px)]",
        )}
      >
        <AlertDialogPrimitive.Popup
          className={cn(
            "app-surface pointer-events-auto -translate-y-[calc(1.25rem*var(--nested-dialogs))] relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-[min(var(--radius-2xl),1.25rem)] border not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg/5 transition-[scale,opacity,translate] duration-[240ms] ease-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(min(var(--radius-2xl),1.25rem)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:translate-y-2 data-starting-style:translate-y-3 data-ending-style:scale-97 data-starting-style:scale-96 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            bottomStickOnMobile &&
              "phone:max-w-none phone:rounded-none phone:border-x-0 phone:border-t phone:border-b-0 phone:opacity-[calc(1-min(var(--nested-dialogs),1))] phone:data-ending-style:translate-y-4 phone:data-starting-style:translate-y-4 phone:before:hidden phone:before:rounded-none",
            morph && DIALOG_MORPH_POPUP_CLASS_NAME,
            className,
          )}
          data-slot="alert-dialog-popup"
          ref={popupRef}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            event.stopPropagation();
          }}
          {...props}
        />
      </AlertDialogViewport>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left", className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

function AlertDialogFooter({
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
        variant === "bare" && "pb-6",
        className,
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("font-heading font-semibold text-xl leading-none", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

function AlertDialogClose(props: AlertDialogPrimitive.Close.Props) {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

export {
  AlertDialogCreateHandle,
  AlertDialog,
  AlertDialogPortal,
  AlertDialogBackdrop,
  AlertDialogBackdrop as AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogPopup,
  AlertDialogPopup as AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogClose,
  AlertDialogViewport,
};
